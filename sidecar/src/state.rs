//! 全局状态：工作区、读缓存、终端会话、DB 连接、审计器、快照库。
//!
//! 第 6 轮（会话并行）：`AppState` 必须可跨线程共享 —— 请求循环改为
//! 「每请求一 worker 线程」后，多个会话的工具调用会真正并发进入 dispatch。
//! 因此原先的裸字段改为**内部可变**（RwLock / AtomicBool），且 dispatch 与各模块
//! 处理函数一律只拿 `&AppState`：
//!   - 保留 `&AppState` 等于给整个 sidecar 加一把全局大锁，并行度归零，
//!     改了等于没改；
//!   - 真正需要互斥的热点（DB / 快照库 / 索引 / 读缓存）本来就各自有 Mutex，
//!     粒度比全局锁细得多。
//!
//! 并发安全边界在**方法级**（见 main.rs 的 write_lock）：
//!   - 只读方法（fs.read / search.run / msg.list / db.query …）可自由并发；
//!   - 有副作用的方法（fs.patch / term.exec / git.exec / snap.* / db.exec …）
//!     由请求循环用一把 workspace 级写锁串行化 —— 两个会话同时改同一个工作区、
//!     同时跑 git，是会真出事的（快照半写、索引锁冲突、命令互相污染）。
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

use crate::db::Database;
use crate::index::IndexState;
use crate::snapshot::cas::CasStore;
use crate::terminal::session::SessionTable;

pub struct ReadCache {
    pub content_hash: String,
    pub lines: Vec<String>,
    pub encoding: String,
}

pub struct AppState {
    /// 工作区根（initialize 写入后只读）
    workspace_root: RwLock<Option<PathBuf>>,
    /// .codara 目录（同上）
    app_data_dir: RwLock<PathBuf>,
    pub read_cache: Mutex<HashMap<String, ReadCache>>,
    pub sessions: SessionTable,
    pub db: Mutex<Option<Database>>,
    pub cas: Mutex<Option<CasStore>>,
    /// M5 代码索引（独立 SQLite，懒创建；None=未开库）
    pub index: Mutex<Option<IndexState>>,
    git_path: RwLock<String>,
    /// 平台标识：进程内恒定，保持裸值（Copy，无锁成本）
    pub platform: String,
    initialized: AtomicBool,
    shutdown_requested: AtomicBool,
    /// 下一次输出的缓存 id（治理管线落盘后登记）
    pub spill_counter: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            workspace_root: RwLock::new(None),
            app_data_dir: RwLock::new(PathBuf::from(".codara")),
            read_cache: Mutex::new(HashMap::new()),
            sessions: SessionTable::new(),
            db: Mutex::new(None),
            cas: Mutex::new(None),
            index: Mutex::new(None),
            git_path: RwLock::new("git".to_string()),
            platform: std::env::consts::OS.to_string(),
            initialized: AtomicBool::new(false),
            shutdown_requested: AtomicBool::new(false),
            spill_counter: std::sync::atomic::AtomicU64::new(0),
        }
    }

    // ---------- 并发访问器（替代直接读字段） ----------

    /// 工作区根快照；未初始化返回 None
    pub fn workspace_root(&self) -> Option<PathBuf> {
        self.workspace_root.read().unwrap().clone()
    }

    /// 设置工作区根（仅 initialize）
    pub fn set_workspace_root(&self, p: PathBuf) {
        *self.workspace_root.write().unwrap() = Some(p);
    }

    /// .codara 目录快照
    pub fn app_data_dir(&self) -> PathBuf {
        self.app_data_dir.read().unwrap().clone()
    }

    /// 设置 .codara 目录（仅 initialize）
    pub fn set_app_data_dir(&self, p: PathBuf) {
        *self.app_data_dir.write().unwrap() = p;
    }

    /// git 可执行路径
    pub fn git_path(&self) -> String {
        self.git_path.read().unwrap().clone()
    }

    pub fn set_git_path(&self, p: String) {
        *self.git_path.write().unwrap() = p;
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub fn set_initialized(&self, v: bool) {
        self.initialized.store(v, Ordering::SeqCst);
    }

    pub fn shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    pub fn request_shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);
    }

    /// 解析工作区内相对路径并做逃逸校验（.. / 绝对路径越界）
    pub fn resolve_in_workspace(&self, p: &str) -> Result<PathBuf, crate::rpc::envelope::Envelope> {
        use crate::rpc::error;
        let root = self
            .workspace_root()
            .ok_or_else(|| crate::rpc::envelope::Envelope::err(error::INVALID_REQUEST, "workspace not initialized"))?;
        let path = PathBuf::from(p);
        let full = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        let norm = normalize(&full);
        if !norm.starts_with(&root) {
            return Err(crate::rpc::envelope::Envelope::err_with(
                error::PATH_ESCAPED,
                format!("path escapes workspace: {}", p),
                serde_json::json!({ "path": p }),
            ));
        }
        // 词法规范化只能挡住 `..` / 绝对路径 / UNC / `\\?\` 前缀，
        // 挡不住符号链接与目录联接：Win7 上 `mklink /J link C:\Windows\System32`
        // 不需要管理员权限，之后 fs.read/fs.patch 即可越权读写工作区外的文件。
        // 因此必须再解析真实路径做二次校验（canonicalize 要求目标存在，
        // 新建文件的场景退化为校验其父目录）。
        let root_real = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let real = fs::canonicalize(&norm).unwrap_or_else(|_| match norm.parent() {
            Some(parent) => fs::canonicalize(parent)
                .map(|pp| pp.join(norm.file_name().unwrap_or_default()))
                .unwrap_or_else(|_| norm.clone()),
            None => norm.clone(),
        });
        if !real.starts_with(&root_real) {
            return Err(crate::rpc::envelope::Envelope::err_with(
                error::PATH_ESCAPED,
                format!("path escapes workspace (resolved via link): {}", p),
                serde_json::json!({ "path": p }),
            ));
        }
        Ok(norm)
    }

    pub fn tasks_dir(&self) -> PathBuf {
        self.app_data_dir().join("tasks")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.app_data_dir().join("tmp")
    }
}

/// 词典序规范化路径（消解 . 与 ..），不依赖文件系统存在性
pub fn normalize(p: &PathBuf) -> PathBuf {
    use std::path::{Component, PathBuf as PB};
    let mut out = PB::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
