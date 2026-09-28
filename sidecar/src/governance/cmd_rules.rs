//! 命令校验（gov.validate）。
//!
//! ## 口径（2026-09-28 定稿，由项目方明确指定）
//!
//! **sidecar 不对命令内容做任何限制或改写**：不做违禁词过滤、不做 shell 子集约束、
//! 不做链式命令拦截、不做高危语义识别。模型直接输出终端原始命令，原样执行。
//!
//! 安全职责全部上移到 **Electron 侧的人工审查中间层**（`tools/gateway.ts`）：
//! 高危命令与读写类命令一律提交人工审查，审批通过即放行。审查环节是强制保留的
//! 唯一防线，sidecar 不再做第二道内容过滤 —— 否则会出现
//! 「用户点了批准，命令仍被 sidecar 拒绝」这种审批卡沦为无效交互的现象
//! （历史事故：审批卡显示「已批准」，工具流水里却是 ✗）。
//!
//! 因此本模块**只保留两条工程性保护**，它们不是内容审查，而是防止 RPC 层被撑爆：
//!  1. 空命令  → 不是命令，属缺参，直接拒绝（避免把空串当命令去 spawn 进程）；
//!  2. 长度上限 → 单条命令超过 2000 字符会撑爆 stdio 行分隔帧，属传输层约束。
//!
//! 除这两条外 `validate_command` 恒返回 ok=true，`high_risk` 恒为 false
//! （风险等级由 gateway 的审查策略判定，不再由 sidecar 复判）。
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;

/// 单条命令长度上限（工程约束，非安全策略）：防止超长命令撑爆 RPC 帧。
/// 与 Electron 侧 `TERM_CMD_LIMIT` 保持一致。
pub const CMD_MAX_LEN: usize = 2000;

#[derive(Debug)]
pub struct ValidateResult {
    pub ok: bool,
    pub code: i64,
    pub message: String,
    /// 保留字段以维持信封兼容：sidecar 不再做高危识别，恒为 false。
    pub high_risk: bool,
    pub shell: String,
}

pub fn validate_command(command: &str, _platform: &str) -> ValidateResult {
    let cmd = command.trim();
    if cmd.is_empty() {
        return ValidateResult {
            ok: false,
            code: crate::rpc::error::CMD_REJECTED,
            message: "empty command".into(),
            high_risk: false,
            shell: "cmd".into(),
        };
    }
    if cmd.len() > CMD_MAX_LEN {
        return ValidateResult {
            ok: false,
            code: crate::rpc::error::CMD_OVERFLOW_BLOCKED,
            message: format!("command exceeds {} chars", CMD_MAX_LEN),
            high_risk: false,
            shell: "cmd".into(),
        };
    }
    // 其余一律放行：命令内容不做任何过滤/改写。
    // shell 字段仅作回显（由模型在命令中自行标注所选 shell，此处不做推断）。
    ValidateResult { ok: true, code: 0, message: String::new(), high_risk: false, shell: detect_shell_hint(cmd) }
}

/// 从命令前缀做**只读回显**用的 shell 提示，不影响放行与否。
/// 模型按约定在命令里用括号标注 shell，例如：
///   `(PowerShell) Get-ChildItem -Force`
///   `(CMD) dir /b`
///   `(Bash) ls -la`
/// 若带标注则回显标注，否则按可执行名粗判，纯展示用。
fn detect_shell_hint(cmd: &str) -> String {
    let lower = cmd.to_lowercase();
    if lower.contains("(powershell)") || lower.starts_with("powershell") || lower.starts_with("pwsh") {
        return "powershell".into();
    }
    if lower.contains("(bash)") || lower.starts_with("bash") || lower.starts_with("sh ") {
        return "bash".into();
    }
    if lower.contains("(cmd)") || lower.starts_with("cmd") {
        return "cmd".into();
    }
    "cmd".into()
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
