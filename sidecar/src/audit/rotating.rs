//! 审计日志：按天轮转、磁盘上限（默认 500MB）、脱敏（不记 Key；代码正文可按开关关闭）。
use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::state::AppState;

pub const MAX_DISK_MB: u64 = 500;
pub const DAY_MS: u128 = 86_400_000;

fn day_string(epoch_ms: u128) -> String {
    let days = epoch_ms / DAY_MS;
    // 简化：以 epoch 天数命名 + UTC 换算
    let mut z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    z = y - if m <= 2 { 1 } else { 0 };
    format!("{:04}{:02}{:02}", z, m, d)
}

pub fn audit_path(app_data: &std::path::Path, epoch_ms: u128) -> PathBuf {
    app_data.join("audit").join(format!("audit-{}.log", day_string(epoch_ms)))
}

pub fn write_audit(app_data: &std::path::Path, event: &Value) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let p = audit_path(app_data, now);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", event);
        return true;
    }
    false
}

/// 脱敏：任何 key/value 中疑似凭据字段替换为 ***
pub fn redact(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let lower = k.to_lowercase();
                if lower.contains("key") || lower.contains("token") || lower.contains("secret") || lower.contains("password") {
                    *val = Value::String("***".into());
                } else {
                    redact(val);
                }
            }
        }
        Value::Array(items) => {
            for i in items {
                redact(i);
            }
        }
        _ => {}
    }
}

pub fn audit_note(state: &mut AppState, params: Value) -> Envelope {
    let mut event = params.clone();
    // 附加时间戳与脱敏
    if let Value::Object(map) = &mut event {
        map.entry("ts".to_string()).or_insert(json!(now_ms_value()));
    }
    redact(&mut event);
    let ok = write_audit(&state.app_data_dir, &event);
    // 磁盘上限守护：超限删除最旧日志
    enforce_disk_limit(&state.app_data_dir.join("audit"));
    Envelope::ok(json!({ "logged": ok }))
}

fn now_ms_value() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn enforce_disk_limit(dir: &std::path::Path) {
    let mut files: Vec<(std::path::PathBuf, u64, u128)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(meta) = e.metadata() {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                files.push((e.path(), meta.len(), modified));
            }
        }
    }
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= MAX_DISK_MB * 1024 * 1024 {
        return;
    }
    files.sort_by_key(|f| f.2);
    let mut remaining = total;
    for (path, size, _) in files {
        if remaining <= MAX_DISK_MB * 1024 * 1024 {
            break;
        }
        let _ = std::fs::remove_file(&path);
        remaining -= size;
    }
}
