//! 代码索引（M5）：SQLite 全文索引 + tree-sitter 符号表。
//! 架构约束（ADR-02/07/08）：索引热点全部下沉 sidecar；
//! 增量分片 tick、可限速可暂停、禁止启动全量扫描（规格 3.7/5.2）。
pub mod lang;
pub mod parse;
pub mod rank;
pub mod walk;

#[cfg(test)]
mod parse_test;

#[cfg(test)]
mod rank_test;

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

/// 单 tick 内容处理上限（限速：electron 可调，spec 默认 ≤500）
pub const TICK_MAX_FILES: usize = 500;
/// 单文件索引进场体积上限（超限只记元数据不进全文）
pub const MAX_INDEX_BYTES: u64 = 512 * 1024;
/// 单文件最大词条数（治理：防止异常文件撑爆索引库）
pub const MAX_TERMS_PER_FILE: usize = 4096;

pub struct QueuedFile {
    pub path: String,
    pub size: u64,
}

pub struct IndexState {
    pub conn: Connection,
    pub ws_hash: String,
    /// 待处理（变更）文件队列：build 首个 tick 填充，后续 tick 消费
    pub queue: Vec<QueuedFile>,
    pub gen: u64,
    pub paused: bool,
    pub semantic_enabled: bool,
}

