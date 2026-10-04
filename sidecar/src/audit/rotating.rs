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
    let z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    // 1/2 月属于上一"历年"，年份要 +1。写成 `-` 会让 1、2 月的日志文件名整体少 2 年
    // （epoch day 0 会输出 1968-01-01，正确值 1970-01-01），跨年轮转与按天检索全乱。
    let z = y + if m <= 2 { 1 } else { 0 };
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

/// 脱敏：键名命中凭据字段替换为 ***；键名未命中时再对**字符串值**做模式匹配，
/// 兜住「凭据出现在值里」的场景 —— 例如模型把密钥写进命令行参数
/// （`--token=sk-xxx`、`api_key="..."`、`Authorization: Bearer xxx`），
/// 或 curl 的 `-H "Authorization: Bearer ..."`。仅按键名脱敏会把这些漏进日志。
pub fn redact(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let lower = k.to_lowercase();
                if lower.contains("key")
                    || lower.contains("token")
                    || lower.contains("secret")
                    || lower.contains("password")
                    || lower.contains("passwd")
                    || lower.contains("credential")
                    || lower.contains("authorization")
                {
                    *val = Value::String("***".into());
                } else {
                    // 键名不像凭据：继续递归，字符串值会走 mask_credentials_in_text
                    redact(val);
                }
            }
        }
        Value::Array(items) => {
            for i in items {
                redact(i);
            }
        }
        Value::String(s) => {
            if let Some(masked) = mask_credentials_in_text(s) {
                *s = masked;
            }
        }
        _ => {}
    }
}

/// 在自由文本中屏蔽常见凭据形态。返回 None 表示无需改动（避免无谓分配）。
///
/// 覆盖两类写法：
///  1. `key<分隔符>value`：`--token=xx`、`api_key: xx`、`password = xx`；
///  2. `前缀 value`：`Bearer xx`、`Basic xx`，以及裸前缀 `sk-` / `ghp_` / `AKIA` 等。
fn mask_credentials_in_text(s: &str) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut last = 0usize;
    let mut changed = false;

    // 全部按小写比对（lower 与 s 逐字节同长，索引通用）
    const NEEDLES: [&str; 20] = [
        "--token", "--api-key", "--apikey", "--password", "--auth",
        "access_token", "refresh_token", "client_secret",
        "api_key", "api-key", "apikey", "password", "passwd",
        "authorization", "bearer", "basic",
        "sk-", "ghp_", "ghu_", "xoxb-",
    ];

    for key in NEEDLES.iter() {
        let mut from = 0usize;
        while let Some(pos) = lower[from..].find(key) {
            let abs = from + pos;
            // 值起点：跳过 key 之后的分隔符（= : 空格 引号）
            let mut i = abs + key.len();
            while i < bytes.len() {
                let c = bytes[i] as char;
                if c == '=' || c == ':' || c == ' ' || c == '"' || c == '\'' {
                    i += 1;
                } else {
                    break;
                }
            }
            // 值终点：遇到空白 / 引号 / 分隔符 / 行尾
            let mut j = i;
            while j < bytes.len() {
                let c = bytes[j] as char;
                if c.is_whitespace() || c == '"' || c == '\'' || c == ';' || c == '&' || c == ')' {
                    break;
                }
                j += 1;
            }
            if j > i && i >= last {
                out.push_str(&s[last..i]);
                out.push_str("***");
                last = j;
                changed = true;
            }
            from = abs + key.len();
        }
    }

    if !changed {
        return None;
    }
    out.push_str(&s[last..]);
    Some(out)
}

pub fn audit_note(state: &AppState, params: Value) -> Envelope {
    let mut event = params.clone();
    // 附加时间戳与脱敏
    if let Value::Object(map) = &mut event {
        map.entry("ts".to_string()).or_insert(json!(now_ms_value()));
    }
    redact(&mut event);
    let ok = write_audit(&state.app_data_dir(), &event);
    // 磁盘上限守护：超限删除最旧日志
    enforce_disk_limit(&state.app_data_dir().join("audit"));
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
#[cfg(test)]
mod tests {
    use super::*;

    /// 审计日志按天轮转的日期换算必须有测试锁定：
    /// 曾经的 `-` 写法会让 1/2 月整体少 2 年（epoch day 0 → 1968-01-01），
    /// 跨年轮转与按天检索会全部错位。
    #[test]
    fn day_string_epoch_zero_is_1970_01_01() {
        assert_eq!(day_string(0), "19700101");
    }

    #[test]
    fn day_string_handles_jan_feb_year_rollback() {
        // 2024-01-01 00:00:00 UTC → 19723 天
        assert_eq!(day_string(19723 * DAY_MS), "20240101");
        // 2024-02-29（闰日）→ 19782 天
        assert_eq!(day_string(19782 * DAY_MS), "20240229");
        // 2023-12-31 → 19722 天（跨年边界：1 月必须归到下一年，不能被减成 2021）
        assert_eq!(day_string(19722 * DAY_MS), "20231231");
    }

    #[test]
    fn day_string_is_stable_within_a_day() {
        let base = 19723 * DAY_MS;
        assert_eq!(day_string(base), day_string(base + DAY_MS - 1));
    }

    /// L4 回归守卫：凭据出现在**值**里也要脱敏（旧实现只看键名，会漏）。
    #[test]
    fn redact_masks_keyed_fields() {
        let mut v = json!({ "apiKey": "sk-abc", "auth_token": "t", "note": "keep" });
        redact(&mut v);
        assert_eq!(v["apiKey"], json!("***"));
        assert_eq!(v["auth_token"], json!("***"));
        assert_eq!(v["note"], json!("keep"));
    }

    #[test]
    fn redact_masks_credentials_embedded_in_values() {
        let mut v = json!({
            "event": "terminal.exec",
            "command": "curl -H \"Authorization: Bearer sk-live-123456\" https://x"
        });
        redact(&mut v);
        let cmd = v["command"].as_str().unwrap();
        assert!(!cmd.contains("sk-live-123456"), "bearer 值未脱敏: {cmd}");
        assert!(cmd.contains("***"));
        // 命令其余部分保持可读，便于审计追责
        assert!(cmd.contains("curl"));
    }

    #[test]
    fn redact_masks_cli_flag_values() {
        let mut v = json!({ "argv": ["deploy", "--token=ghp_abcdef123456", "--region", "cn"] });
        redact(&mut v);
        let joined = v["argv"].to_string();
        assert!(!joined.contains("ghp_abcdef123456"), "CLI 凭据未脱敏: {joined}");
        assert!(joined.contains("cn"), "非凭据参数不该被吞掉");
    }

    #[test]
    fn redact_leaves_plain_text_untouched() {
        let mut v = json!({ "msg": "build finished in 12s" });
        redact(&mut v);
        assert_eq!(v["msg"], json!("build finished in 12s"));
    }
}
