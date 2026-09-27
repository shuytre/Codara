//! cmd_rules 单元测试：长度门槛、链式拒绝、引号内分号豁免、PS 前缀、高危识别。
//!
//! 本文件的存在本身就是一次事故的产物：cmd_rules 此前**零测试覆盖**，于是带着
//! 两条互相矛盾的规则上了线——
//!   - 提示词告诉模型「链式命令用分号分隔」；
//!   - 这里却硬拒分号；
//!   - 外加「一行式 >200 字符且不含 .ps1 就拒绝」，把 222 字符的
//!     Invoke-WebRequest + try/catch 探测命令全部误杀。
//! 于是 terminal「时好时坏」：短命令能过、长命令必挂，且失败发生在审批之后
//! （用户批准了也白批）。下面的用例把这些边界固定下来。
use crate::governance::cmd_rules::{validate_command, HIGH_RISK_PATTERNS};
use crate::rpc::error;

fn win(cmd: &str) -> crate::governance::cmd_rules::ValidateResult {
    validate_command(cmd, "windows")
}

// ---------------------------------------------------------------- 长度门槛
#[test]
fn long_ps_one_liner_is_accepted_below_overflow_limit() {
    // 回归：222 字符的真实探测命令（截图里被拒的那条）现在必须不再因长度被拒
    let long = r#"powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://www.google.com/search?q=best+agent+model' -UseBasicParsing -TimeoutSec 15; 'g'; + $r.StatusCode } catch { 'g FAIL: ' + $PSItem.Exception.Message }""#;
    assert!(long.len() > 200, "用例本身应超过旧门槛，否则失去回归意义");
    let r = win(long);
    // 旧实现会以 "one-liner >200 chars" 拒绝；现在长度不再是误杀来源
    assert!(
        !r.message.contains("one-liner"),
        "长度规则不应再拦下 {}-char 命令，实际: {}",
        long.len(),
        r.message
    );
}

#[test]
fn ps_one_liner_length_no_longer_rejects_below_overflow() {
    // 回归核心：旧规则「一行式 >200 字符且不含 .ps1 就拒绝」已删除。
    // 222 字符的真实探测命令，现在只能因「其他规则」被拒，不能因长度被拒。
    let long = r#"powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'https://www.google.com/search?q=best+agent+model' -UseBasicParsing -TimeoutSec 15; 'g: ' + $r.StatusCode } catch { 'g FAIL: ' + $PSItem.Exception.Message }""#;
    assert!(long.len() > 200 && long.len() < 2000, "用例应落在 200~2000 区间");
    let r = win(long);
    assert!(
        !r.message.contains("one-liner"),
        "{}-char 命令不应再因长度被拒，实际: {}",
        long.len(),
        r.message
    );
    assert!(r.ok, "该命令不含链式/违规前缀，应放行，实际: {}", r.message);
}

// ---------------------------------------------------------------- 长度溢出（与 PS 门槛区分）
#[test]
fn command_over_2000_rejected_as_overflow() {
    let long = "x".repeat(2001);
    let r = win(&long);
    assert!(!r.ok);
    assert_eq!(r.code, error::CMD_OVERFLOW_BLOCKED);
}

// ---------------------------------------------------------------- 链式
#[test]
fn double_ampersand_and_pipe_or_rejected() {
    assert!(!win("echo a && echo b").ok);
    assert!(!win("echo a || echo b").ok);
}

#[test]
fn unquoted_semicolon_rejected() {
    let r = win("dir; echo hi");
    assert!(!r.ok);
    assert_eq!(r.code, error::CMD_REJECTED);
    assert!(r.message.contains("semicolon"));
}

#[test]
fn semicolon_inside_quotes_is_content_not_chaining() {
    // PowerShell 单引号字符串里的分号是合法内容，不得判为链式
    let r = win(r#"powershell -NoProfile -Command "Write-Output 'a;b'""#);
    assert!(r.ok, "引号内分号不应被拒: {}", r.message);
}

// ---------------------------------------------------------------- PS 前缀
#[test]
fn powershell_requires_no_profile() {
    let r = win(r#"powershell -Command "Get-ChildItem""#);
    assert!(!r.ok);
    assert!(r.message.contains("-NoProfile"));
}

#[test]
fn short_powershell_file_invocation_accepted() {
    // 截图里能过的那种短命令，必须保持放行（防过度收紧）
    assert!(win("powershell -NoProfile -File swebench_parse.ps1").ok);
}

#[test]
fn empty_command_rejected() {
    let r = win("   ");
    assert!(!r.ok);
}

// ---------------------------------------------------------------- 高危
#[test]
fn high_risk_detected_for_destructive_commands() {
    assert!(win("rm -rf /tmp/x").high_risk);
    assert!(win("format C: /q").high_risk);
    assert!(win("reg add HKLM\\Software\\X").high_risk);
    assert!(!win("dir").high_risk);
}

#[test]
fn high_risk_patterns_are_lowercase_for_case_insensitive_match() {
    // 匹配用小写化后的命令，模式表必须全小写，否则恒不命中
    for p in HIGH_RISK_PATTERNS {
        assert_eq!(*p, p.to_lowercase(), "模式 `{}` 含大写，匹配会失效", p);
    }
}

#[test]
fn plain_cmd_commands_pass() {
    assert!(win("dir").ok);
    assert!(win("npm test").ok);
}
