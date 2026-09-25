//! Git 隐藏分支快照：codara-snapshots/<task-id> 分支树。
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

fn run_git(state: &AppState, args: &[&str]) -> (i64, String, String) {
    let workdir = state
        .workspace_root
        .clone()
        .unwrap_or_else(|| PathBuf::from("."));
    let mut cmd = Command::new(&state.git_path);
    cmd.args(args).current_dir(&workdir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.output() {
        Ok(o) => (
            o.status.code().unwrap_or(-1) as i64,
            String::from_utf8_lossy(&o.stdout).to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        ),
        Err(e) => (-1, String::new(), e.to_string()),
    }
}

/// 文件级快照：add -f 指定路径到临时索引 → 写入 codara-snapshots 分支
pub fn snapshot(state: &mut AppState, paths: &[PathBuf], label: &str, task_id: &str) -> Envelope {
    let branch = format!("refs/heads/codara-snapshots/{}", task_id);
    // 确保 HEAD 有效（空仓库则先 init）
    let (_, _, _) = run_git(state, &["rev-parse", "--is-inside-work-tree"]);
    // 提交单文件快照：使用独立索引避免污染用户索引
    let tmp_index = state.app_data_dir.join("tmp").join(format!("snap-index-{}", std::process::id()));
    let _ = std::fs::create_dir_all(tmp_index.parent().unwrap());
    let mut all_args: Vec<String> = vec![];
    for p in paths {
        all_args.push(p.display().to_string());
    }
    let env_git_index_file = tmp_index.display().to_string();

    let root = state.workspace_root.clone().unwrap_or_default();
    let rel_paths: Vec<String> = paths
        .iter()
        .filter_map(|p| p.strip_prefix(&root).ok().map(|r| r.display().to_string()))
        .collect();

    // 用 stash create + update-ref 实现：先 stage 文件，再创建 tree
    let add_status = {
        let mut cmd = Command::new(&state.git_path);
        cmd.arg("add").arg("-f").arg("--");
        for rp in &rel_paths {
            cmd.arg(rp);
        }
        cmd.env("GIT_INDEX_FILE", &env_git_index_file);
        cmd.current_dir(&root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.status()
    };
    if add_status.map(|s| !s.success()).unwrap_or(true) {
        return Envelope::err(error::INTERNAL, "snapshot git add failed");
    }
    let (code, tree_id, _) = {
        let mut cmd = Command::new(&state.git_path);
        cmd.args(["write-tree"]).env("GIT_INDEX_FILE", &env_git_index_file).current_dir(&root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        match cmd.output() {
            Ok(o) => (
                o.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&o.stdout).trim().to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
            ),
            Err(e) => (-1, String::new(), e.to_string()),
        }
    };
    if code != 0 || tree_id.is_empty() {
        return Envelope::err(error::INTERNAL, "snapshot write-tree failed");
    }
    // commit-tree：以当前 HEAD 为父
    let (pc, head_id, _) = run_git(state, &["rev-parse", "HEAD"]);
    let mut ct_args: Vec<String> = vec!["commit-tree".into(), tree_id.clone(), "-m".into(), format!("codara snapshot: {}", label)];
    if pc == 0 {
        ct_args.push("-p".into());
        ct_args.push(head_id.trim().to_string());
    }
    let (cc, commit_id, cerr) = {
        let mut cmd = Command::new(&state.git_path);
        cmd.args(&ct_args).env("GIT_INDEX_FILE", &env_git_index_file).current_dir(&root);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.output().map(|o| (
            o.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        )).unwrap_or((-1, String::new(), "spawn error".into()))
    };
    if cc != 0 {
        return Envelope::err(error::INTERNAL, format!("commit-tree failed: {}", cerr));
    }
    let (uc, _, uerr) = run_git(state, &["update-ref", &branch, &commit_id]);
    let _ = std::fs::remove_file(&tmp_index);
    if uc != 0 {
        return Envelope::err(error::INTERNAL, format!("update-ref failed: {}", uerr));
    }
    Envelope::ok(json!({
        "snapshotId": commit_id,
        "branch": branch,
        "files": rel_paths,
        "label": label,
    }))
}

pub fn list(state: &AppState) -> Envelope {
    let (code, out, _) = run_git(state, &["for-each-ref", "refs/heads/codara-snapshots", "--format=%(refname:short) %(objectname)"]);
    if code != 0 {
        return Envelope::ok(json!({ "snapshots": [] }));
    }
    let snaps: Vec<Value> = out
        .lines()
        .map(|l| {
            let mut parts = l.splitn(2, ' ');
            json!({
                "branch": parts.next().unwrap_or(""),
                "commit": parts.next().unwrap_or(""),
            })
        })
        .collect();
    Envelope::ok(json!({ "snapshots": snaps }))
}

pub fn restore(state: &mut AppState, snapshot_id: &str, single_file: Option<&str>) -> Envelope {
    let mut args: Vec<String> = vec!["checkout".into(), snapshot_id.to_string(), "--".into()];
    match single_file {
        Some(f) => args.push(f.to_string()),
        None => args.push(".".into()),
    }
    let argrefs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, out, err) = run_git(state, &argrefs);
    if code != 0 {
        return Envelope::err(error::RESTORE_CONFLICT, format!("restore failed: {}", err));
    }
    Envelope::ok(json!({
        "restored": single_file.map(|f| vec![f.to_string()]).unwrap_or_else(|| vec![".".into()]),
        "output": out,
    }))
}

#[allow(dead_code)]
fn path_exists(p: &Path) -> bool {
    p.exists()
}
