//! 分词与排序（M5 轻量语义）。
//! tokenize：标识符感知分词（camelCase / snake_case / kebab 拆分，小写化）。
//! BM25F 与模糊匹配在 semantic 查询路径使用。

/// 标识符感知分词：非字母数字切段 + camelCase 边界拆分，全小写。
/// 例：`parseFileList` → [parse, file, list]；`user_id` → [user, id]。
pub fn tokenize(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = input.as_bytes();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<String>| {
        if !word.is_empty() {
            if word.len() >= 2 && word.len() <= 40 {
                out.push(std::mem::take(word));
            } else {
                word.clear();
            }
        }
    };
    let mut prev_kind: u8 = 0; // 0=other 1=lower 2=upper 3=digit
    for i in 0..bytes.len() {
        let c = bytes[i] as char;
        let kind = if c.is_ascii_lowercase() {
            1
        } else if c.is_ascii_uppercase() {
            2
        } else if c.is_ascii_digit() {
            3
        } else {
            0
        };
        if kind == 0 {
            flush(&mut word, &mut out);
            prev_kind = 0;
            continue;
        }
        // camelCase 边界：小写/数字 → 大写，或 大写序列 → 大写+小写（XMLHttp|Reader）
        let boundary = prev_kind != 0
            && ((kind == 2 && prev_kind != 2)
                || (kind == 2
                    && prev_kind == 2
                    && i + 1 < bytes.len()
                    && (bytes[i + 1] as char).is_ascii_lowercase()));
        if boundary {
            flush(&mut word, &mut out);
        }
        word.push(c.to_ascii_lowercase());
        prev_kind = kind;
    }
    flush(&mut word, &mut out);
    out
}

/// 简易编辑距离（限长 32，超出直接返回大值）
pub fn levenshtein(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len() > 32 || b.len() > 32 {
        return usize::MAX / 2;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 模糊匹配判定：精确 / 前缀 / 子串 / 编辑距离 ≤2（词长 ≥4）
pub fn fuzzy_eq(query: &str, term: &str) -> bool {
    if query == term {
        return true;
    }
    if term.starts_with(query) || query.starts_with(term) {
        return true;
    }
    if query.len() >= 4 && query.contains(term) {
        return true;
    }
    if query.len() >= 4 {
        return levenshtein(query, term) <= 2;
    }
    false
}

/// BM25 参数
const K1: f64 = 1.2;
const B: f64 = 0.75;
/// 字段权重（BM25F 简化：字段分数加权求和）
pub const W_NAME: f64 = 3.0;
pub const W_PATH: f64 = 2.0;
pub const W_CONTENT: f64 = 1.0;

/// 单字段 BM25 分数：tf / (tf + k1*(1-b+b*dl/avgdl)) * idf
pub fn bm25(tf: f64, doc_len: f64, avg_len: f64, n_docs: f64, n_match: f64) -> f64 {
    if tf <= 0.0 || doc_len <= 0.0 {
        return 0.0;
    }
    // idf：索引为空或全命中时下限 0.1（保证有分数）
    let idf = ((n_docs - n_match + 0.5) / (n_match + 0.5) + 1.0).ln().max(0.1);
    let avg = if avg_len > 0.0 { avg_len } else { doc_len };
    let norm = K1 * (1.0 - B + B * doc_len / avg);
    idf * (tf * (K1 + 1.0)) / (tf + norm)
}

/// BM25F 字段融合（简化式）：content 基础分 + name×min(命中,3) + path×min(命中,3)。
/// 命中数封顶 3，防止单字段海量命中淹没其它信号。
pub fn fuse(content: f64, name_hits: f64, path_hits: f64) -> f64 {
    content + W_NAME * name_hits.min(3.0) + W_PATH * path_hits.min(3.0)
}
