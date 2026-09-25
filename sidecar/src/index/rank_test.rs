//! rank 模块单测：分词 / 编辑距离 / 模糊匹配 / BM25 / BM25F 字段融合。

use super::rank::{bm25, fuse, fuzzy_eq, levenshtein, tokenize, W_NAME, W_PATH};

// ---------------- tokenize ----------------

#[test]
fn tokenize_splits_camel_snake_kebab() {
    assert_eq!(tokenize("parseFileList"), vec!["parse", "file", "list"]);
    assert_eq!(tokenize("user_id"), vec!["user", "id"]);
    // 全大写缩写序列：XMLHttp|Reader 边界
    assert_eq!(tokenize("XMLHttpRequest"), vec!["xml", "http", "request"]);
    assert_eq!(tokenize("get-HTTP-response"), vec!["get", "http", "response"]);
    // 路径：非字母数字（/ . \）切段
    assert_eq!(tokenize("src/index/mod.rs"), vec!["src", "index", "mod", "rs"]);
}

#[test]
fn tokenize_filters_by_length() {
    // 单字符词丢弃（噪声过滤）
    assert_eq!(tokenize("a bc def"), vec!["bc", "def"]);
    // 超长词（>40 字符）丢弃
    let long = "a".repeat(41);
    assert!(tokenize(&long).is_empty());
    // 恰好 40 字符保留
    let ok = "a".repeat(40);
    assert_eq!(tokenize(&ok), vec![ok.clone()]);
    // 空输入
    assert!(tokenize("").is_empty());
    // 纯符号输入
    assert!(tokenize("///...___").is_empty());
}

#[test]
fn tokenize_digit_boundary() {
    // 数字段保留在前词内；大写边界仍生效
    assert_eq!(tokenize("v2User"), vec!["v2", "user"]);
    assert_eq!(tokenize("user2Profile"), vec!["user2", "profile"]);
    assert_eq!(tokenize("http2x"), vec!["http2x"]); // 数字+小写无边界
}

// ---------------- levenshtein ----------------

#[test]
fn levenshtein_basics() {
    assert_eq!(levenshtein("kitten", "sitting"), 3);
    assert_eq!(levenshtein("abc", "abc"), 0);
    assert_eq!(levenshtein("", "abc"), 3);
    assert_eq!(levenshtein("abc", ""), 3);
    assert_eq!(levenshtein("flaw", "lawn"), 2);
}

#[test]
fn levenshtein_bounded_at_32() {
    let a = "a".repeat(33);
    let b = "a".repeat(33);
    assert_eq!(levenshtein(&a, &b), 0); // 相等短路不受限长影响
    let c = "b".repeat(33);
    assert!(levenshtein(&a, &c) > 1_000_000); // 超限返回大值
}

// ---------------- fuzzy_eq ----------------

#[test]
fn fuzzy_eq_exact_and_prefix() {
    assert!(fuzzy_eq("foo", "foo")); // 精确
    assert!(fuzzy_eq("foo", "foobar")); // term 前缀命中（不限长度）
    assert!(fuzzy_eq("foobar", "foo")); // query 前缀命中
    assert!(fuzzy_eq("abc", "abcdx")); // 短 query 前缀同样命中
    assert!(!fuzzy_eq("foobar", "xyz")); // 无前缀/子串关系
}

#[test]
fn fuzzy_eq_substring_requires_len4() {
    // query 长度 ≥4 才允许子串命中
    assert!(fuzzy_eq("myfile", "file")); // "myfile".contains("file")
    assert!(fuzzy_eq("foobar", "ooba")); // 子串命中（len 6）
    assert!(!fuzzy_eq("myfi", "file")); // len 4 但不含 "file"
    // 短 query（<4）：无前缀关系则不做子串/编辑距离
    assert!(!fuzzy_eq("abc", "xbc"));
}

#[test]
fn fuzzy_eq_edit_distance() {
    // 编辑距离 ≤2（词长 ≥4）
    assert!(fuzzy_eq("index", "indx")); // 距离 1
    assert!(fuzzy_eq("semanic", "semantic")); // 距离 1（漏字母）
    assert!(!fuzzy_eq("index", "tokenizer")); // 距离过大
    // 短词（<4）只允许精确/前缀
    assert!(!fuzzy_eq("ab", "ax"));
}

// ---------------- bm25 ----------------

#[test]
fn bm25_zero_cases() {
    assert_eq!(bm25(0.0, 10.0, 10.0, 100.0, 1.0), 0.0); // tf=0
    assert_eq!(bm25(1.0, 0.0, 10.0, 100.0, 1.0), 0.0); // doc_len=0
}

#[test]
fn bm25_tf_monotonic() {
    let s1 = bm25(1.0, 10.0, 10.0, 100.0, 5.0);
    let s2 = bm25(2.0, 10.0, 10.0, 100.0, 5.0);
    let s5 = bm25(5.0, 10.0, 10.0, 100.0, 5.0);
    assert!(s2 > s1);
    assert!(s5 > s2);
    // 饱和趋近 idf*(k1+1)，不会无限增长
    assert!(s5 < s1 * 5.0);
}

#[test]
fn bm25_length_normalization() {
    // 同 tf：短文档得分高于长文档
    let short = bm25(1.0, 10.0, 100.0, 100.0, 5.0);
    let long = bm25(1.0, 1000.0, 100.0, 100.0, 5.0);
    assert!(short > long);
}

#[test]
fn bm25_idf_rarer_term_scores_higher() {
    // 同 tf：命中文件更少（更稀有）的词 idf 更高
    let rare = bm25(1.0, 10.0, 10.0, 100.0, 1.0);
    let common = bm25(1.0, 10.0, 10.0, 100.0, 50.0);
    let all = bm25(1.0, 10.0, 10.0, 100.0, 100.0);
    assert!(rare > common);
    assert!(common > all);
    // 全命中时 idf 下限 0.1，仍有分数
    assert!(all > 0.0);
}

// ---------------- fuse（BM25F 字段融合） ----------------

#[test]
fn fuse_field_weight_ordering() {
    // 权重序：name×3 > path×2 > content×1
    let base = fuse(1.0, 0.0, 0.0);
    assert_eq!(base, 1.0);
    assert!(fuse(1.0, 1.0, 0.0) > fuse(1.0, 0.0, 1.0));
    assert!(fuse(1.0, 0.0, 1.0) > base);
    assert_eq!(fuse(1.0, 1.0, 1.0), 1.0 + W_NAME + W_PATH);
}

#[test]
fn fuse_caps_hits_at_three() {
    // 命中数封顶 3：超出部分不再加权
    assert_eq!(fuse(0.0, 5.0, 0.0), W_NAME * 3.0);
    assert_eq!(fuse(0.0, 100.0, 100.0), W_NAME * 3.0 + W_PATH * 3.0);
    // 封顶前线性
    assert_eq!(fuse(0.0, 2.0, 0.0), W_NAME * 2.0);
}

#[test]
fn fuse_empty() {
    assert_eq!(fuse(0.0, 0.0, 0.0), 0.0);
}
