//! 会话与消息（M3 专家团隔离内核）：
//! 会话隔离是架构约束（规格 4.1）：任何调用方必须持与会话绑定的 roleId 才能读写历史，
//! 跨角色读历史在 sidecar 层 100% 拒绝（7002 + isolation violation）。
use rusqlite::Connection;
use serde_json::{json, Value};

use super::now_ms;
use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

fn open_conn(state: &AppState) -> Result<Connection, String> {
    let db_dir = state.app_data_dir.join("db");
    let _ = std::fs::create_dir_all(&db_dir);
    let conn = Connection::open(db_dir.join("codara.db")).map_err(|e| e.to_string())?;
    // 防御性建表：schema 权威来源是 db.migrate；此处仅保证独立调用不因缺表崩溃
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            role TEXT,
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
            created_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn gen_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{}-{}-{:x}-{:x}", prefix, std::process::id(), ns, n)
}

/// 校验调用方 roleId 与会话绑定角色一致；返回会话元组 (kind, role)
fn assert_role(conn: &Connection, session_id: &str, role_id: &str) -> Result<(String, Option<String>), Envelope> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT kind, role FROM sessions WHERE id = ?1",
            rusqlite::params![session_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| Envelope::err(error::DB_ERROR, format!("session lookup failed: {}", e)))?;

    let (kind, role) = match row {
        Some(x) => x,
        None => return Err(Envelope::err(error::DB_ERROR, "session not found")),
    };
    // 主对话（kind=main，role 为空）只接受 roleId="main"；专家团会话只接受绑定角色
    let bound = role.clone().unwrap_or_else(|| "main".to_string());
    if bound != role_id {
        return Err(Envelope::err(
            error::DB_ERROR,
            format!(
                "session isolation violation: session `{}` is bound to role `{}`, caller is `{}`",
                session_id, bound, role_id
            ),
        ));
    }
    Ok((kind, role))
}

