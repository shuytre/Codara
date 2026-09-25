//! 内容寻址（CAS）快照库：非 Git 目录使用。sha256(内容) 为键，快照集=清单 JSON。
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;

pub struct CasStore {
    root: PathBuf, // .codara/snapshots
}

impl CasStore {
    pub fn new(root: PathBuf) -> Self {
        let _ = fs::create_dir_all(&root);
        let _ = fs::create_dir_all(root.join("blobs"));
        let _ = fs::create_dir_all(root.join("manifests"));
        CasStore { root }
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.root.join("blobs").join(&hash[..2]).join(hash)
    }

    fn manifest_path(&self, snap_id: &str) -> PathBuf {
        self.root.join("manifests").join(format!("{}.json", snap_id))
    }

    pub fn store_files(&mut self, paths: &[PathBuf], task_id: &str) -> Envelope {
        let mut entries: HashMap<String, Value> = HashMap::new();
        for p in paths {
            let bytes = match fs::read(p) {
                Ok(b) => b,
                Err(e) => return Envelope::err(error::INTERNAL, format!("read {} failed: {}", p.display(), e)),
            };
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let hash = hex::encode(hasher.finalize());
            let bp = self.blob_path(&hash);
            if !bp.exists() {
                if let Some(parent) = bp.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Err(e) = fs::write(&bp, &bytes) {
                    return Envelope::err(error::INTERNAL, format!("blob write failed: {}", e));
                }
            }
            entries.insert(
                p.display().to_string(),
                json!({ "hash": hash, "size": bytes.len() }),
            );
        }
        let snap_id = {
            let mut hasher = Sha256::new();
            hasher.update(serde_json::to_string(&entries).unwrap_or_default());
            let full = hex::encode(hasher.finalize());
            format!("snap-{}-{}", task_id, &full[..12])
        };
        let manifest = json!({
            "id": snap_id,
            "taskId": task_id,
            "createdAtMs": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "files": entries,
        });
        if let Err(e) = fs::write(self.manifest_path(&snap_id), manifest.to_string()) {
            return Envelope::err(error::INTERNAL, format!("manifest write failed: {}", e));
        }
        Envelope::ok(json!({ "snapshotId": snap_id, "files": entries.len() }))
    }

    pub fn list(&self, task_id: Option<&str>) -> Envelope {
        let dir = self.root.join("manifests");
        let mut snaps = Vec::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(content) = fs::read_to_string(e.path()) {
                    if let Ok(v) = serde_json::from_str::<Value>(&content) {
                        if let Some(tid) = task_id {
                            if v.get("taskId").and_then(|t| t.as_str()) != Some(tid) {
                                continue;
                            }
                        }
                        snaps.push(v);
                    }
                }
            }
        }
        Envelope::ok(json!({ "snapshots": snaps }))
    }

    pub fn restore(&mut self, snap_id: &str, single_file: Option<&str>) -> Envelope {
        let mp = self.manifest_path(snap_id);
        let content = match fs::read_to_string(&mp) {
            Ok(c) => c,
            Err(_) => return Envelope::err(error::SNAPSHOT_NOT_FOUND, format!("snapshot not found: {}", snap_id)),
        };
        let manifest: Value = serde_json::from_str(&content).unwrap_or(json!({}));
        let files = manifest.get("files").cloned().unwrap_or(json!({}));
        let mut restored = Vec::new();
        if let Some(obj) = files.as_object() {
            for (path, meta) in obj {
                if let Some(f) = single_file {
                    if f != path {
                        continue;
                    }
                }
                let hash = meta.get("hash").and_then(|h| h.as_str()).unwrap_or("");
                let bp = self.blob_path(hash);
                match fs::read(&bp) {
                    Ok(bytes) => {
                        if let Err(e) = fs::write(path, &bytes) {
                            return Envelope::err(error::RESTORE_CONFLICT, format!("restore {} failed: {}", path, e));
                        }
                        restored.push(path.clone());
                    }
                    Err(_) => {
                        return Envelope::err(error::SNAPSHOT_NOT_FOUND, format!("blob missing: {}", hash))
                    }
                }
            }
        }
        Envelope::ok(json!({ "restored": restored, "snapshotId": snap_id }))
    }
}

#[allow(dead_code)]
fn ensure_parent(p: &Path) {
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
}
