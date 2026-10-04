//! 方法路由：method → 模块处理函数。
//!
//! 第 6 轮（会话并行）：新增 `is_exclusive`，声明哪些方法会改动工作区。
//! 请求循环据此决定「是否抢 workspace 级写锁」—— 读方法自由并发，
//! 副作用方法串行。这是 sidecar 并行安全的**唯一**策略入口，
//! 新增方法时必须同步在这里登记，漏登记的后果是并发写冲突（快照半写、git 锁冲突）。
use serde_json::{json, Value};

use crate::rpc::envelope::{Envelope, RpcRequest};
use crate::rpc::error;
use crate::state::AppState;

/// 该方法是否会改动工作区 / 外部状态（需要 workspace 级排他锁）。
///
/// 判定原则：**任何写都必须声明为排他**。宁可少一点并行（把只读误判成排他，
/// 性能回退但不损坏），也不能把写误判成可并发（文件互相覆盖、快照损坏）。
/// 纯只读方法：fs.read / fs.meta / search.run / cache.resolve / session.list /
/// msg.list / db.query / snap.list / ckpt.list / ckpt.load / lock.inspect / index.status。
pub fn is_exclusive(method: &str) -> bool {
    exclusive_kind(method).unwrap_or(true)
}

/// 方法的排他分类：`Some(false)` 只读可并发，`Some(true)` 写需串行，
/// `None` 表示**未登记**。
///
/// 为什么要返回 `Option` 而不是直接 bool：默认分支返回 `true` 会让「漏登记」
/// 完全静默——新增一个 `fs.write` 忘了登记，并发写冲突就上线了。返回 `None`
/// 后，`every_dispatch_arm_is_classified` 测试可以扫源码发现漏登记。
pub fn exclusive_kind(method: &str) -> Option<bool> {
    match method {
        // 只读
        "ping" | "fs.read" | "fs.meta" | "search.run" | "cache.resolve"
        | "session.list" | "msg.list" | "db.query" | "snap.list" | "ckpt.list"
        | "ckpt.load" | "lock.inspect" | "index.status" | "index.symbols" => Some(false),
        // 写 / 外部副作用 —— 显式列举，不用「默认 true」：
        // 这样新增方法若忘记归类，review 能一眼看出来（不在两张表里）
        "initialize" | "shutdown" | "fs.patch" | "term.open" | "term.exec"
        | "term.close" | "git.exec" | "snap.create" | "snap.restore" | "secret.set"
        | "secret.get" | "secret.delete" | "db.migrate" | "db.exec" | "session.create"
        | "session.rename" | "session.delete" | "msg.append" | "audit.note"
        | "ckpt.write" | "lock.acquire" | "lock.heartbeat" | "lock.release"
        | "index.build" | "index.pause" | "index.resume" | "index.configure"
        | "index.semantic" | "gov.validate" => Some(true),
        _ => None,
    }
}

pub fn dispatch(state: &AppState, req: RpcRequest) -> Envelope {
    let params = req.params;
    match req.method.as_str() {
        // ---- 协议 ----
        "initialize" => init(state, params),
        "ping" => Envelope::ok(json!({ "pong": true, "platform": state.platform })),
        "shutdown" => {
            state.request_shutdown();
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
        "session.list" => crate::db::sessions::session_list(state, params),
        "session.rename" => crate::db::sessions::session_rename(state, params),
        "session.delete" => crate::db::sessions::session_delete(state, params),
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

fn init(state: &AppState, params: Value) -> Envelope {
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
        state.set_workspace_root(crate::state::normalize(&std::path::PathBuf::from(&ws)));
    }
    if let Some(ad) = app_data {
        let dir = std::path::PathBuf::from(ad);
        let _ = std::fs::create_dir_all(&dir);
        state.set_app_data_dir(dir);
        let _ = std::fs::create_dir_all(state.tasks_dir());
        let _ = std::fs::create_dir_all(state.tmp_dir());
    }
    if let Some(gp) = git_path {
        state.set_git_path(gp);
    }
    state.set_initialized(true);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 从 `dispatch` 的 match 分支里抠出方法名。
    ///
    /// 靠源码文本扫描（而非手抄一份列表）来发现「新方法忘了登记排他分类」：
    /// 手抄的清单会随着 dispatch 增长而腐化，扫描不会。
    fn dispatched_methods() -> Vec<String> {
        let src = include_str!("dispatch.rs");
        let body = src
            .split_once("pub fn dispatch(")
            .expect("dispatch fn")
            .1
            // 到下一个顶层 `fn ` 定义为止，即 dispatch 的函数体
            .split_once("\nfn ")
            .map(|(b, _)| b)
            .unwrap_or_else(|| src);
        let mut out = Vec::new();
        for line in body.lines() {
            let line = line.trim();
            // 只看 match arm：`"name" => ...` 或 `"a" | "b" => ...`
            if !line.starts_with('"') || !line.contains("=>") {
                continue;
            }
            for part in line.split('|') {
                let name = part
                    .trim()
                    .trim_start_matches('"')
                    .split('"')
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
        out
    }

    #[test]
    fn every_dispatch_arm_is_classified() {
        let methods = dispatched_methods();
        assert!(
            methods.len() >= 40,
            "源码扫描只捞到 {} 个方法，正则大概失效了",
            methods.len()
        );
        let unclassified: Vec<&String> = methods
            .iter()
            .filter(|m| exclusive_kind(m).is_none())
            .collect();
        assert!(
            unclassified.is_empty(),
            "这些方法在 dispatch 里存在，但 is_exclusive 未登记分类（会被默认当排他，\
             并行度白白丢失）：{:?}",
            unclassified
        );
    }

    #[test]
    fn classification_has_no_duplicates() {
        let mut sorted = dispatched_methods();
        let total = sorted.len();
        sorted.sort();
        sorted.dedup();
        assert_eq!(total, sorted.len(), "dispatch match 分支里有重复方法名");
    }

    #[test]
    fn unknown_method_defaults_to_exclusive() {
        // 未知方法拿不到写锁之外的豁免：宁可少并行，不可并发写
        assert_eq!(exclusive_kind("does.not.exist"), None);
        assert!(is_exclusive("does.not.exist"));
    }

    #[test]
    fn read_only_methods_are_concurrent() {
        for m in [
            "ping",
            "fs.read",
            "fs.meta",
            "search.run",
            "cache.resolve",
            "session.list",
            "msg.list",
            "db.query",
            "snap.list",
            "ckpt.list",
            "ckpt.load",
            "lock.inspect",
            "index.status",
            "index.symbols",
        ] {
            assert_eq!(exclusive_kind(m), Some(false), "{} 应为只读可并发", m);
        }
    }

    #[test]
    fn workspace_mutating_methods_are_exclusive() {
        for m in [
            "initialize",
            "shutdown",
            "fs.patch",
            "term.open",
            "term.exec",
            "term.close",
            "git.exec",
            "snap.create",
            "snap.restore",
            "secret.set",
            "secret.get",
            "secret.delete",
            "db.migrate",
            "db.exec",
            "session.create",
            "session.rename",
            "session.delete",
            "msg.append",
            "audit.note",
            "ckpt.write",
            "lock.acquire",
            "lock.heartbeat",
            "lock.release",
            "index.build",
            "index.pause",
            "index.resume",
            "index.configure",
            "index.semantic",
            "gov.validate",
        ] {
            assert_eq!(exclusive_kind(m), Some(true), "{} 应为排他写", m);
        }
    }
}
