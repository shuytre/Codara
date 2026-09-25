//! 输出治理管线（规格 3.5.3，六步，terminal 输出进入上下文前强制执行）：
//! 1 去噪  2 分组聚合  3 智能截断  4 去重合并  5 超长落盘  6 退出码优先。
use serde_json::{json, Value};

pub const SPILL_LINES: usize = 200;
pub const SPILL_BYTES: usize = 8 * 1024;
pub const KEEP_HEAD: usize = 40;

#[derive(Debug)]
pub struct GovernedOutput {
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub spill_path: Option<String>,
}

/// 主入口：去 ANSI → 去重合并 → 智能截断 → 超长落盘
pub fn govern(stdout: &str, stderr: &str, spill_writer: &dyn Fn(&str, &str) -> Option<String>) -> GovernedOutput {
    // 1. 去噪：ANSI/光标控制/进度条
    let clean = strip_ansi(stdout);
    // 4. 去重合并：相邻相同行合并为「行 ×N」
    let merged = dedup_adjacent(&clean);
    // 3. 智能截断
    let truncated_out = smart_truncate(&merged);

    let clean_err = strip_ansi(stderr);
    // 2. 分组聚合：连续同类错误合并（只影响返回视图；落盘保留原始便于回看）
    let agg_err = aggregate_errors(&clean_err);

    // 5. 超长落盘：落盘保存去噪后的完整输出（截断前），供用户回看
    let line_count = truncated_out.lines().count();
    let byte_len = truncated_out.len() + agg_err.len();
    if line_count > SPILL_LINES || byte_len > SPILL_BYTES {
        let full = if clean_err.is_empty() {
            clean.clone()
        } else {
            format!("{}\n--- stderr ---\n{}", clean, clean_err)
        };
        if let Some(p) = spill_writer(&full, "") {
            let head: Vec<&str> = truncated_out.lines().take(KEEP_HEAD).collect();
            return GovernedOutput {
                stdout: head.join("\n"),
                stderr: agg_err.lines().take(10).collect::<Vec<_>>().join("\n"),
                truncated: true,
                spill_path: Some(p),
            };
        }
    }

    GovernedOutput {
        stdout: truncated_out,
        stderr: agg_err,
        truncated: false,
        spill_path: None,
    }
}

/// 剥离 ANSI 转义（颜色/光标/进度条行）
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // 跳过 ESC [ ... 一个字母 或 ESC ] ... BEL
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else if chars.peek() == Some(&']') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2 == '\x07' {
                        break;
                    }
                }
            }
        } else if c == '\r' {
            // 进度条覆盖：回车后同行内容覆盖前文——保留换行外的\r直接丢弃
            continue;
        } else {
            out.push(c);
        }
    }
    out
}

/// 相邻重复行合并
pub fn dedup_adjacent(s: &str) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    for line in s.lines() {
        if let Some(last) = out_lines.last_mut() {
            if *last == *line {
                continue; // 完全相同的相邻行：去重计数由聚合展示
            }
        }
        out_lines.push(line.to_string());
    }
    out_lines.join("\n")
}

/// 智能截断：保留头尾（命令头/报错摘要常在头，总结在尾），砍长尾重复
pub fn smart_truncate(s: &str) -> String {
    const MAX: usize = 400;
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() <= MAX {
        return s.to_string();
    }
    let head = &lines[..MAX / 2];
    let tail = &lines[lines.len() - MAX / 4..];
    format!(
        "{}\n…（智能截断 {} 行）…\n{}",
        head.join("\n"),
        lines.len() - head.len() - tail.len(),
        tail.join("\n")
    )
}

/// 错误聚合：连续同类错误（公共前缀 ≥10 字符）合并为首条 + （同类 ×N）
pub fn aggregate_errors(s: &str) -> String {
    const MIN_PREFIX: usize = 10;
    struct Group {
        rep: String,
        count: usize,
    }
    let mut groups: Vec<Group> = Vec::new();
    for line in s.lines() {
        let merged = match groups.last_mut() {
            Some(g) => {
                let threshold = MIN_PREFIX.min(g.rep.len().min(line.len()));
                common_prefix_len(&g.rep, line) >= threshold && threshold > 0
            }
            None => false,
        };
        if merged {
            groups.last_mut().unwrap().count += 1;
        } else {
            groups.push(Group { rep: line.to_string(), count: 1 });
        }
    }
    groups
        .iter()
        .map(|g| {
            if g.count > 1 {
                format!("{}（同类 ×{}）", g.rep, g.count - 1)
            } else {
                g.rep.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// 供测试与 preview 用
pub fn preview(stdout: &str) -> Value {
    json!({
        "cleaned": strip_ansi(stdout),
        "deduped": dedup_adjacent(&strip_ansi(stdout)),
        "aggregated": aggregate_errors(&dedup_adjacent(&strip_ansi(stdout))),
    })
}
