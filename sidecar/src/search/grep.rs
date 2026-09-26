//! search.run：ripgrep 库形态（grep-searcher + ignore）。
//! mode: rg=内容搜索；files=文件列举；symbols=符号索引（M5，转调 index::index_symbols）。
use std::path::Path;

use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

const DEFAULT_MAX: usize = 100;
const MAX_CONTEXT: usize = 3;

struct Collector {
    matches: Vec<Value>,
    total: usize,
    max: usize,
    current_file: Option<String>,
}

impl Sink for Collector {
    type Error = std::io::Error;

    fn matched(&mut self, _s: &Searcher, m: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        self.total += 1;
        if self.total <= self.max {
            let text = String::from_utf8_lossy(m.bytes()).trim_end().to_string();
            self.matches.push(json!({
                "path": self.current_file.clone().unwrap_or_default(),
                "line": m.line_number().unwrap_or(0),
                "text": text,
            }));
        }
        Ok(self.total <= self.max * 2) // 超限后尽快停止
    }
}

pub fn search_run(state: &mut AppState, params: Value) -> Envelope {
    let pattern = match params.get("pattern").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "pattern is required"),
    };
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("rg");
    let base = params
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ".".to_string());
    let base_path = match state.resolve_in_workspace(&base) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let case_sensitive = params.get("caseSensitive").and_then(|v| v.as_bool()).unwrap_or(false);
    let context = (params.get("context").and_then(|v| v.as_u64()).unwrap_or(0) as usize).min(MAX_CONTEXT);
    let max_results = (params.get("maxResults").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_MAX as u64) as usize)
        .min(1000);
    let globs: Vec<String> = params
        .get("glob")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect())
        .unwrap_or_default();

    match mode {
        "files" => {
            let mut files = Vec::new();
            for entry in WalkBuilder::new(&base_path)
                .hidden(true)
                .git_ignore(true)
                .build()
            {
                if let Ok(e) = entry {
                    if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        files.push(e.path().display().to_string());
                        if files.len() >= max_results {
                            break;
                        }
                    }
                }
            }
            let truncated = files.len() >= max_results;
            let mut env = Envelope::ok(json!({ "files": files, "totalMatches": files.len() }));
            if truncated {
                env = env.truncated(format!("file list truncated at {}", max_results));
            }
            env
        }
        "symbols" => {
            // M5：symbols 模式走符号索引（index.symbols 同语义）
            let mut idx_params = serde_json::Map::new();
            idx_params.insert("name".into(), Value::String(pattern));
            if let Some(k) = params.get("kind").and_then(|v| v.as_str()) {
                idx_params.insert("kind".into(), Value::String(k.to_string()));
            }
            if let Some(x) = params.get("exact").and_then(|v| v.as_bool()) {
                idx_params.insert("exact".into(), Value::Bool(x));
            }
            idx_params.insert("limit".into(), json!(max_results as u64));
            crate::index::index_symbols(state, Value::Object(idx_params))
        }
        _ => {
            let matcher = match RegexMatcherBuilder::default()
                .case_insensitive(!case_sensitive)
                .build(&pattern)
            {
                Ok(m) => m,
                Err(e) => return Envelope::err(error::INVALID_PARAMS, format!("bad regex: {}", e)),
            };
            let mut searcher = SearcherBuilder::new()
                .binary_detection(grep_searcher::BinaryDetection::quit(b'\x00'))
                .before_context(context)
                .after_context(context)
                .line_number(true)
                .build();
            let mut collector = Collector {
                matches: Vec::new(),
                total: 0,
                max: max_results,
                current_file: None,
            };

            let walker = WalkBuilder::new(&base_path).hidden(true).git_ignore(true).build();
            'outer: for entry in walker {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let path: &Path = entry.path();
                // glob 过滤（支持 !negation）
                if !globs.is_empty() && !glob_match_any(path, &globs) {
                    continue;
                }
                collector.current_file = Some(entry.path().display().to_string());
                if searcher.search_path(&matcher, path, &mut collector).is_err() {
                    continue;
                }
                if collector.total > max_results * 2 {
                    break 'outer;
                }
            }
            let truncated = collector.total > max_results;
            let mut env = Envelope::ok(json!({
                "matches": collector.matches,
                "totalMatches": collector.total.min(max_results),
            }));
            if truncated {
                env = env.truncated(format!("共 {} 处命中，仅返回前 {} 条", collector.total, max_results));
            }
            env
        }
    }
}

fn glob_match_any(path: &Path, globs: &[String]) -> bool {
    let s = path.display().to_string();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let mut has_positive = false;
    for g in globs {
        if let Some(neg) = g.strip_prefix('!') {
            if simple_glob(&s, neg) || simple_glob(name, neg) {
                return false;
            }
        } else if simple_glob(&s, g) || simple_glob(name, g) {
            has_positive = true;
        }
    }
    if globs.iter().any(|g| !g.starts_with('!')) {
        has_positive
    } else {
        true
    }
}

/// 极简 glob：* 任意串、? 单字符
///
/// 用双指针线性算法（O(n·m)）实现。原实现是「遇到 * 就递归枚举切分点」，
/// k 个 `*` 的复杂度是 O(n^k)：glob `*a*a*a*a*a*a*a*a*a*a*b` 配 40 字符路径
/// 需要数十亿次递归，sidecar 单线程主线程直接挂死，一条请求即可 DoS。
fn simple_glob(s: &str, pat: &str) -> bool {
    let (sb, pb) = (s.as_bytes(), pat.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    // star：最近一个 `*` 在 pattern 中的位置；si：该 `*` 当前尝试匹配到的 s 下标
    let (mut star, mut si) = (None::<usize>, 0usize);
    while i < sb.len() {
        if j < pb.len() && (pb[j] == b'?' || pb[j] == sb[i]) {
            i += 1;
            j += 1;
        } else if j < pb.len() && pb[j] == b'*' {
            star = Some(j);
            si = i;
            j += 1;
        } else if let Some(st) = star {
            j = st + 1;
            si += 1;
            i = si;
        } else {
            return false;
        }
    }
    // 尾部剩余的 `*` 可以匹配空串
    while j < pb.len() && pb[j] == b'*' {
        j += 1;
    }
    j == pb.len()
}
