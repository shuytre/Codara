//! sidecar SQLite（rusqlite bundled）：会话/消息/用量/审计/专家团表。
//! schema 迁移由 sidecar 独占管理（ADR-08：存储归 sidecar）。
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

pub mod sessions;

pub struct Database {
    pub conn: Connection,
}

pub fn open(db_path: &std::path::Path) -> Result<Database, String> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    Ok(Database { conn })
}

const MIGRATIONS: &[&str] = &[
    // v1：M1 基础表
    "CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,             -- main | crew
        role TEXT,                      -- 专家团角色（M3）
        task_id TEXT,
        title TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        usage_prompt INTEGER DEFAULT 0,
        usage_completion INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE TABLE IF NOT EXISTS usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket TEXT NOT NULL,           -- today | task | system
        task_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_cny REAL NOT NULL DEFAULT 0,
        day TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );",
    // v2：M3 专家团表
    "CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'NEW',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_instances (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        worktree TEXT,
        max_turns INTEGER DEFAULT 200,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS task_packets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        instance_id TEXT,
        type TEXT NOT NULL,
        author_role TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        body TEXT NOT NULL,
        refs TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        instance_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_ledger(day);",
];

pub fn db_migrate(state: &mut AppState, _params: Value) -> Envelope {
    let db_dir = state.app_data_dir.join("db");
    let db_path = db_dir.join("codara.db");
    let mut db = match open(&db_path) {
        Ok(d) => d,
        Err(e) => return Envelope::err(error::DB_MIGRATION_FAILED, e),
    };
    // 记录当前版本
    db.conn
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .map_err(|e| e.to_string())
        .ok();
    let current: i64 = db
        .conn
        .query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))
        .unwrap_or(0);

    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let v = (i + 1) as i64;
        if v <= current {
            continue;
        }
        if let Err(e) = db.conn.execute_batch(sql) {
            return Envelope::err(error::DB_MIGRATION_FAILED, format!("migration v{} failed: {}", v, e));
        }
        let now = now_ms();
        let _ = db.conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![v, now],
        );
    }
    *state.db.lock().unwrap() = Some(db);
    Envelope::ok(json!({ "migrated": true, "version": MIGRATIONS.len() }))
}

fn get_db(state: &AppState) -> Option<std::sync::MutexGuard<'_, Database>> {
    // 注意：Database 直接持 Connection；通过全局锁串行访问
    // state.db 存的是 Option<Database>，rusqlite Connection 不是 Sync——
    // 为满足 Rust 语义，这里以函数内构造临时连接的方式规避。
    let _ = state;
    None
}

/// JSON 参数 → rusqlite 参数的正确映射（禁止 Value::to_string()：会给字符串包 JSON 引号）
fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    match v {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else {
                rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

pub fn db_query(state: &mut AppState, params: Value) -> Envelope {
    let sql = match params.get("sql").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "sql is required"),
    };
    let args: Vec<rusqlite::types::Value> = params
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(json_to_sql).collect())
        .unwrap_or_default();
    let db_dir = state.app_data_dir.join("db");
    let conn = match Connection::open(db_dir.join("codara.db")) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e.to_string()),
    };
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return Envelope::err(error::DB_ERROR, e.to_string()),
    };
    let col_count = stmt.column_count();
    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let _ = col_count;
    let mut rows_out: Vec<Value> = Vec::new();
    let iter = stmt.query(rusqlite::params_from_iter(args.iter()));
    match iter {
        Ok(mut rows) => {
            while let Ok(Some(row)) = rows.next() {
                let mut obj = serde_json::Map::new();
                for (i, name) in column_names.iter().enumerate() {
                    let v: Value = match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                        Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                        Ok(rusqlite::types::ValueRef::Text(t)) => json!(String::from_utf8_lossy(t)),
                        Ok(rusqlite::types::ValueRef::Blob(b)) => json!(String::from_utf8_lossy(b)),
                        Err(_) => Value::Null,
                    };
                    obj.insert(name.clone(), v);
                }
                rows_out.push(Value::Object(obj));
            }
            Envelope::ok(json!({ "rows": rows_out }))
        }
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

pub fn db_exec(state: &mut AppState, params: Value) -> Envelope {
    let sql = match params.get("sql").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "sql is required"),
    };
    let args: Vec<rusqlite::types::Value> = params
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(json_to_sql).collect())
        .unwrap_or_default();
    let db_dir = state.app_data_dir.join("db");
    let conn = match Connection::open(db_dir.join("codara.db")) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e.to_string()),
    };
    match conn.execute(&sql, rusqlite::params_from_iter(args.iter())) {
        Ok(n) => Envelope::ok(json!({ "changes": n })),
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 抑制未使用告警：get_db 保留为后续连接池化的演进点
#[allow(dead_code)]
fn _keep_alive(_m: Option<Mutex<Database>>) {}
