//! cmd_rules 单元测试。
//!
//! 本文件记录了一次**口径反转**（2026-09-28）：
//!
//! 旧口径（已废弃）：sidecar 作为「白名单减摩擦层」，对命令内容做违禁词过滤、
//!   PowerShell 最小子集约束、链式命令（`&&`/`||`/`;`）拦截、高危语义识别，
//!   以及一条「一行式 >200 字符且不含 .ps1 就拒绝」的长度规则。
//!
//! 由此产生的线上事故（三轮截图）：
//!   - `Get-ChildItem -Force | Select-Object Name` 因 `select-object` 在禁用词表里被拒；
//!   - 222 字符的 `Invoke-WebRequest + try/catch` 因长度规则被拒；
//!   - 最严重的是**拒绝发生在审批之后** —— 用户点了「批准」，命令仍被拒，
//!     审批卡沦为无效交互（截图：卡上「已批准」，工具流水里却是 ✗）。
//!
//! 新口径：**sidecar 不做任何内容审查**。命令原样执行，安全职责全部交给
//!   Electron 侧强制保留的人工审查中间层（gateway），高危与读写类命令一律审批。
//!   本模块只保留两条工程性保护：空命令、长度上限（防 RPC 帧撑爆）。
//!
//! 下面的用例把新口径钉死：过去被误杀的命令必须全部放行。
use crate::governance::cmd_rules::{validate_command, CMD_MAX_LEN};
use crate::rpc::error;

fn win(cmd: &str) -> crate::governance::cmd_rules::ValidateResult {
    validate_command(cmd, "windows")
}

// ---------------------------------------------------------------- 只保留两条工程保护

#[test]
fn empty_command_rejected() {
    // 空串不是命令，属缺参：避免把空串当命令去 spawn 进程
    let r = win("   ");
    assert!(!r.ok);
    assert_eq!(r.code, error::CMD_REJECTED);
}

#[test]
fn command_over_limit_rejected_as_overflow() {
    // 长度上限是传输层约束（防 stdio 行帧撑爆），与旧「>200 字符一行式」规则无关
    let long = "x".repeat(CMD_MAX_LEN + 1);
    let r = win(&long);
    assert!(!r.ok);
    assert_eq!(r.code, error::CMD_OVERFLOW_BLOCKED);
}

#[test]
fn command_at_exactly_the_limit_is_accepted() {
    // 边界：恰好等于上限必须放行（不是 >上限 才拒）
    let at_limit = "x".repeat(CMD_MAX_LEN);
    assert!(win(&at_limit).ok, "恰好 {} 字符应放行", CMD_MAX_LEN);
}

// ---------------------------------------------------------------- 内容过滤已全部移除

#[test]
fn read_only_pipeline_cmdlets_are_allowed() {
    // 事故一：截图里被拒的那条
    assert!(win("Get-ChildItem -Force | Select-Object Name").ok);
    for cmd in [
        "Get-ChildItem -Recurse | Where-Object { $_.Length -gt 0 }",
        "Get-Process | Sort-Object CPU -Descending",
        "gci -Recurse *.rs | Select-Object -First 20",
        "Get-Content src/main.rs | Select-String todo",
        "powershell -NoProfile -Command \"Get-ChildItem | Select-Object Name\"",
    ] {
        assert!(win(cmd).ok, "`{}` 应无条件放行", cmd);
    }
}

#[test]
fn previously_forbidden_ps_tokens_are_now_allowed() {
    // 旧 FORBIDDEN 表里的词元，现在一律放行（不再有违禁词过滤）
    for cmd in [
        "Get-ChildItem | Format-Table",
        "Set-ExecutionPolicy Bypass",
        "Invoke-Expression $cmd",
        "echo $env:PATH",
        "Get-Content app.log -Tail 20",
        "gc -tail 20 app.log",
    ] {
        assert!(win(cmd).ok, "`{}` 应放行（sidecar 不再做内容审查）", cmd);
    }
}

#[test]
fn long_one_liner_is_accepted() {
    // 事故二：222 字符的探测命令
    let long = r#"powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://www.google.com/search?q=best+agent+model' -UseBasicParsing -TimeoutSec 15; 'g: ' + $r.StatusCode } catch { 'g FAIL: ' + $PSItem.Exception.Message }""#;
    assert!(long.len() > 200 && long.len() < CMD_MAX_LEN, "用例应落在 200~{} 区间", CMD_MAX_LEN);
    let r = win(long);
    assert!(r.ok, "长一行式不应再被拒: {}", r.message);
    assert!(!r.message.contains("one-liner"));
}

#[test]
fn chained_commands_are_allowed() {
    // 链式命令不再拦截：模型按需自由组合
    for cmd in [
        "echo a && echo b",
        "echo a || echo b",
        "dir; echo hi",
        "cd src && npm test",
    ] {
        assert!(win(cmd).ok, "`{}` 应放行（链式拦截已移除）", cmd);
    }
}

#[test]
fn powershell_without_no_profile_is_allowed() {
    // 不再强制 -NoProfile 前缀
    assert!(win("powershell -Command \"Get-ChildItem\"").ok);
    assert!(win("pwsh -File build.ps1").ok);
}

#[test]
fn destructive_commands_pass_sidecar_but_are_left_to_human_review() {
    // 高危命令在 sidecar 层放行 —— 拦截职责已上移到 gateway 的人工审查。
    // 这里断言的是「sidecar 不拦」，审查由 gateway 保证（见 gateway.test.ts）。
    for cmd in [
        "rm -rf /tmp/x",
        "format C: /q",
        "reg add HKLM\\Software\\X",
        "del /f /s /q D:\\data",
    ] {
        let r = win(cmd);
        assert!(r.ok, "`{}` 应在 sidecar 放行，交由人工审查", cmd);
        // 且不再由 sidecar 标注风险等级（网关负责）
        assert!(!r.high_risk, "sidecar 不再做高危识别");
    }
}

#[test]
fn plain_commands_pass() {
    assert!(win("dir").ok);
    assert!(win("npm test").ok);
    assert!(win("git status").ok);
}

// ---------------------------------------------------------------- shell 标注回显

#[test]
fn shell_hint_reflects_model_annotation() {
    assert_eq!(win("(PowerShell) Get-ChildItem -Force").shell, "powershell");
    assert_eq!(win("(CMD) dir /b").shell, "cmd");
    assert_eq!(win("(Bash) ls -la").shell, "bash");
}

#[test]
fn shell_hint_falls_back_to_executable_prefix() {
    assert_eq!(win("powershell -NoProfile -File a.ps1").shell, "powershell");
    assert_eq!(win("bash -c 'echo hi'").shell, "bash");
    assert_eq!(win("dir").shell, "cmd");
}
