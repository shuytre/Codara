//! Codara sidecar 入口：stdio 行分隔 JSON-RPC 循环。
//! 帧约束：单行 UTF-8 JSON，MAX_FRAME_BYTES 硬拒绝；大输出经治理管线落盘后只回帧内引用。
use std::io::{self, BufRead, Write};

use codara_sidecar::rpc::envelope::{RpcRequest, MAX_FRAME_BYTES};
use codara_sidecar::{dispatch, state::AppState};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut state = AppState::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        // 帧守护：超限直接回协议错误，防帧撕裂
        if line.len() > MAX_FRAME_BYTES {
            let resp = codara_sidecar::rpc::envelope::Envelope::err(
                codara_sidecar::rpc::error::INVALID_REQUEST,
                format!("frame exceeds {} bytes", MAX_FRAME_BYTES),
            );
            write_frame(&serde_json::json!({ "jsonrpc": "2.0", "id": -1, "result": resp }).to_string());
            continue;
        }
        let req: Result<RpcRequest, _> = serde_json::from_str(&line);
        let (id, response) = match req {
            Ok(r) => {
                let id = r.id;
                (id, dispatch::dispatch(&mut state, r))
            }
            Err(e) => (
                -1,
                codara_sidecar::rpc::envelope::Envelope::err(
                    codara_sidecar::rpc::error::PARSE_ERROR,
                    format!("parse error: {}", e),
                ),
            ),
        };
        let frame = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": response });
        write_frame(&frame.to_string());
        if state.shutdown_requested {
            break;
        }
    }
}

fn write_frame(s: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(s.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
