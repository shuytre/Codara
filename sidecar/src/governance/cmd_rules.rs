//! 命令纪律校验（gov.validate）：禁 &&/; 长链、PowerShell 最小子集、危险命令识别。
//! 白名单只是减摩擦层，不是安全边界（ADR-06）：真正的边界是高危审批+快照+审计。
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;

/// 高危命令特征（无条件升级人工审批，M4 沙箱用）
pub const HIGH_RISK_PATTERNS: &[&str] = &[
    "rd ", "rmdir", "del ", "erase ", "format ", "diskpart", "shutdown", "reg add", "reg delete",
    "regedit", "net user", "net localgroup", "icacls", "takeown", "bcdedit", "vssadmin",
    "cipher /w", "attrib -s -h", "schtasks /create", "sc delete", "taskkill /f",
    "rm -rf", "mkfs", "dd if=", "chmod 777", "chown", "> /dev/sd", "kill -9 1",
];

#[derive(Debug)]
pub struct ValidateResult {
    pub ok: bool,
    pub code: i64,
    pub message: String,
    pub high_risk: bool,
    pub shell: String,
}

pub fn validate_command(command: &str, platform: &str) -> ValidateResult {
    let cmd = command.trim();
    if cmd.is_empty() {
        return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: "empty command".into(), high_risk: false, shell: "cmd".into() };
    }
    if cmd.len() > 2000 {
        return ValidateResult { ok: false, code: crate::rpc::error::CMD_OVERFLOW_BLOCKED, message: "command too long".into(), high_risk: false, shell: "cmd".into() };
    }

    // 禁 && 与 ; 长链（允许唯一简单管道 findstr）
    if cmd.contains("&&") || cmd.contains("||") {
        return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: "chained commands (&&/||) are forbidden; run one command at a time".into(), high_risk: false, shell: "cmd".into() };
    }
    for seg in split_semicolons(cmd) {
        if seg.len() != cmd.len() {
            return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: "semicolons chaining is forbidden".into(), high_risk: false, shell: "cmd".into() };
        }
    }

    // PowerShell 检测与最小子集（Windows 语义）
    let is_ps = cmd.starts_with("powershell") || cmd.starts_with("pwsh");
    if platform == "windows" {
        // 禁用 cmdlet：无论是否带 powershell 前缀（管道进 cmdlet 即违反最小子集）
        if let Err(msg) = check_ps_forbidden(cmd) {
            return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: msg, high_risk: false, shell: "powershell".into() };
        }
        // 固定前缀模板校验（规格 3.5.2）：仅对显式 powershell/pwsh 调用
        if is_ps {
            if !cmd.contains("-NoProfile") {
                return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: "PowerShell calls must use -NoProfile -NonInteractive prefix".into(), high_risk: false, shell: "powershell".into() };
            }
            if cmd.len() > 200 && !cmd.contains(".ps1") {
                return ValidateResult { ok: false, code: crate::rpc::error::CMD_REJECTED, message: "PowerShell one-liner >200 chars; write a .ps1 file instead".into(), high_risk: false, shell: "powershell".into() };
            }
        }
    }

    // 高危识别
    let lower = format!(" {} ", cmd.to_lowercase());
    let high_risk = HIGH_RISK_PATTERNS.iter().any(|p| lower.contains(p));

    ValidateResult { ok: true, code: 0, message: String::new(), high_risk, shell: if is_ps { "powershell".into() } else { "cmd".into() } }
}

fn split_semicolons(cmd: &str) -> Vec<String> {
    // 简单处理：去掉引号内分号
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote: Option<char> = None;
    for c in cmd.chars() {
        if in_quote.is_some() && in_quote == Some(c) {
            in_quote = None;
            cur.push(c);
        } else if in_quote.is_none() && (c == '"' || c == '\'') {
            in_quote = Some(c);
            cur.push(c);
        } else if c == ';' && in_quote.is_none() {
            out.push(cur.clone());
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

fn check_ps_forbidden(cmd: &str) -> Result<(), String> {
    const FORBIDDEN: &[&str] = &[
        "format-", "select-object", "where-object", "sort-object", "foreach-object",
        "$_", "gci", "sl ", "% ", "? ", "cat ", "echo $", "get-content -tail", "gc -tail",
    ];
    // 禁用词均为 ASCII，lower 的字节偏移与原文一致（多字节字符处回退用小写词）
    let lower = cmd.to_lowercase();
    for f in FORBIDDEN {
        if let Some(pos) = lower.find(f) {
            let end = pos + f.len();
            let original: &str = if cmd.is_char_boundary(pos) && cmd.is_char_boundary(end) {
                &cmd[pos..end]
            } else {
                f
            };
            return Err(format!(
                "PowerShell minimal subset violation: `{}` is forbidden in a pipeline",
                original.trim_end()
            ));
        }
    }
    Ok(())
}

pub fn gov_validate(params: Value) -> Envelope {
    let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let platform = params.get("platform").and_then(|v| v.as_str()).unwrap_or("windows");
    let r = validate_command(command, platform);
    Envelope::ok(json!({
        "ok": r.ok,
        "highRisk": r.high_risk,
        "shell": r.shell,
        "message": r.message,
    }))
}
