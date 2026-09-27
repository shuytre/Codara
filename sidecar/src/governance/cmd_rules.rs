//! 命令规则：把模型的 shell 指令收敛到「可预测、可审计」的子集。
//!
//! 三条硬约束（平台无关）：
//!   1. 拒绝 `&&` / `||` —— 各 shell 语义不一致，链式结果难预测；
//!   2. 拒绝**引号外**的分号链式 —— 引号内的 `;` 是合法内容（PS 字符串），不算链式；
//!   3. 总长度 > `CMD_OVERFLOW_LIMIT` 直接拒（防注入与日志爆炸）。
//!
//! 历史上这里还有一条「PowerShell 一行式 > 200 字符且不含 `.ps1` 就拒」，已删除：
//! 它拦的是**长度**而非危险性，把 222 字符的 Invoke-WebRequest + try/catch 探测命令
//! 全部误杀，且因为位于 2000 字符溢出判定之后而**永不可达**（死规则）。
//! 需要多步逻辑时，由提示词引导模型落成 .ps1 后 `-File` 执行；规则层不再加码。

use crate::rpc::error;

/// 命令总长度上限：超过即视为溢出，直接拒绝。
pub const CMD_OVERFLOW_LIMIT: usize = 2000;

/// 高危命令片段（小写匹配，调用前会把命令整体小写化）。
pub const HIGH_RISK_PATTERNS: &[&str] = &[
    "rm -rf",
    "del /f",
    "format ",
    "reg add",
    "reg delete",
    "shutdown",
    "git push",
    "npm publish",
    "curl |",
    "iwr ",
    "invoke-webrequest",
    "set-executionpolicy",
    "diskpart",
    "cacls ",
    "icacls ",
    "net user",
    "takeown ",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidateResult {
    pub ok: bool,
    pub code: i64,
    pub message: String,
    pub high_risk: bool,
    pub shell: String,
}

impl ValidateResult {
    fn pass(shell: &str, high_risk: bool) -> Self {
        ValidateResult { ok: true, code: 0, message: String::new(), high_risk, shell: shell.into() }
    }
    fn reject(code: i64, message: &str, shell: &str) -> Self {
        ValidateResult { ok: false, code, message: message.into(), high_risk: false, shell: shell.into() }
    }
}

/// 拆分**引号外**的分号链式：返回引号外的分段。
/// 单/双引号成对开关，引号内的分号视为内容。
fn split_semicolons(cmd: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut quote: Option<char> = None;
    for (i, ch) in cmd.char_indices() {
        match quote {
            Some(q) if ch == q => quote = None,
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == ';' => {
                parts.push(&cmd[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&cmd[start..]);
    parts
}

/// 校验一条命令是否可执行。`platform` 取 `windows`（默认）或 `posix`。
pub fn validate_command(command: &str, platform: &str) -> ValidateResult {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return ValidateResult::reject(error::CMD_REJECTED, "empty command", platform);
    }

    // 1. 长度溢出（唯一的长度门槛）
    if trimmed.len() > CMD_OVERFLOW_LIMIT {
        return ValidateResult::reject(
            error::CMD_OVERFLOW_BLOCKED,
            &format!("command too long ({} chars > {} limit); write a script file instead", trimmed.len(), CMD_OVERFLOW_LIMIT),
            platform,
        );
    }

    // 2. && / || 链式
    if trimmed.contains("&&") || trimmed.contains("||") {
        return ValidateResult::reject(
            error::CMD_REJECTED,
            "chained commands (&& / ||) are not allowed; issue separate commands",
            platform,
        );
    }

    // 3. 引号外分号链式
    let parts = split_semicolons(trimmed);
    if parts.len() > 1 {
        return ValidateResult::reject(
            error::CMD_REJECTED,
            "unquoted semicolon chaining is not allowed; issue separate commands or use a .ps1 file",
            platform,
        );
    }

    let is_ps = trimmed.starts_with("powershell") || trimmed.starts_with("pwsh");
    if is_ps {
        if !trimmed.contains("-NoProfile") {
            return ValidateResult::reject(
                error::CMD_REJECTED,
                "PowerShell calls must use -NoProfile -NonInteractive prefix",
                "powershell",
            );
        }
        // 这里曾有一条「一行式 >200 字符且不含 .ps1 就拒绝」的规则，已删除：
        //  - 它拦的是长度而非危险性：201 字符的正确命令被拒、199 字符的同类命令放行；
        //  - 222 字符的 Invoke-WebRequest + try/catch 探测命令（常见写法）全被误杀，
        //    表现为 terminal「时好时坏」，且拒绝发生在审批之后（用户批准了也无效）；
        //  - 长度上限已由上方 `cmd.len() > 2000 → CMD_OVERFLOW_BLOCKED` 统一承担，
        //    本项在其之后判定永远不可达（死规则）。
        // 需要多步逻辑时，由提示词引导模型落成 .ps1 后 `-File` 执行；规则层不再加码。
    }

    // 4. 高危词（下载/改策略等）标记为高风险
    let lower = trimmed.to_lowercase();
    let high_risk = HIGH_RISK_PATTERNS.iter().any(|p| lower.contains(p));

    ValidateResult::pass(if is_ps { "powershell" } else { platform }, high_risk)
}
