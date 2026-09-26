//! WAL 式检查点（M4）：每工具调用/状态迁移/补丁落盘写一条；恢复时按 task 加载回放。
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

fn ckpt_dir(state: &AppState, task_id: &str) -> std::path::PathBuf {
    state.tasks_dir().join(task_id).join("checkpoints")
}

/// taskId 会被拼进目录名：不校验即可用 `../../..` 落到任意目录写 .json
/// （rename 是原子覆盖），读侧则能读出用户有权读的任意文件。
fn check_task_id(task_id: &str) -> Result<(), Envelope> {
    if crate::secret::is_safe_name(task_id) {
        Ok(())
    } else {
        Err(Envelope::err(
            crate::rpc::error::INVALID_PARAMS,
            "invalid taskId (allowed: [A-Za-z0-9_.-], no ..)",
        ))
    }
}

pub fn ckpt_write(state: &mut AppState, params: Value) -> Envelope {
    let task_id = match params.get("taskId").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "taskId is required"),
    };
    if let Err(e) = check_task_id(&task_id) {
        return e;
    }
    let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("generic");
    let payload = params.get("payload").cloned().unwrap_or(json!({}));
    let dir = ckpt_dir(state, &task_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return Envelope::err(error::INTERNAL, "cannot create checkpoint dir");
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // WAL：先写临时文件再原子 rename
    let file = dir.join(format!("{:020}-{}.json", now, kind));
    let tmp = dir.join(format!("{:020}-{}.json.tmp", now, kind));
    let body = json!({
        "taskId": task_id,
        "kind": kind,
        "ts": now,
        "payload": payload,
    });
    if std::fs::write(&tmp, body.to_string()).is_err() {
        return Envelope::err(error::INTERNAL, "checkpoint write failed");
    }
    if std::fs::rename(&tmp, &file).is_err() {
        return Envelope::err(error::INTERNAL, "checkpoint rename failed");
    }
    // 序列号文件（快速恢复定位）
    let _ = std::fs::write(
        dir.join("LATEST"),
        file.file_name().unwrap_or_default().to_string_lossy().to_string(),
    );
    Envelope::ok(json!({ "written": true, "file": file.display().to_string() }))
}

pub fn ckpt_list(state: &mut AppState, params: Value) -> Envelope {
    let task_id = match params.get("taskId").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "taskId is required"),
    };
    if let Err(e) = check_task_id(&task_id) {
        return e;
    }
    let dir = ckpt_dir(state, &task_id);
    let mut items = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        files.sort();
        for f in files {
            if f.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(c) = std::fs::read_to_string(&f) {
                    if let Ok(v) = serde_json::from_str::<Value>(&c) {
                        items.push(v);
                    }
                }
            }
        }
    }
    Envelope::ok(json!({ "checkpoints": items }))
}

pub fn ckpt_load(state: &mut AppState, params: Value) -> Envelope {
    let task_id = match params.get("taskId").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "taskId is required"),
    };
    if let Err(e) = check_task_id(&task_id) {
        return e;
    }
    let dir = ckpt_dir(state, &task_id);
    let latest = dir.join("LATEST");
    let name = match std::fs::read_to_string(&latest) {
        Ok(n) => n.trim().to_string(),
        Err(_) => return Envelope::err(error::CHECKPOINT_CORRUPT, "no LATEST marker"),
    };
    // LATEST 的内容由写盘方控制，且磁盘文件可被篡改：
    // 只取文件名部分，必须是 .json，禁止 `..`，否则可读取任意文件。
    let name = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .to_string();
    if name.is_empty() || name.contains("..") || !name.ends_with(".json") {
        return Envelope::err(error::CHECKPOINT_CORRUPT, "bad LATEST marker");
    }
    match std::fs::read_to_string(dir.join(&name)) {
        Ok(c) => match serde_json::from_str::<Value>(&c) {
            Ok(v) => Envelope::ok(v),
            Err(e) => Envelope::err(error::CHECKPOINT_CORRUPT, e.to_string()),
        },
        Err(e) => Envelope::err(error::CHECKPOINT_CORRUPT, e.to_string()),
    }
}
