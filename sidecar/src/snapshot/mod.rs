//! 快照模块：Git 仓库→隐藏分支快照；非 Git→内容寻址 CAS 库。统一入口在 mod_impl 语义（dispatch 调用本模块）。
pub mod cas;
pub mod gitbranch;

use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;
use crate::state::AppState;

pub fn snap_create(state: &mut AppState, params: Value) -> Envelope {
    let paths: Vec<String> = params
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let label = params.get("label").and_then(|v| v.as_str()).unwrap_or("manual");
    let task_id = params.get("taskId").and_then(|v| v.as_str()).unwrap_or("adhoc");

    if paths.is_empty() {
        return Envelope::err(error::INVALID_PARAMS, "paths is required");
    }
    let mut resolved: Vec<std::path::PathBuf> = Vec::new();
    for p in &paths {
        match state.resolve_in_workspace(p) {
            Ok(r) => resolved.push(r),
            Err(e) => return e,
        }
    }

    let in_git = state
        .workspace_root
        .as_ref()
        .map(|r| r.join(".git").exists())
        .unwrap_or(false);

    if in_git {
        gitbranch::snapshot(state, &resolved, label, task_id)
    } else {
        // 注意：不可在 match 的锁守卫存活期内重复 lock（会死锁）
        let need_init = state.cas.lock().unwrap().is_none();
        if need_init {
            let mut cas = cas::CasStore::new(state.app_data_dir.join("snapshots"));
            let r = cas.store_files(&resolved, task_id);
            *state.cas.lock().unwrap() = Some(cas);
            r
        } else {
            let mut guard = state.cas.lock().unwrap();
            guard.as_mut().unwrap().store_files(&resolved, task_id)
        }
    }
}

pub fn snap_list(state: &mut AppState, params: Value) -> Envelope {
    let task_id = params.get("taskId").and_then(|v| v.as_str());
    let in_git = state
        .workspace_root
        .as_ref()
        .map(|r| r.join(".git").exists())
        .unwrap_or(false);
    if in_git {
        gitbranch::list(state)
    } else {
        match state.cas.lock().unwrap().as_ref() {
            Some(cas) => cas.list(task_id),
            None => Envelope::ok(json!({ "snapshots": [] })),
        }
    }
}

pub fn snap_restore(state: &mut AppState, params: Value) -> Envelope {
    let snapshot_id = match params.get("snapshotId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Envelope::err(error::INVALID_PARAMS, "snapshotId is required"),
    };
    let single_file = params.get("path").and_then(|v| v.as_str()).map(String::from);
    let in_git = state
        .workspace_root
        .as_ref()
        .map(|r| r.join(".git").exists())
        .unwrap_or(false);
    if in_git {
        gitbranch::restore(state, &snapshot_id, single_file.as_deref())
    } else {
        match state.cas.lock().unwrap().as_mut() {
            Some(cas) => cas.restore(
                &snapshot_id,
                single_file.as_deref(),
                state.workspace_root.as_deref(),
            ),
            None => Envelope::err(error::SNAPSHOT_NOT_FOUND, "no snapshot store"),
        }
    }
}