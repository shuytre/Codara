//! fs.patch：唯一写通道。edits 应用（精确替换/锚点插入）、基线哈希校验、
//! 编码与换行保真（原样写回探测到的编码与 CRLF/LF）、成功后由调用方触发快照。
use std::fs;
use std::io::Write;

use serde_json::{json, Value};
use sha2::Digest;

use crate::fsops::read::{detect_encoding, split_lines, LineEnding};
use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

pub fn fs_patch(state: &mut AppState, params: Value) -> Envelope {
    let path_str = match params.get("path").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "path is required"),
    };
    let edits = match params.get("edits").and_then(|v| v.as_array()) {
        Some(a) => a.clone(),
        None => return Envelope::err(error::INVALID_PARAMS, "edits is required"),
    };
    if edits.is_empty() {
        return Envelope::err(error::INVALID_PARAMS, "edits must not be empty");
    }
    let create = params.get("create").and_then(|v| v.as_bool()).unwrap_or(false);
    let baseline_hash = params
        .get("baselineHash")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let full = match state.resolve_in_workspace(&path_str) {
        Ok(p) => p,
        Err(e) => return e,
    };

    let exists = full.exists();
    if !exists && !create {
        return Envelope::err(
            error::FILE_NOT_FOUND,
            format!("file not found; set create=true to make it: {}", path_str),
        );
    }
    if exists && create && edits.iter().any(|e| e.get("oldText").is_some()) {
        return Envelope::err(
            error::INVALID_PARAMS,
            "create=true is only for new files; existing files must be edited",
        );
    }

    let mut original_bytes: Vec<u8> = Vec::new();
    if exists {
        if let Ok(mut f) = fs::File::open(&full) {
            use std::io::Read;
            let _ = f.read_to_end(&mut original_bytes);
        }
        if crate::fsops::read::is_probably_binary(&original_bytes) {
            return Envelope::err(error::BINARY_FILE, "binary file edit is rejected");
        }
    }

    // 编码与换行探测
    let (encoding, decoded): (String, String) = if exists {
        let (enc, dec) = detect_encoding(&original_bytes);
        let text = String::from_utf8(dec).unwrap_or_default();
        (enc.to_string(), text)
    } else {
        ("utf-8".to_string(), String::new())
    };
    let ending: LineEnding = if decoded.contains("\r\n") || (exists && original_bytes.windows(2).any(|w| w == b"\r\n")) {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };

    // 基线哈希校验（防过期补丁）
    if exists {
        let mut hasher = sha2::Sha256::new();
        hasher.update(&original_bytes);
        let current = hex::encode(sha2::Sha256::digest(&original_bytes));
        if let Some(bh) = &baseline_hash {
            if bh != &current {
                return Envelope::err_with(
                    error::BASELINE_MISMATCH,
                    "file changed since last read; re-read and retry",
                    json!({ "currentHash": current }),
                );
            }
        }
        let _ = hasher;
    }

    let (mut lines, trailing_newline) = if !exists {
        // create 模式：所有 edit 的 newText 顺序拼接为初始内容（不匹配 oldText）
        let mut content = String::new();
        for edit in &edits {
            if let Some(n) = edit.get("newText").and_then(|v| v.as_str()) {
                content.push_str(n);
            }
        }
        let ends_nl = content.ends_with('\n');
        (split_lines(content.as_bytes()).0, ends_nl)
    } else {
        (split_lines(decoded.as_bytes()).0, decoded.ends_with('\n'))
    };

    // 逐个 edit 应用
    // 新建文件（!exists）时内容已在上方由 newText 顺序拼接完成，
    // 此时 edits 通常只含 newText、不含锚点，必须跳过校验循环，否则误报
    // "edit must contain oldText|insertAfter|insertBefore"。
    if exists {
    for edit in &edits {
        if let Some(old) = edit.get("oldText").and_then(|v| v.as_str()) {
            let new = edit.get("newText").and_then(|v| v.as_str()).unwrap_or("");
            let old_lines: Vec<String> = split_lines(old.as_bytes()).0;
            let new_lines: Vec<String> = split_lines(new.as_bytes()).0;
            let matches: Vec<usize> = find_subsequence(&lines, &old_lines);
            match matches.len() {
                0 => {
                    return Envelope::err(
                        error::EDIT_ANCHOR_NOT_FOUND,
                        format!("oldText not found in {}", path_str),
                    )
                }
                1 => {
                    let idx = matches[0];
                    lines.splice(idx..idx + old_lines.len(), new_lines);
                }
                _ => {
                    return Envelope::err_with(
                        error::EDIT_AMBIGUOUS,
                        format!("oldText matches {} locations; provide more context", matches.len()),
                        json!({ "matches": matches.iter().map(|m| m + 1).collect::<Vec<_>>() }),
                    )
                }
            }
        } else if let Some(anchor) = edit.get("insertAfter").and_then(|v| v.as_str()) {
            let new_lines: Vec<String> =
                split_lines(edit.get("newText").and_then(|v| v.as_str()).unwrap_or("").as_bytes()).0;
            let anchor_lines: Vec<String> = split_lines(anchor.as_bytes()).0;
            let matches = find_subsequence(&lines, &anchor_lines);
            match matches.len() {
                0 => {
                    return Envelope::err(
                        error::EDIT_ANCHOR_NOT_FOUND,
                        format!("insertAfter anchor not found in {}", path_str),
                    )
                }
                1 => {
                    let idx = matches[0] + anchor_lines.len();
                    let _ = idx;
                    let at = matches[0];
                    let end = at + anchor_lines.len();
                    lines.splice(end..end, new_lines);
                }
                _ => {
                    return Envelope::err(error::EDIT_AMBIGUOUS, "insertAfter anchor is ambiguous")
                }
            }
        } else if let Some(anchor) = edit.get("insertBefore").and_then(|v| v.as_str()) {
            let new_lines: Vec<String> =
                split_lines(edit.get("newText").and_then(|v| v.as_str()).unwrap_or("").as_bytes()).0;
            let anchor_lines: Vec<String> = split_lines(anchor.as_bytes()).0;
            let matches = find_subsequence(&lines, &anchor_lines);
            match matches.len() {
                0 => {
                    return Envelope::err(
                        error::EDIT_ANCHOR_NOT_FOUND,
                        format!("insertBefore anchor not found in {}", path_str),
                    )
                }
                1 => {
                    let at = matches[0];
                    lines.splice(at..at, new_lines);
                }
                _ => {
                    return Envelope::err(error::EDIT_AMBIGUOUS, "insertBefore anchor is ambiguous")
                }
            }
        } else {
            return Envelope::err(error::INVALID_PARAMS, "edit must contain oldText|insertAfter|insertBefore");
        }
    }
    }

    // 组装输出：保真换行 + 末尾换行 + 编码
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        out.push_str(l);
        if i + 1 < lines.len() || trailing_newline {
            match ending {
                LineEnding::Crlf => out.push_str("\r\n"),
                LineEnding::Lf => out.push('\n'),
            }
        }
    }
    let out_bytes: Vec<u8> = match encoding.as_str() {
        "gb18030" => encoding_rs::GB18030.encode(&out).0.to_vec(),
        "utf-8-bom" => {
            let mut b = vec![0xEF, 0xBB, 0xBF];
            b.extend_from_slice(out.as_bytes());
            b
        }
        _ => out.into_bytes(), // utf-8
    };

    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut f = match fs::File::create(&full) {
        Ok(f) => f,
        Err(e) => return Envelope::err(error::INTERNAL, format!("write failed: {}", e)),
    };
    if let Err(e) = f.write_all(&out_bytes) {
        return Envelope::err(error::INTERNAL, format!("write failed: {}", e));
    }

    let mut hasher = sha2::Sha256::new();
    hasher.update(&out_bytes);
    let new_hash = hex::encode(hasher.finalize());

    // 失效该文件读缓存
    {
        let mut cache = state.read_cache.lock().unwrap();
        cache.retain(|k, _| !k.starts_with(&format!("{}:", path_str)));
    }

    Envelope::ok(json!({
        "path": path_str,
        "bytesWritten": out_bytes.len(),
        "encoding": encoding,
        "lineEnding": if ending == LineEnding::Crlf { "crlf" } else { "lf" },
        "newHash": new_hash,
        "editsApplied": edits.len(),
    }))
}

/// 在 lines 中找 sub 的所有起始下标
fn find_subsequence(haystack: &[String], needle: &[String]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..=(haystack.len() - needle.len()) {
        if &haystack[i..i + needle.len()] == needle {
            out.push(i);
        }
    }
    out
}
