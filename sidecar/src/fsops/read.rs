//! fs.read：分页按行返回、编码探测（BOM/UTF-8/GBK/GB18030）、二进制元信息、重复读缓存。
use std::fs;
use std::io::Read;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::{AppState, ReadCache};

pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_LIMIT: usize = 2000;

/// 编码探测：BOM → 严格 UTF-8 → GB18030（GBK 超集）
pub fn detect_encoding(bytes: &[u8]) -> (&'static str, Vec<u8>) {
    // BOM 检测
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return ("utf-8-bom", bytes[3..].to_vec());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return ("utf-16le", bytes[2..].to_vec());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return ("utf-16be", bytes[2..].to_vec());
    }
    // 严格 UTF-8 校验
    if std::str::from_utf8(bytes).is_ok() {
        return ("utf-8", bytes.to_vec());
    }
    // 回退 GB18030（覆盖 GBK/GB2312）
    let (decoded, _, had_errors) = encoding_rs::GB18030.decode(bytes);
    if !had_errors {
        return ("gb18030", decoded.to_string().into_bytes());
    }
    ("binary", bytes.to_vec())
}

pub fn is_probably_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let check_len = bytes.len().min(8192);
    let nulls = bytes[..check_len].iter().filter(|&&b| b == 0).count();
    if nulls > 0 {
        return true;
    }
    // 高比例控制字符视为二进制
    let ctrl = bytes[..check_len]
        .iter()
        .filter(|&&b| b < 9 || (b > 13 && b < 32))
        .count();
    ctrl * 100 > check_len * 10
}

pub fn split_lines(data: &[u8]) -> (Vec<String>, LineEnding) {
    let text = String::from_utf8_lossy(data).to_string();
    let ending = if text.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    let lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    // split('\n') 末尾若原文以 \n 结尾会产生空尾巴，去掉最后一个空元素
    let mut lines = lines;
    if lines.last().map(|l| l.is_empty()).unwrap_or(false) && text.ends_with('\n') {
        lines.pop();
    }
    (lines, ending)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

pub fn fs_read(state: &mut AppState, params: Value) -> Envelope {
    let path_str = match params.get("path").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "path is required"),
    };
    let full = match state.resolve_in_workspace(&path_str) {
        Ok(p) => p,
        Err(e) => return e,
    };

    let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let offset = offset.max(1);
    let limit = params
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_LIMIT as u64) as usize;
    let limit = limit.min(MAX_LIMIT);

    let meta = match fs::metadata(&full) {
        Ok(m) => m,
        Err(_) => return Envelope::err(error::FILE_NOT_FOUND, format!("not found: {}", path_str)),
    };
    if meta.is_dir() {
        return Envelope::err(error::INVALID_PARAMS, format!("path is a directory: {}", path_str));
    }

    let mut bytes = Vec::new();
    if let Ok(mut f) = fs::File::open(&full) {
        let _ = f.read_to_end(&mut bytes);
    }

    if is_probably_binary(&bytes) {
        let head_hex: String = bytes
            .iter()
            .take(64)
            .map(|b| format!("{:02x}", b))
            .collect();
        let mime = guess_mime(&full);
        return Envelope::ok(json!({
            "path": path_str,
            "binary": { "size": meta.len(), "mime": mime, "headHex": head_hex }
        }));
    }

    let (encoding, decoded) = detect_encoding(&bytes);
    let (lines, _ending) = split_lines(&decoded);
    let total = lines.len();

    let cache_key = format!("{}:{}:{}", path_str, offset, limit);
    let content_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hex::encode(hasher.finalize())
    };

    // 重复读缓存：同 path+offset+limit 返回引用
    {
        let mut cache = state.read_cache.lock().unwrap();
        if let Some(cached) = cache.get(&cache_key) {
            if cached.content_hash == content_hash {
                return Envelope::ok(json!({
                    "path": path_str, "cacheHit": true
                }))
                .cache_ref(format!("@cache:{}:{}-{}", path_str, offset, offset + limit - 1));
            }
        }
    }

    let start = (offset - 1).min(total);
    let end = (start + limit).min(total);
    let slice: Vec<Value> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| json!({ "no": start + i + 1, "text": l }))
        .collect();

    // 登记缓存
    {
        let mut cache = state.read_cache.lock().unwrap();
        cache.insert(
            cache_key,
            ReadCache {
                content_hash: content_hash.clone(),
                lines: lines[start..end].to_vec(),
                encoding: encoding.to_string(),
            },
        );
    }

    let mut env = Envelope::ok(json!({
        "path": path_str,
        "encoding": encoding,
        "totalLines": total,
        "offset": offset,
        "lines": slice,
        "baselineHash": content_hash,
    }));
    if end < total {
        env = env.truncated(format!("共 {} 行，已返回 {}-{} 行，可用 offset 续读", total, start + 1, end));
    }
    env
}

pub fn fs_meta(state: &mut AppState, params: Value) -> Envelope {
    let path_str = match params.get("path").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "path is required"),
    };
    let full = match state.resolve_in_workspace(&path_str) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match fs::metadata(&full) {
        Ok(m) => Envelope::ok(json!({
            "path": path_str,
            "size": m.len(),
            "isDir": m.is_dir(),
            "modifiedMs": m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
        })),
        Err(_) => Envelope::err(error::FILE_NOT_FOUND, format!("not found: {}", path_str)),
    }
}

/// @cache:path:起-止 解析：从读缓存重放
pub fn cache_resolve(state: &mut AppState, params: Value) -> Envelope {
    let r = match params.get("ref").and_then(|v| v.as_str()) {
        Some(r) => r.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "ref is required"),
    };
    if !r.starts_with("@cache:") {
        return Envelope::err(error::INVALID_PARAMS, "not a cache ref");
    }
    let body = &r["@cache:".len()..];
    let parts: Vec<&str> = body.rsplitn(2, ':').collect();
    if parts.len() != 2 {
        return Envelope::err(error::INVALID_PARAMS, "malformed cache ref");
    }
    let range = parts[0];
    let path = parts[1];
    let (start_s, end_s) = match range.split_once('-') {
        Some(s) => s,
        None => return Envelope::err(error::INVALID_PARAMS, "malformed range"),
    };
    let start: usize = start_s.parse().unwrap_or(1);
    let end: usize = end_s.parse().unwrap_or(start);

    // 用相同 key 查缓存：read 的 key 是 path:offset:limit
    let limit = end.saturating_sub(start) + 1;
    let cache_key = format!("{}:{}:{}", path, start, limit);
    let cache = state.read_cache.lock().unwrap();
    match cache.get(&cache_key) {
        Some(c) => {
            let lines: Vec<Value> = c
                .lines
                .iter()
                .enumerate()
                .map(|(i, l)| json!({ "no": start + i, "text": l }))
                .collect();
            Envelope::ok(json!({ "path": path, "lines": lines, "encoding": c.encoding }))
        }
        None => Envelope::err(error::INVALID_PARAMS, "cache miss; re-read the file"),
    }
}

fn guess_mime(p: &std::path::Path) -> String {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "exe" => "application/x-msdownload",
        "dll" => "application/x-msdownload",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
    .to_string()
}
