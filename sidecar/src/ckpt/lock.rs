//! 任务锁与心跳（M4）：带 TTL 的时间戳锁；启动时检测过期锁提示恢复/终止。
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

pub const DEFAULT_TTL_MS: u64 = 30_000; // 心跳间隔 10s，TTL 30s

fn lock_path(state: &AppState, name: &str) -> std::path::PathBuf {
    state.tasks_dir().join("locks").join(format!("{}.lock", name.replace('/', "_")))
}

pub fn lock_acquire(state: &mut AppState, params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let ttl = params.get("ttlMs").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_TTL_MS);
    let owner = params.get("owner").and_then(|v| v.as_str()).unwrap_or("default").to_string();
    let p = lock_path(state, &name);

    if p.exists() {
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                let ts = v.get("heartbeat").and_then(|h| h.as_u64()).unwrap_or(0);
                let now = now_ms();
                if now.saturating_sub(ts) < ttl {
                    return Envelope::err_with(
                        error::LOCK_HELD,
                        format!("lock held: {}", name),
                        json!({ "owner": v.get("owner"), "heartbeatAgeMs": now - ts }),
                    );
                }
                // 过期锁：标记 stale，由调用方决定恢复/终止
                return Envelope::err_with(
                    error::LOCK_STALE,
                    format!("stale lock found: {}", name),
                    json!({ "owner": v.get("owner"), "heartbeatAgeMs": now.saturating_sub(ts) }),
                );
            }
        }
    }

    let body = json!({
        "name": name,
        "owner": owner,
        "heartbeat": now_ms(),
        "pid": std::process::id(),
    });
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&p, body.to_string()).is_err() {
        return Envelope::err(error::INTERNAL, "cannot write lock file");
    }
    Envelope::ok(json!({ "acquired": true, "name": name }))
}

pub fn lock_heartbeat(state: &mut AppState, params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let p = lock_path(state, &name);
    if !p.exists() {
        return Envelope::err(error::LOCK_HELD, "lock does not exist");
    }
    if let Ok(mut v) = serde_json::from_str::<Value>(&std::fs::read_to_string(&p).unwrap_or_default()) {
        v["heartbeat"] = json!(now_ms());
        let _ = std::fs::write(&p, v.to_string());
        return Envelope::ok(json!({ "heartbeat": true }));
    }
    Envelope::err(error::INTERNAL, "cannot update lock")
}

pub fn lock_release(state: &mut AppState, params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let p = lock_path(state, &name);
    match std::fs::remove_file(&p) {
        Ok(_) => Envelope::ok(json!({ "released": true })),
        Err(_) => Envelope::err(error::LOCK_HELD, "lock does not exist or cannot be removed"),
    }
}

pub fn lock_inspect(state: &mut AppState, params: Value) -> Envelope {
    // 检查全部锁：返回 held（健康）与 stale（过期）分组
    let dir = state.tasks_dir().join("locks");
    let ttl = params.get("ttlMs").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_TTL_MS);
    let mut held = Vec::new();
    let mut stale = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let now = now_ms();
        for e in rd.flatten() {
            if let Ok(c) = std::fs::read_to_string(e.path()) {
                if let Ok(v) = serde_json::from_str::<Value>(&c) {
                    let ts = v.get("heartbeat").and_then(|h| h.as_u64()).unwrap_or(0);
                    let mut item = v.clone();
                    item["ageMs"] = json!(now.saturating_sub(ts));
                    if now.saturating_sub(ts) < ttl {
                        held.push(item);
                    } else {
                        stale.push(item);
                    }
                }
            }
        }
    }
    Envelope::ok(json!({ "held": held, "stale": stale }))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