const INDEX_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS idx_files (
    file_id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS idx_symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    container TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON idx_symbols(name);
CREATE TABLE IF NOT EXISTS idx_terms (
    term TEXT NOT NULL,
    field TEXT NOT NULL,
    file_id INTEGER NOT NULL,
    tf INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terms_term ON idx_terms(term, field);
CREATE TABLE IF NOT EXISTS idx_doclen (
    file_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    len INTEGER NOT NULL,
    PRIMARY KEY (file_id, field)
);
";

pub fn index_dir(state: &AppState) -> PathBuf {
    state.app_data_dir.join("index")
}

fn ws_hash(state: &AppState) -> String {
    use sha2::{Digest, Sha256};
    let root = state.workspace_root.clone().unwrap_or_default();
    let h = Sha256::digest(root.to_string_lossy().as_bytes());
    hex::encode(&h[..8])
}

fn index_db_path(state: &AppState) -> PathBuf {
    index_dir(state).join(format!("{}.db", ws_hash(state)))
}

/// 打开（或创建）索引库；文件不存在时建表
fn open_index_db(state: &AppState) -> Result<IndexState, String> {
    let path = index_db_path(state);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    conn.execute_batch(INDEX_SCHEMA).map_err(|e| e.to_string())?;
    let gen: u64 = conn
        .query_row("SELECT value FROM meta WHERE key='gen'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let semantic_enabled: bool = conn
        .query_row("SELECT value FROM meta WHERE key='semantic_enabled'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .map(|s| s == "1")
        .unwrap_or(false);
    Ok(IndexState {
        conn,
        ws_hash: ws_hash(state),
        queue: Vec::new(),
        gen,
        paused: false,
        semantic_enabled,
    })
}

fn with_index<T>(
    state: &mut AppState,
    f: impl FnOnce(&mut IndexState) -> Result<T, String>,
) -> Result<T, Envelope> {
    let mut guard = state.index.lock().unwrap();
    if guard.is_none() {
        *guard = Some(open_index_db(state).map_err(|e| Envelope::err(error::INTERNAL, e))?);
    }
    f(guard.as_mut().unwrap()).map_err(|e| Envelope::err(error::INTERNAL, e))
}

/// handler 内使用：with_index 出错时直接以错误信封返回
macro_rules! try_index {
    ($state:expr, $f:expr) => {
        match with_index($state, $f) {
            Ok(v) => v,
            Err(e) => return e,
        }
    };
}

// ---------------- index.build（分片 tick） ----------------

pub fn index_build(state: &mut AppState, params: Value) -> Envelope {
    if state.workspace_root.is_none() {
        return Envelope::err(error::INVALID_REQUEST, "workspace not initialized");
    }
    let max_files = params
        .get("maxFiles")
        .and_then(|v| v.as_u64())
        .unwrap_or(TICK_MAX_FILES as u64) as usize;
    let root = state.workspace_root.clone().unwrap();

    // 首个 tick：确保索引库打开；队列空时做一次增量对账（walk + 差异入队）
    let _walk_changed = try_index!(state, |idx| {
        if !idx.queue.is_empty() || idx.paused {
            return Ok(false);
        }
        // 载入库内文件表（path → (file_id, mtime, size)）
        let mut stmt = idx
            .conn
            .prepare("SELECT file_id, path, mtime, size FROM idx_files")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        let mut known: HashMap<String, (i64, i64, i64)> = HashMap::new();
        for (fid, p, m, s) in rows {
            known.insert(p, (fid, m, s));
        }

        // walk 全量文件清单（仅元数据）
        let files = walk::collect(&root);
        let mut removed: Vec<i64> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut queue = Vec::new();
        for (rel, mtime, size) in &files {
            seen.insert(rel.clone());
            match known.get(rel) {
                Some((fid, m, s)) => {
                    if *m != *mtime || *s != *size as i64 {
                        queue.push(QueuedFile { path: rel.clone(), size: *size });
                        let _ = fid; // 处理时按 file_id 覆盖
                    }
                }
                None => queue.push(QueuedFile { path: rel.clone(), size: *size }),
            }
        }
        // 库内有而磁盘没有 → 删除（含符号/词条级联）
        for (p, (fid, _, _)) in &known {
            if !seen.contains(p) {
                removed.push(*fid);
            }
        }
        for fid in removed {
            let _ = idx.conn.execute("DELETE FROM idx_files WHERE file_id=?1", [fid]);
            let _ = idx.conn.execute("DELETE FROM idx_terms WHERE file_id=?1", [fid]);
            let _ = idx.conn.execute("DELETE FROM idx_doclen WHERE file_id=?1", [fid]);
            let _ = idx.conn.execute("DELETE FROM idx_symbols WHERE file_id=?1", [fid]);
        }
        idx.queue = queue;
        Ok(true)
    });

    // 暂停态：不消费队列
    let paused = state.index.lock().unwrap().as_ref().map(|i| i.paused).unwrap_or(false);
    if paused {
        let (pending, gen) = state
            .index
            .lock()
            .unwrap()
            .as_ref()
            .map(|i| (i.queue.len(), i.gen))
            .unwrap_or((0, 0));
        return Envelope::ok(json!({
            "paused": true, "scanned": 0, "pending": pending, "done": false, "gen": gen,
            "cacheRef": format!("idx:{}:{}", ws_hash(state), gen),
        }));
    }

    // 消费队列：最多 max_files 个文件
    let root_for_proc = root.clone();
    let (scanned, done, gen) = try_index!(state, |idx| {
        let mut processed = 0usize;
        while processed < max_files {
            let Some(item) = idx.queue.pop() else { break };
            process_file(idx, &root_for_proc, &item.path);
            processed += 1;
        }
        let done = idx.queue.is_empty();
        if done {
            idx.gen += 1;
            let _ = idx.conn.execute(
                "INSERT INTO meta (key, value) VALUES ('gen', ?1) ON CONFLICT(key) DO UPDATE SET value=?1",
                [idx.gen.to_string()],
            );
        }
        Ok((processed, done, idx.gen))
    });

    let pending = state
        .index
        .lock()
        .unwrap()
        .as_ref()
        .map(|i| i.queue.len())
        .unwrap_or(0);
    Envelope::ok(json!({
        "paused": false, "scanned": scanned, "pending": pending, "done": done, "gen": gen,
        "cacheRef": format!("idx:{}:{}", ws_hash(state), gen),
    }))
}

/// 处理单文件：读内容 → 分词建全文索引（符号提取由 parse 模块叠加）
fn process_file(idx: &mut IndexState, root: &std::path::Path, rel: &str) {
    let abs = root.join(rel);
    let Ok(meta) = std::fs::metadata(&abs) else { return };
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if size > MAX_INDEX_BYTES {
        // 超限：只登记元数据，不进全文
        upsert_file_row(idx, rel, mtime, size, "meta-only", lang::detect(rel));
        return;
    }
    let Ok(bytes) = std::fs::read(&abs) else { return };
    // 二进制检测：前 8KB 含 NUL → 只记元数据
    let head_len = bytes.len().min(8192);
    if bytes[..head_len].contains(&0u8) {
        upsert_file_row(idx, rel, mtime, size, "binary", "binary");
        return;
    }
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(&bytes));
    let lang = lang::detect(rel);

    // 内容快速变更检查：hash 相同则仅更新元数据
    let existing: Option<(i64, String)> = idx
        .conn
        .query_row(
            "SELECT file_id, content_hash FROM idx_files WHERE path=?1",
            [rel],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((fid, ref old_hash)) = existing {
        if *old_hash == hash {
            let _ = idx.conn.execute(
                "UPDATE idx_files SET mtime=?1, size=?2 WHERE file_id=?3",
                rusqlite::params![mtime, size, fid],
            );
            return;
        }
    }

    // 全文词条（field=content）
    let text = String::from_utf8_lossy(&bytes);
    let terms = rank::tokenize(&text);
    let file_id = upsert_file_row(idx, rel, mtime, size, &hash, &lang);
    let _ = idx.conn.execute("DELETE FROM idx_terms WHERE file_id=?1 AND field='content'", [file_id]);
    let _ = idx.conn.execute("DELETE FROM idx_doclen WHERE file_id=?1 AND field='content'", [file_id]);
    let mut tf: HashMap<String, usize> = HashMap::new();
    for t in terms {
        if tf.len() >= MAX_TERMS_PER_FILE {
            break;
        }
        *tf.entry(t).or_insert(0) += 1;
    }
    let doclen = tf.values().sum::<usize>() as i64;
    let _ = idx.conn.execute(
        "INSERT OR REPLACE INTO idx_doclen (file_id, field, len) VALUES (?1, 'content', ?2)",
        rusqlite::params![file_id, doclen],
    );
    for (term, count) in &tf {
        let _ = idx.conn.execute(
            "INSERT INTO idx_terms (term, field, file_id, tf) VALUES (?1, 'content', ?2, ?3)",
            rusqlite::params![term, file_id, count],
        );
    }

    // 符号提取（M5：tree-sitter；超纲语言回落行级启发式）
    let _ = idx.conn.execute("DELETE FROM idx_symbols WHERE file_id=?1", [file_id]);
    let symbols = parse::extract(&abs, &lang, &text);
    for s in symbols {
        let _ = idx.conn.execute(
            "INSERT INTO idx_symbols (file_id, kind, name, line_start, line_end, container) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![file_id, s.kind, s.name, s.line_start, s.line_end, s.container],
        );
    }
}

fn upsert_file_row(
    idx: &mut IndexState,
    rel: &str,
    mtime: i64,
    size: u64,
    hash: &str,
    lang: &str,
) -> i64 {
    let _ = idx.conn.execute(
        "INSERT INTO idx_files (path, mtime, size, content_hash, lang) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET mtime=?2, size=?3, content_hash=?4, lang=?5",
        rusqlite::params![rel, mtime, size, hash, lang],
    );
    idx.conn
        .query_row("SELECT file_id FROM idx_files WHERE path=?1", [rel], |r| r.get(0))
        .unwrap_or(0)
}

// ---------------- index.status / pause / resume / configure ----------------

pub fn index_status(state: &mut AppState, _params: Value) -> Envelope {
    let opt = state.index.lock().unwrap();
    match opt.as_ref() {
        Some(idx) => {
            let files: i64 = idx
                .conn
                .query_row("SELECT COUNT(*) FROM idx_files", [], |r| r.get(0))
                .unwrap_or(0);
            let symbols: i64 = idx
                .conn
                .query_row("SELECT COUNT(*) FROM idx_symbols", [], |r| r.get(0))
                .unwrap_or(0);
            let terms: i64 = idx
                .conn
                .query_row("SELECT COUNT(*) FROM idx_terms", [], |r| r.get(0))
                .unwrap_or(0);
            Envelope::ok(json!({
                "initialized": true, "files": files, "symbols": symbols, "terms": terms,
                "pending": idx.queue.len(), "gen": idx.gen, "paused": idx.paused,
                "semanticEnabled": idx.semantic_enabled, "wsHash": idx.ws_hash,
            }))
        }
        None => Envelope::ok(json!({
            "initialized": false, "files": 0, "symbols": 0, "terms": 0,
            "pending": 0, "gen": 0, "paused": false, "semanticEnabled": false,
        })),
    }
}

pub fn index_pause(state: &mut AppState, _params: Value) -> Envelope {
    try_index!(state, |idx| {
        idx.paused = true;
        Ok(())
    });
    Envelope::ok(json!({ "paused": true }))
}

pub fn index_resume(state: &mut AppState, _params: Value) -> Envelope {
    try_index!(state, |idx| {
        idx.paused = false;
        Ok(())
    });
    Envelope::ok(json!({ "paused": false }))
}

/// index.configure { semantic?: bool }：轻量语义检索开关（默认关，规格 5.4）
pub fn index_configure(state: &mut AppState, params: Value) -> Envelope {
    let semantic = params.get("semantic").and_then(|v| v.as_bool());
    let enabled = try_index!(state, |idx| {
        if let Some(on) = semantic {
            idx.semantic_enabled = on;
            let _ = idx.conn.execute(
                "INSERT INTO meta (key, value) VALUES ('semantic_enabled', ?1)
                 ON CONFLICT(key) DO UPDATE SET value=?1",
                [if on { "1".to_string() } else { "0".to_string() }],
            );
        }
        Ok(idx.semantic_enabled)
    });
    Envelope::ok(json!({ "semanticEnabled": enabled }))
}

// ---------------- index.symbols ----------------

/// index.symbols { name, kind?, exact?, limit? }：定义/大纲查询。
/// 索引为空时降级快路径（仅文件名匹配，<1s 口径）。
pub fn index_symbols(state: &mut AppState, params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => return Envelope::err(error::INVALID_PARAMS, "name is required"),
    };
    let kind = params.get("kind").and_then(|v| v.as_str()).map(|s| s.to_string());
    let exact = params.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize;
    let root = match state.workspace_root.clone() {
        Some(r) => r,
        None => return Envelope::err(error::INVALID_REQUEST, "workspace not initialized"),
    };

    Envelope::ok(try_index!(state, |idx| {
        let total_files: i64 = idx
            .conn
            .query_row("SELECT COUNT(*) FROM idx_files", [], |r| r.get(0))
            .unwrap_or(0);
        if total_files == 0 {
            // 快路径：未建库 → 文件名匹配（不读内容）
            let hits = walk::filename_match(&root, &name, limit);
            let total = hits.len();
            return Ok(json!({
                "symbols": hits.into_iter().map(|p| json!({ "path": p, "kind": "file", "name": name, "note": "fast-path (index not built)" })).collect::<Vec<_>>(),
                "total": total, "fastPath": true,
            }));
        }
        let pattern = format!("%{}%", name);
        let mut stmt = idx.conn.prepare(
            "SELECT f.path, s.kind, s.name, s.line_start, s.line_end, s.container
             FROM idx_symbols s JOIN idx_files f ON f.file_id = s.file_id
             WHERE s.name LIKE ?1 AND (?2 IS NULL OR s.kind = ?2)
             ORDER BY CASE WHEN s.name = ?3 THEN 0 WHEN s.name LIKE ?3 || '%' THEN 1 ELSE 2 END, s.name
             LIMIT ?4",
        ).map_err(|e| e.to_string())?;
        let rows: Vec<Value> = stmt
            .query_map(
                rusqlite::params![pattern, kind, name, limit as i64],
                |r| {
                    Ok(json!({
                        "path": r.get::<_, String>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "name": r.get::<_, String>(2)?,
                        "lineStart": r.get::<_, i64>(3)?,
                        "lineEnd": r.get::<_, i64>(4)?,
                        "container": r.get::<_, Option<String>>(5)?,
                    }))
                },
            )
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .filter(|v| {
                if exact {
                    v["name"].as_str().map(|n| n == name).unwrap_or(false)
                } else {
                    true
                }
            })
            .collect();
        Ok(json!({ "symbols": rows, "total": rows.len(), "fastPath": false }))
    }))
}

// ---------------- index.semantic（轻量语义） ----------------

/// index.semantic { query, limit? }：BM25F 全文 + 符号名/路径加权 + 模糊。
/// 默认关（规格 5.4）：未开启返回 8002 SEMANTIC_DISABLED。
pub fn index_semantic(state: &mut AppState, params: Value) -> Envelope {
    let query = match params.get("query").and_then(|v| v.as_str()) {
        Some(q) if !q.trim().is_empty() => q.trim().to_string(),
        _ => return Envelope::err(error::INVALID_PARAMS, "query is required"),
    };
    let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(20).min(100) as usize;
    let enabled = state
        .index
        .lock()
        .unwrap()
        .as_ref()
        .map(|i| i.semantic_enabled)
        .unwrap_or(false);
    if !enabled {
        return Envelope::err_with(
            error::SEMANTIC_DISABLED,
            "semantic index is disabled by default (spec 5.4); enable via index.configure",
            json!({ "how": "index.configure { semantic: true }" }),
        );
    }

    Envelope::ok(try_index!(state, |idx| {
        let qterms = rank::tokenize(&query);
        if qterms.is_empty() {
            return Ok(json!({ "results": [], "total": 0 }));
        }
        // 文档统计
        let n_docs: f64 = idx
            .conn
            .query_row("SELECT COUNT(*) FROM idx_doclen WHERE field='content'", [], |r| r.get(0))
            .unwrap_or(0) as f64;
        let avg_len: f64 = idx
            .conn
            .query_row("SELECT AVG(len) FROM idx_doclen WHERE field='content'", [], |r| r.get(0))
            .unwrap_or(0.0);
        if n_docs == 0.0 {
            return Ok(json!({ "results": [], "total": 0 }));
        }

        // 每个查询词：候选 term（前缀 + 模糊）→ 命中文件聚合 BM25
        let mut scores: HashMap<i64, f64> = HashMap::new();
        for q in &qterms {
            let pattern = format!("{}%", q); // 前缀候选
            let mut stmt = idx
                .conn
                .prepare(
                    "SELECT t.term, t.file_id, t.tf, COALESCE(d.len, 1)
                     FROM idx_terms t
                     LEFT JOIN idx_doclen d ON d.file_id = t.file_id AND d.field = 'content'
                     WHERE t.term LIKE ?1 LIMIT 2000",
                )
                .map_err(|e| e.to_string())?;
            let candidates: Vec<(String, i64, i64, i64)> = stmt
                .query_map([&pattern], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .filter(|(t, _, _, _)| rank::fuzzy_eq(q, t))
                .collect();
            // idf 的 n_match：该查询词（模糊族）命中的去重文件数
            let n_match = candidates
                .iter()
                .map(|(_, fid, _, _)| *fid)
                .collect::<std::collections::HashSet<i64>>()
                .len() as f64;
            for (_, file_id, tf, doclen) in candidates {
                let score = rank::bm25(tf as f64, doclen as f64, avg_len, n_docs, n_match);
                *scores.entry(file_id).or_insert(0.0) += score;
            }
        }

        // BM25F 字段融合（规格 5.4：name×3 / path×2 / content×1）
        // name 字段：符号名分词后与查询词模糊匹配，按 file_id 聚合命中数
        let mut name_hits: HashMap<i64, f64> = HashMap::new();
        {
            let mut stmt = idx
                .conn
                .prepare("SELECT file_id, name FROM idx_symbols")
                .map_err(|e| e.to_string())?;
            let rows: Vec<(i64, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            for (fid, name) in rows {
                let toks = rank::tokenize(&name);
                let hits = qterms
                    .iter()
                    .filter(|q| toks.iter().any(|t| rank::fuzzy_eq(q, t)))
                    .count() as f64;
                if hits > 0.0 {
                    *name_hits.entry(fid).or_insert(0.0) += hits;
                }
            }
        }
        // path 字段：文件路径分词后与查询词模糊匹配（'/'、'.'、'_' 等由 tokenize 切段）
        let mut path_hits: HashMap<i64, f64> = HashMap::new();
        {
            let mut stmt = idx
                .conn
                .prepare("SELECT file_id, path FROM idx_files")
                .map_err(|e| e.to_string())?;
            let rows: Vec<(i64, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            for (fid, path) in rows {
                let toks = rank::tokenize(&path);
                let hits = qterms
                    .iter()
                    .filter(|q| toks.iter().any(|t| rank::fuzzy_eq(q, t)))
                    .count() as f64;
                if hits > 0.0 {
                    *path_hits.entry(fid).or_insert(0.0) += hits;
                }
            }
        }
        // 三字段合并：仅 name/path 命中（content 无命中）的文件也参与排序
        let mut candidates: std::collections::HashSet<i64> = scores.keys().copied().collect();
        candidates.extend(name_hits.keys().copied());
        candidates.extend(path_hits.keys().copied());
        let mut ranked: Vec<(i64, f64)> = candidates
            .into_iter()
            .map(|fid| {
                let content = scores.get(&fid).copied().unwrap_or(0.0);
                let n = name_hits.get(&fid).copied().unwrap_or(0.0);
                let p = path_hits.get(&fid).copied().unwrap_or(0.0);
                (fid, rank::fuse(content, n, p))
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(limit);
        let mut results = Vec::new();
        for (file_id, score) in ranked {
            let (path, lang): (String, String) = idx
                .conn
                .query_row(
                    "SELECT path, lang FROM idx_files WHERE file_id=?1",
                    [file_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap_or_default();
            results.push(json!({ "path": path, "lang": lang, "score": (score * 1000.0).round() / 1000.0 }));
        }
        Ok(json!({ "results": results, "total": results.len() }))
    }))
}
