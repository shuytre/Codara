//! 增量遍历：ignore::WalkBuilder（尊重 .gitignore / 隐藏文件），仅收集元数据。
//! 快路径（未建库首搜）也走这里：按文件名匹配 + early cutoff。

/// 全量收集（相对路径, mtime_ms, size）。walk 顺序稳定，便于增量对账。
pub fn collect(root: &std::path::Path) -> Vec<(String, i64, u64)> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .parents(true)
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push((rel, mtime, meta.len()));
    }
    out
}

/// 快路径：按文件名子串匹配（小写），early cutoff 上限 max_hits。
/// 用于未建索引时的 symbols 首搜降级（<1s 口径：只扫路径不读内容）。
pub fn filename_match(root: &std::path::Path, needle: &str, max_hits: usize) -> Vec<String> {
    let needle = needle.to_lowercase();
    let mut out = Vec::new();
    if needle.is_empty() {
        return out;
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .parents(true)
        .build();
    for entry in walker.flatten() {
        if out.len() >= max_hits {
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.contains(&needle) {
            let rel = entry
                .path()
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if !rel.is_empty() {
                out.push(rel);
            }
        }
    }
    out
}
