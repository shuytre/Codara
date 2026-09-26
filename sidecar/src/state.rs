//! 全局状态：工作区、读缓存、终端会话、DB 连接、审计器、快照库。
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

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
    pub workspace_root: Option<PathBuf>,
    pub app_data_dir: PathBuf, // .codara 目录
    pub read_cache: Mutex<HashMap<String, ReadCache>>,
    pub sessions: SessionTable,
    pub db: Mutex<Option<Database>>,
    pub cas: Mutex<Option<CasStore>>,
    /// M5 代码索引（独立 SQLite，懒创建；None=未开库）
    pub index: Mutex<Option<IndexState>>,
    pub git_path: String,
    pub platform: String,
    pub initialized: bool,
    pub shutdown_requested: bool,
    /// 下一次输出的缓存 id（治理管线落盘后登记）
    pub spill_counter: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            workspace_root: None,
            app_data_dir: PathBuf::from(".codara"),
            read_cache: Mutex::new(HashMap::new()),
            sessions: SessionTable::new(),
            db: Mutex::new(None),
            cas: Mutex::new(None),
            index: Mutex::new(None),
            git_path: "git".to_string(),
            platform: std::env::consts::OS.to_string(),
            initialized: false,
            shutdown_requested: false,
            spill_counter: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// 解析工作区内相对路径并做逃逸校验（.. / 绝对路径越界）
    pub fn resolve_in_workspace(&self, p: &str) -> Result<PathBuf, crate::rpc::envelope::Envelope> {
        use crate::rpc::error;
        let root = self
            .workspace_root
            .clone()
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
        self.app_data_dir.join("tasks")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.app_data_dir.join("tmp")
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