pub fn session_create(state: &mut AppState, params: Value) -> Envelope {
    let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("main").to_string();
    if kind != "main" && kind != "crew" {
        return Envelope::err(error::INVALID_PARAMS, "kind must be main|crew");
    }
    let role = params.get("role").and_then(|v| v.as_str()).map(String::from);
    let task_id = params.get("taskId").and_then(|v| v.as_str()).map(String::from);
    let title = params.get("title").and_then(|v| v.as_str()).map(String::from);

    if kind == "crew" && role.is_none() {
        return Envelope::err(error::INVALID_PARAMS, "crew session requires role");
    }
    let id = gen_id("sess");
    let conn = match open_conn(state) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e),
    };
    match conn.execute(
        "INSERT INTO sessions (id, kind, role, task_id, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, kind, role, task_id, title, now_ms()],
    ) {
        Ok(_) => Envelope::ok(json!({ "sessionId": id, "kind": kind, "role": role })),
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

/// 重命名会话标题（首条用户消息回填，左栏可辨识）。
/// 新建时只能拿到「对话 <时间>」这类无信息量标题，等首条消息到达后再回填。
pub fn session_rename(state: &mut AppState, params: Value) -> Envelope {
    let session_id = match params.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "sessionId is required"),
    };
    let title = match params.get("title").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return Envelope::err(error::INVALID_PARAMS, "title is required"),
    };
    let conn = match open_conn(state) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e),
    };
    match conn.execute(
        "UPDATE sessions SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, session_id],
    ) {
        Ok(n) if n > 0 => Envelope::ok(json!({ "renamed": true })),
        Ok(_) => Envelope::err(error::DB_ERROR, "session not found"),
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

pub fn msg_append(state: &mut AppState, params: Value) -> Envelope {
    let session_id = match params.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "sessionId is required"),
    };
    let role_id = match params.get("roleId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "roleId is required"),
    };
    let role = match params.get("role").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "role (user|assistant|tool|system) is required"),
    };
    // 字符串参数必须用 as_str() 取原文。此前用 Value::to_string() 是序列化语义：
    // 传入的字符串会被再包一层引号并转义（双重编码），导致 msg.list 恢复历史时
    // tool_calls 解析不出数组 → assistant 工具行被过滤 → 孤立 tool 消息 →
    // 之后每一轮 /chat/completions 都被 OpenAI 兼容接口 400 拒绝（工具调用全灭）。
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .map(String::from);
    let tool_calls = params
        .get("toolCalls")
        .and_then(|v| v.as_str())
        .map(String::from);
    let tool_call_id = params.get("toolCallId").and_then(|v| v.as_str()).map(String::from);
    let up = params.get("usagePrompt").and_then(|v| v.as_i64()).unwrap_or(0);
    let uc = params.get("usageCompletion").and_then(|v| v.as_i64()).unwrap_or(0);

    let conn = match open_conn(state) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e),
    };
    if let Err(e) = assert_role(&conn, &session_id, &role_id) {
        return e;
    }
    match conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, usage_prompt, usage_completion, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![session_id, role, content, tool_calls, tool_call_id, up, uc, now_ms()],
    ) {
        Ok(_) => Envelope::ok(json!({ "appended": true })),
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

/// 列出会话（左栏对话列表的数据源）。
///
/// 动机：渲染层的会话列表此前是**纯内存**的（`convs.list`），进程一重启就只剩
/// 「主对话」一项，用户以为「对话记录丢了」。会话与消息其实一直好好躺在
/// sidecar 的 sqlite 里，缺的只是**一条把它们读出来的 RPC** ——
/// sidecar 有 sessions 表、有 session.create，却没有 session.list。
///
/// 语义：
///  - 默认只列 `kind='main'` 的会话（专家团 kind='crew' 的实例会话不进左栏对话列表）；
///  - 按 created_at 倒序（最新在前）；`createdAt` 为毫秒时间戳，渲染层据此分组「今天/更早」；
///  - 不做角色隔离断言：会话**列表**不含任何消息内容，只是 (id, title, createdAt) 元信息；
///    真正的隔离在 msg.list / msg.append 上（仍需 roleId），不会被这里绕过。
pub fn session_list(state: &mut AppState, params: Value) -> Envelope {
    let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("main").to_string();
    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(100).max(1).min(500);

    let conn = match open_conn(state) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e),
    };
    let mut stmt = match conn.prepare(
        "SELECT id, title, created_at FROM sessions WHERE kind = ?1 ORDER BY created_at DESC LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(e) => return Envelope::err(error::DB_ERROR, e.to_string()),
    };
    let rows = stmt.query_map(rusqlite::params![kind, limit], |r| {
        Ok(json!({
            "sessionId": r.get::<_, String>(0)?,
            "title": r.get::<_, Option<String>>(1)?,
            "createdAt": r.get::<_, i64>(2)?,
        }))
    });
    match rows {
        Ok(iter) => {
            let items: Vec<Value> = iter.filter_map(|x| x.ok()).collect();
            Envelope::ok(json!({ "sessions": items }))
        }
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}

pub fn msg_list(state: &mut AppState, params: Value) -> Envelope {    let session_id = match params.get("sessionId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "sessionId is required"),
    };
    let role_id = match params.get("roleId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "roleId is required"),
    };
    let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(200).max(1).min(2000);

    let conn = match open_conn(state) {
        Ok(c) => c,
        Err(e) => return Envelope::err(error::DB_ERROR, e),
    };
    if let Err(e) = assert_role(&conn, &session_id, &role_id) {
        return e;
    }
    let mut stmt = match conn.prepare(
        "SELECT id, role, content, tool_calls, tool_call_id, usage_prompt, usage_completion, created_at
         FROM messages WHERE session_id = ?1 ORDER BY id ASC LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(e) => return Envelope::err(error::DB_ERROR, e.to_string()),
    };
    let rows = stmt.query_map(rusqlite::params![session_id, limit], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "role": r.get::<_, String>(1)?,
            "content": r.get::<_, Option<String>>(2)?,
            "toolCalls": r.get::<_, Option<String>>(3)?,
            "toolCallId": r.get::<_, Option<String>>(4)?,
            "usagePrompt": r.get::<_, i64>(5)?,
            "usageCompletion": r.get::<_, i64>(6)?,
            "createdAt": r.get::<_, i64>(7)?,
        }))
    });
    match rows {
        Ok(iter) => {
            let items: Vec<Value> = iter.filter_map(|x| x.ok()).collect();
            Envelope::ok(json!({ "messages": items }))
        }
        Err(e) => Envelope::err(error::DB_ERROR, e.to_string()),
    }
}