//! Codara sidecar 入口：stdio 行分隔 JSON-RPC。
//!
//! 帧约束：单行 UTF-8 JSON，MAX_FRAME_BYTES 硬拒绝；大输出经治理管线落盘后只回帧内引用。
//!
//! 第 6 轮（会话并行）：请求循环改为**每请求一 worker 线程**。
//! 此前是单线程同步 dispatch —— 一个 `term.exec` 最长阻塞 300 秒，
//! 期间整个 sidecar 无法处理任何其它请求。两个会话同时跑时，后一个会话的
//! 所有工具调用（连 msg.append 这种轻量写）都排在前面那条长命令后面，
//! 表现就是「开了第二个任务，但它一动不动」。
//!
//! 并发模型：
//!   - 主线程只负责读帧与派发，绝不执行请求体；
//!   - 每个请求 spawn 一个 worker，`AppState` 以 `Arc` 共享（内部可变，见 state.rs）；
//!   - 响应由**独立写线程**串行写 stdout —— JSON-RPC 允许响应乱序（靠 id 配对），
//!     但同一行绝不能被两个线程交错写坏，所以输出必须单点串行；
//!   - 有副作用的方法抢一把 workspace 级写锁（`dispatch::is_exclusive`），
//!     只读方法自由并发。
//!
//! 为什么副作用必须串行：两个会话同时改同一个工作区、同时跑 git，是会真出事的
//! （快照半写、git index.lock 冲突、命令互相污染 cwd）。真正需要并发的
//! 「读文件 / 搜索 / 列会话」这类只读操作不受此限 —— 那才是会话并行的收益所在。
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, RwLock};
use std::thread;

use codara_sidecar::rpc::envelope::{Envelope, RpcRequest, MAX_FRAME_BYTES};
use codara_sidecar::{dispatch, state::AppState};

fn main() {
    let stdin = io::stdin();
    let state = Arc::new(AppState::new());
    // workspace 级排他锁：只读请求不碰它；副作用请求持写锁跑完整个请求体
    let exclusive = Arc::new(RwLock::new(()));

    // 单一写线程：保证每个响应帧完整落盘（不与其它响应交错）
    let (tx, rx): (Sender<String>, Receiver<String>) = mpsc::channel();
    thread::spawn(move || {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        for frame in rx {
            if out.write_all(frame.as_bytes()).is_err() {
                break; // 主进程已退出：reader 结束，写线程随之退出
            }
            if out.write_all(b"\n").is_err() {
                break;
            }
            let _ = out.flush();
        }
    });

    // 在飞 worker：stdin 关闭（主进程退出）时等它们收尾，避免响应被截断
    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();

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
            let resp = Envelope::err(
                codara_sidecar::rpc::error::INVALID_REQUEST,
                format!("frame exceeds {} bytes", MAX_FRAME_BYTES),
            );
            let _ = tx.send(
                serde_json::json!({ "jsonrpc": "2.0", "id": -1, "result": resp }).to_string(),
            );
            continue;
        }
        match serde_json::from_str::<RpcRequest>(&line) {
            Ok(req) => {
                let id = req.id;
                let needs_lock = dispatch::is_exclusive(&req.method);
                let st = Arc::clone(&state);
                let lk = Arc::clone(&exclusive);
                let wtx = tx.clone();
                workers.push(thread::spawn(move || {
                    // 副作用请求持写锁跑完整个请求体；只读请求不取锁
                    let _guard = if needs_lock {
                        Some(lk.write().unwrap_or_else(|e| e.into_inner()))
                    } else {
                        None
                    };
                    let response = dispatch::dispatch(&st, req);
                    let frame =
                        serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": response })
                            .to_string();
                    let _ = wtx.send(frame);
                }));
            }
            Err(e) => {
                // ⚠️ 错误消息里绝不能回灌原始帧内容：输入可能含 API Key、
                // 大段源码或用户隐私。serde 的错误信息只含行列号与成因，够定位。
                let resp =
                    Envelope::err(codara_sidecar::rpc::error::PARSE_ERROR, format!("parse error: {}", e));
                let _ = tx.send(
                    serde_json::json!({ "jsonrpc": "2.0", "id": -1, "result": resp }).to_string(),
                );
            }
        }

        // 回收已结束的 worker 句柄（不阻塞：响应已由 worker 自己发出），
        // 只为避免句柄数组无限增长。
        if workers.len() > 64 {
            let mut i = 0;
            while i < workers.len() {
                if workers[i].is_finished() {
                    let h = workers.swap_remove(i);
                    let _ = h.join();
                } else {
                    i += 1;
                }
            }
        }

        if state.shutdown_requested() {
            break;
        }
    }

    // stdin 关闭：等在飞请求收尾，保证响应都已发出（不丢尾巴）
    for h in workers {
        let _ = h.join();
    }
    drop(tx); // 关闭通道，写线程自然退出
}
