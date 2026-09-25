//! git 工具：只读组 auto；写组需批准（approvalToken，M4 网关颁发）。
//! 调用随包 MinGit（git_path 可配）；worktree 命名 codara/<task-id>-<role>。
use std::process::Command;

use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

const READONLY_OPS: &[&str] = &[
    "status", "diff", "log", "show", "branch", "worktree-list",
];
const WRITE_OPS: &[&str] = &[
    "commit", "branch-create", "worktree-create", "worktree-remove", "revert",
];

pub fn git_exec(state: &mut AppState, params: Value) -> Envelope {
    let op = match params.get("op").and_then(|v| v.as_str()) {
        Some(o) => o.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "op is required"),
    };
    let args: Value = params.get("args").cloned().unwrap_or(json!({}));

    if READONLY_OPS.contains(&op.as_str()) {
        return run_git_op(state, &op, &args);
    }
    if WRITE_OPS.contains(&op.as_str()) {
        // 写 op：需要 approvalToken（M4 网关在审批通过后颁发；Goal 预授权自动通过）
        // 兼容两种传参：顶层或 args 内
        let token = params
            .get("approvalToken")
            .or_else(|| args.get("approvalToken"))
            .and_then(|v| v.as_str());
        let auto = params
            .get("preAuthorized")
            .or_else(|| args.get("preAuthorized"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if token.is_none() && !auto {
            return Envelope::err_with(
                error::APPROVAL_REQUIRED,
                format!("git op `{}` requires approval", op),
                json!({ "reason": "git write operation", "risk": "medium", "op": op }),
            );
        }
        return run_git_op(state, &op, &args);
    }
    Envelope::err(error::INVALID_PARAMS, format!("unknown git op: {}", op))
}

fn run_git_op(state: &mut AppState, op: &str, args: &Value) -> Envelope {
    let workdir = state
        .workspace_root
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut cmd = Command::new(&state.git_path);
    let mut argv: Vec<String> = Vec::new();

    match op {
        "status" => argv.extend(vec!["status".into(), "--porcelain=v1".into(), "-b".into()]),
        "diff" => {
            let staged = args.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
            argv.push("diff".into());
            if staged {
                argv.push("--staged".into());
            }
            if let Some(f) = args.get("path").and_then(|v| v.as_str()) {
                argv.push(f.into());
            }
        }
        "log" => {
            let n = args.get("maxCount").and_then(|v| v.as_u64()).unwrap_or(20);
            argv.extend(vec![
                "log".into(),
                format!("-{}", n),
                "--pretty=format:%h %ad %s".into(),
                "--date=short".into(),
            ]);
        }
        "show" => {
            let r = args.get("rev").and_then(|v| v.as_str()).unwrap_or("HEAD");
            argv.extend(vec!["show".into(), r.to_string()]);
        }
        "branch" => argv.extend(vec!["branch".into(), "-a".into()]),
        "worktree-list" => argv.extend(vec!["worktree".into(), "list".into(), "--porcelain".into()]),
        "commit" => {
            let msg = match args.get("message").and_then(|v| v.as_str()) {
                Some(m) => m,
                None => return Envelope::err(error::INVALID_PARAMS, "commit message is required"),
            };
            if !msg.contains("[") || !msg.contains("]") {
                // commit 信息必须含任务 ID（规格 3.4.4）
                return Envelope::err(
                    error::INVALID_PARAMS,
                    "commit message must contain task id in [brackets]",
                );
            }
            argv.extend(vec!["commit".into(), "-m".into(), msg.to_string()]);
            if let Some(all) = args.get("all").and_then(|v| v.as_bool()) {
                if all {
                    argv.push("-a".into());
                }
            }
        }
        "branch-create" => {
            let name = match args.get("name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => return Envelope::err(error::INVALID_PARAMS, "branch name is required"),
            };
            argv.extend(vec!["branch".into(), name.to_string()]);
        }
        "worktree-create" => {
            let name = match args.get("name").and_then(|v| v.as_str()) {
                Some(n) => n.to_string(),
                None => return Envelope::err(error::INVALID_PARAMS, "worktree name is required"),
            };
            let branch = format!("codara/{}", name); // codara/<task-id>-<role>
            // 放工作区内 .codara/worktrees/（避免污染上级目录、可重复执行）；-B 强制复用分支
            let path = workdir.join(".codara").join("worktrees").join(&name);
            let _ = std::fs::create_dir_all(path.parent().unwrap_or(&workdir));
            argv.extend(vec![
                "worktree".into(),
                "add".into(),
                "-B".into(),
                branch,
                path.display().to_string(),
            ]);
        }
        "worktree-remove" => {
            let name = match args.get("name").and_then(|v| v.as_str()) {
                Some(n) => n.to_string(),
                None => return Envelope::err(error::INVALID_PARAMS, "worktree name is required"),
            };
            argv.extend(vec!["worktree".into(), "remove".into(), name]);
        }
        "revert" => {
            let r = args.get("rev").and_then(|v| v.as_str()).unwrap_or("HEAD");
            argv.extend(vec!["revert".into(), "--no-edit".into(), r.to_string()]);
        }
        _ => return Envelope::err(error::INVALID_PARAMS, format!("unknown op: {}", op)),
    }

    cmd.args(&argv).current_dir(&workdir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => return Envelope::err(error::INTERNAL, format!("git spawn failed: {}", e)),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);
    let mut data = json!({ "op": op, "exitCode": code, "output": stdout, "stderr": stderr });
    if code == 0 {
        Envelope::ok(data)
    } else {
        data["output"] = json!(stdout);
        Envelope::err_with(error::INTERNAL, format!("git {} failed (exit {})", op, code), data)
    }
}
