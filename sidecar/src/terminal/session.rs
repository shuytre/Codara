//! terminal 工具（Agent 通道）：持久会话（cwd 状态保持）、超时控制、输出治理。
//! 注意：模型输入的 command 永远是单条命令；内部 cd 包装不属于模型链式命令。
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::governance::cmd_rules;
use crate::governance::pipeline;
use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 300_000;

pub struct Session {
    pub cwd: String,
    pub created_at: Instant,
}

pub struct SessionTable {
    inner: Mutex<HashMap<String, Session>>,
    counter: AtomicU64,
}

impl SessionTable {
    pub fn new() -> Self {
        SessionTable {
            inner: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }
    pub fn insert(&self, s: Session) -> String {
        let id = format!("term-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        self.inner.lock().unwrap().insert(id.clone(), s);
        id
    }
    pub fn get(&self, id: &str) -> Option<String> {
        self.inner.lock().unwrap().get(id).map(|s| s.cwd.clone())
    }
    pub fn update_cwd(&self, id: &str, cwd: &str) {
        if let Some(s) = self.inner.lock().unwrap().get_mut(id) {
            s.cwd = cwd.to_string();
        }
    }
    pub fn remove(&self, id: &str) -> bool {
        self.inner.lock().unwrap().remove(id).is_some()
    }
}

pub fn term_open(state: &mut AppState, params: Value) -> Envelope {
    let cwd = params
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| state.workspace_root.as_ref().map(|p| p.display().to_string()))
        .unwrap_or_else(|| ".".to_string());
    let id = state.sessions.insert(Session {
        cwd,
        created_at: Instant::now(),
    });
    Envelope::ok(json!({ "sessionId": id, "shell": default_shell(&state.platform) }))
}

pub fn term_close(state: &mut AppState, params: Value) -> Envelope {
    let id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if state.sessions.remove(id) {
        Envelope::ok(json!({ "closed": true }))
    } else {
        Envelope::err(error::TERM_SESSION_NOT_FOUND, format!("session not found: {}", id))
    }
}

pub fn term_exec(state: &mut AppState, params: Value) -> Envelope {
    let command = match params.get("command").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "command is required"),
    };

    // 命令纪律校验（禁 &&/;/PS 子集）
    let v = cmd_rules::validate_command(&command, &state.platform);
    if !v.ok {
        return Envelope::err_with(v.code, v.message, json!({ "command": command }));
    }

    let (session_id, cwd) = match params.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => {
            let cwd = state.sessions.get(id).unwrap_or_else(|| {
                state
                    .workspace_root
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| ".".to_string())
            });
            (id.to_string(), cwd)
        }
        None => {
            let cwd = params
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| state.workspace_root.as_ref().map(|p| p.display().to_string()))
                .unwrap_or_else(|| ".".to_string());
            let id = state.sessions.insert(Session {
                cwd,
                created_at: Instant::now(),
            });
            (id.clone(), state.sessions.get(&id).unwrap())
        }
    };

    let timeout_ms = params
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);

    let input = params.get("input").and_then(|v| v.as_str()).map(String::from);

    // cd 命令特殊处理：更新会话 cwd
    if command.trim() == "cd" {
        return Envelope::ok(json!({ "sessionId": session_id, "exitCode": 0, "stdout": cwd, "stderr": "" }));
    }
    if let Some(rest) = command.trim().strip_prefix("cd ") {
        let new_dir = rest.trim().trim_matches('"');
        if !new_dir.is_empty() {
            let base = std::path::PathBuf::from(&cwd);
            let target = crate::state::normalize(&base.join(new_dir));
            if target.exists() && target.is_dir() {
                state.sessions.update_cwd(&session_id, &target.display().to_string());
                return Envelope::ok(json!({ "sessionId": session_id, "exitCode": 0, "stdout": target.display().to_string(), "stderr": "" }));
            } else {
                return Envelope::ok(json!({
                    "sessionId": session_id, "exitCode": 1,
                    "stdout": "", "stderr": format!("The system cannot find the path specified: {}", new_dir),
                }));
            }
        }
    }

    let started = Instant::now();
    let (exit_code, stdout, stderr) = run_shell(&state.platform, &cwd, &command, timeout_ms, input);

    // 治理管线（六步中的 1/3/4/5）
    let spill_dir = state.tmp_dir();
    let spill_writer = move |content: &str, _tag: &str| -> Option<String> {
        std::fs::create_dir_all(&spill_dir).ok()?;
        let n = state
            .spill_counter
            .fetch_add(1, Ordering::SeqCst);
        let p = spill_dir.join(format!("spill-{}-{}.out", started.elapsed().as_millis() as u64, n));
        std::fs::write(&p, content).ok()?;
        Some(p.display().to_string())
    };
    let governed = pipeline::govern(&stdout, &stderr, &spill_writer);

    let duration_ms = started.elapsed().as_millis() as u64;
    let mut data = json!({
        "sessionId": session_id,
        "exitCode": exit_code,
        "stdout": governed.stdout,
        "stderr": governed.stderr,
        "durationMs": duration_ms,
    });
    if governed.truncated {
        data["truncated"] = json!(true);
        if let Some(p) = governed.spill_path {
            data["spillPath"] = json!(p);
        }
    }
    // 退出码优先（规格 3.3.4）：非零退出（含超时 124）不是 RPC 失败，
    // 信封保持 ok=true，由 data.exitCode/stderr 承载失败信息
    Envelope::ok(data)
}

fn default_shell(platform: &str) -> &'static str {
    if platform == "windows" {
        "cmd.exe"
    } else {
        "bash"
    }
}

/// 运行单条命令（内部 shell 包装），带超时轮询
fn run_shell(
    platform: &str,
    cwd: &str,
    command: &str,
    timeout_ms: u64,
    input: Option<String>,
) -> (i32, String, String) {
    let mut cmd = if platform == "windows" {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = Command::new("bash");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (1, String::new(), format!("spawn failed: {}", e)),
    };

    if let Some(inp) = input {
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(inp.as_bytes());
            drop(stdin);
        }
    } else {
        let _ = child.stdin.take();
    }

    let pid = child.id();
    let stdout_handle = child.stdout.take().map(|s| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let mut r = BufReader::new(s);
            loop {
                match r.fill_buf() {
                    Ok(chunk) if !chunk.is_empty() => {
                        buf.push_str(&String::from_utf8_lossy(chunk));
                        let len = chunk.len();
                        r.consume(len);
                    }
                    _ => break,
                }
            }
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut r = BufReader::new(s);
            let _ = r.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).to_string()
        })
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if Instant::now() >= deadline {
                    // 超时：强杀进程树
                    kill_tree(platform, pid);
                    let _ = child.wait();
                    return (
                        124i32,
                        stdout_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default(),
                        "TIMEOUT".to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };

    let out = stdout_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let err = stderr_handle.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    (code, out, err)
}

fn kill_tree(platform: &str, pid: u32) {
    if platform == "windows" {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
    } else {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

#[cfg(windows)]
trait CreationFlags {
    fn creation_flags(&mut self, flags: u32) -> &mut Command;
}
#[cfg(windows)]
impl CreationFlags for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Command {
        use std::os::windows::process::CommandExt;
        // 完全限定调用标准库 trait，避免与本模块同名 trait 产生二义性（E0034）
        CommandExt::creation_flags(self, flags)
    }
}

#[cfg(not(windows))]
trait CreationFlags {
    fn creation_flags(&mut self, _flags: u32) -> &mut Command;
}
#[cfg(not(windows))]
impl CreationFlags for Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Command {
        self
    }
}
