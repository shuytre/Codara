//! 方法路由：method → 模块处理函数。
use serde_json::{json, Value};

use crate::rpc::envelope::{Envelope, RpcRequest};
use crate::rpc::error;
use crate::state::AppState;

pub fn dispatch(state: &mut AppState, req: RpcRequest) -> Envelope {
    let params = req.params;
    match req.method.as_str() {
        // ---- 协议 ----
        "initialize" => init(state, params),
        "ping" => Envelope::ok(json!({ "pong": true, "platform": state.platform })),
        "shutdown" => {
            state.shutdown_requested = true;
            Envelope::ok(json!({ "bye": true }))
        }
        // ---- fs ----
        "fs.read" => crate::fsops::read::fs_read(state, params),
        "fs.patch" => crate::fsops::patch::fs_patch(state, params),
        "fs.meta" => crate::fsops::read::fs_meta(state, params),
        // ---- search ----
        "search.run" => crate::search::grep::search_run(state, params),
        // ---- index（M5） ----
        "index.build" => crate::index::index_build(state, params),
        "index.status" => crate::index::index_status(state, params),
        "index.pause" => crate::index::index_pause(state, params),
        "index.resume" => crate::index::index_resume(state, params),
        "index.configure" => crate::index::index_configure(state, params),
        "index.symbols" => crate::index::index_symbols(state, params),
        "index.semantic" => crate::index::index_semantic(state, params),
        // ---- terminal ----
        "term.open" => crate::terminal::session::term_open(state, params),
        "term.exec" => crate::terminal::session::term_exec(state, params),
        "term.close" => crate::terminal::session::term_close(state, params),
        // ---- governance ----
        "gov.validate" => crate::governance::cmd_rules::gov_validate(params),
        // ---- git ----
        "git.exec" => crate::gitops::git::git_exec(state, params),
        // ---- snapshot ----
        "snap.create" => crate::snapshot::snap_create(state, params),
        "snap.list" => crate::snapshot::snap_list(state, params),
        "snap.restore" => crate::snapshot::snap_restore(state, params),
        // ---- cache ----
        "cache.resolve" => crate::fsops::read::cache_resolve(state, params),
        // ---- secret ----
        "secret.set" => crate::secret::secret_set(params),
        "secret.get" => crate::secret::secret_get(params),
        "secret.delete" => crate::secret::secret_delete(params),
        // ---- db ----
        "db.migrate" => crate::db::db_migrate(state, params),
        "db.query" => crate::db::db_query(state, params),
        "db.exec" => crate::db::db_exec(state, params),
        // ---- sessions（M3 会话隔离） ----
        "session.create" => crate::db::sessions::session_create(state, params),
        "msg.append" => crate::db::sessions::msg_append(state, params),
        "msg.list" => crate::db::sessions::msg_list(state, params),
        // ---- audit ----
        "audit.note" => crate::audit::rotating::audit_note(state, params),
        // ---- checkpoint / lock（M4） ----
        "ckpt.write" => crate::ckpt::checkpoint::ckpt_write(state, params),
        "ckpt.list" => crate::ckpt::checkpoint::ckpt_list(state, params),
        "ckpt.load" => crate::ckpt::checkpoint::ckpt_load(state, params),
        "lock.acquire" => crate::ckpt::lock::lock_acquire(state, params),
        "lock.heartbeat" => crate::ckpt::lock::lock_heartbeat(state, params),
        "lock.release" => crate::ckpt::lock::lock_release(state, params),
        "lock.inspect" => crate::ckpt::lock::lock_inspect(state, params),
        _ => Envelope::err(error::METHOD_NOT_FOUND, format!("unknown method: {}", req.method)),
    }
}

fn init(state: &mut AppState, params: Value) -> Envelope {
    let workspace = params
        .get("workspaceRoot")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let app_data = params
        .get("appDataDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let git_path = params.get("gitPath").and_then(|v| v.as_str()).map(|s| s.to_string());

    if let Some(ws) = workspace {
        state.workspace_root = Some(crate::state::normalize(&std::path::PathBuf::from(&ws)));
    }
    if let Some(ad) = app_data {
        state.app_data_dir = std::path::PathBuf::from(ad);
        let _ = std::fs::create_dir_all(&state.app_data_dir);
        let _ = std::fs::create_dir_all(state.tasks_dir());
        let _ = std::fs::create_dir_all(state.tmp_dir());
    }
    if let Some(gp) = git_path {
        state.git_path = gp;
    }
    state.initialized = true;
    Envelope::ok(json!({
        "protocol": 1,
        "platform": state.platform,
        "capabilities": {
            "fs": true, "search": true, "terminal": true, "git": true,
            "snapshot": true, "secret": true, "db": true, "audit": true,
            "checkpoint": true, "dpapi": state.platform == "windows",
        }
    }))
}
