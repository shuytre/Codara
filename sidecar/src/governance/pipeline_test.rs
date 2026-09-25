//! 治理管线单元测试：去噪/聚合/截断/去重/落盘阈值/退出码优先
#[cfg(test)]
mod tests {
    use crate::governance::pipeline;

    #[test]
    fn strip_ansi_colors_and_cursor() {
        let input = "\x1b[31merror\x1b[0m: failed\x1b[2K\r50%";
        let out = pipeline::strip_ansi(input);
        assert_eq!(out, "error: failed50%");
    }

    #[test]
    fn dedup_adjacent_lines() {
        let input = "a\na\na\nb\nb\nc";
        let out = pipeline::dedup_adjacent(input);
        assert_eq!(out, "a\nb\nc");
    }

    #[test]
    fn aggregate_errors_same_prefix() {
        let input = "error E001 in a.rs\nerror E001 in b.rs\nerror E001 in c.rs\nok line";
        let out = pipeline::aggregate_errors(input);
        assert!(out.contains("（同类 ×2）"));
        assert!(out.contains("ok line"));
        // 3 行同类 → 首条 + ×2
        assert_eq!(out.matches("error E001").count(), 1);
    }

    #[test]
    fn smart_truncate_keeps_head_and_tail() {
        let long = (0..1000).map(|i| format!("line {}", i)).collect::<Vec<_>>().join("\n");
        let out = pipeline::smart_truncate(&long);
        assert!(out.starts_with("line 0"));
        assert!(out.ends_with("line 999"));
        assert!(out.contains("智能截断"));
        // 截断后行数远小于原 1000
        assert!(out.lines().count() < 350);
    }

    #[test]
    fn govern_spills_over_threshold() {
        use std::cell::RefCell;
        let big = (0..500).map(|i| format!("row {}", i)).collect::<Vec<_>>().join("\n");
        let spilled = RefCell::new(None);
        let out = pipeline::govern(&big, "", &|content, _| {
            *spilled.borrow_mut() = Some(content.lines().count());
            Some("/tmp/spilled.out".to_string())
        });
        assert!(out.truncated);
        assert_eq!(out.spill_path.as_deref(), Some("/tmp/spilled.out"));
        // 落盘后返回首 40 行
        assert_eq!(out.stdout.lines().count(), pipeline::KEEP_HEAD);
        assert_eq!(*spilled.borrow(), Some(500));
    }

    #[test]
    fn govern_small_output_passes_through() {
        let out = pipeline::govern("hello", "err", &|_, _| None);
        assert!(!out.truncated);
        assert_eq!(out.stdout, "hello");
        assert_eq!(out.stderr, "err");
    }
}
