//! 凭据：Windows DPAPI（CryptProtectData / CryptUnprotectData，按当前用户）；
//! 非 Windows 开发平台 mock 实现（base64 + 显式标注，仅开发用，禁止当安全边界）。
use serde_json::{json, Value};

use crate::rpc::envelope::Envelope;
use crate::rpc::error;

#[cfg(windows)]
mod imp {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn protect(plain: &str) -> Result<Vec<u8>, String> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: plain.len() as u32,
                pbData: plain.as_ptr() as *mut u8,
            };
            let mut out_blob = CRYPT_INTEGER_BLOB::default();
            let hr = CryptProtectData(
                &in_blob,
                PCWSTR::null(),
                None, // pOptionalEntropy
                None, // pvReserved
                None, // pPromptStruct
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            );
            if hr.is_err() {
                return Err("CryptProtectData failed".into());
            }
            Ok(std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec())
        }
    }

    pub fn unprotect(cipher: &[u8]) -> Result<String, String> {
        unsafe {
            let in_blob = CRYPT_INTEGER_BLOB {
                cbData: cipher.len() as u32,
                pbData: cipher.as_ptr() as *mut u8,
            };
            let mut out_blob = CRYPT_INTEGER_BLOB::default();
            let hr = CryptUnprotectData(
                &in_blob,
                None, // ppszDataDescr
                None, // pOptionalEntropy
                None, // pvReserved
                None, // pPromptStruct
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            );
            if hr.is_err() {
                return Err("CryptUnprotectData failed".into());
            }
            let bytes = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            Ok(String::from_utf8_lossy(&bytes).to_string())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn protect(plain: &str) -> Result<Vec<u8>, String> {
        // 开发平台 mock：base64 标注编码。不是加密！仅限非 Windows 开发环境。
        Ok(format!("MOCKDPAPI:{}", plain).into_bytes())
    }
    pub fn unprotect(cipher: &[u8]) -> Result<String, String> {
        let s = String::from_utf8_lossy(cipher).to_string();
        s.strip_prefix("MOCKDPAPI:")
            .map(String::from)
            .ok_or_else(|| "not a mock dpapi blob".into())
    }
}

fn key_path(app_data: &std::path::Path, name: &str) -> std::path::PathBuf {
    app_data.join("secrets").join(format!("{}.key", name))
}

/// 由外部输入构造文件名的通用白名单：禁止路径分隔符与 `..`，
/// 只允许 [A-Za-z0-9_.-]。secret.name / ckpt.taskId 等一律先过这一关。
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn secret_root() -> Option<(std::path::PathBuf,)> {
    // 依赖 initialize 的 appDataDir；由调用方传入 params.appDataDir
    None
}

pub fn secret_set(params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let value = match params.get("value").and_then(|v| v.as_str()) {
        Some(v) => v.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "value is required"),
    };
    let app_data = params
        .get("appDataDir")
        .and_then(|v| v.as_str())
        .map(std::path::PathBuf::from);
    let app_data = match app_data {
        Some(a) => a,
        None => return missing_app_dir(),
    };
    // name 直接拼进文件名，不做净化即可用 `../../..` 穿越到 appDataDir 之外任意写
    if !is_safe_name(&name) {
        return Envelope::err(crate::rpc::error::INVALID_PARAMS, "invalid secret name");
    }
    match imp::protect(&value) {
        Ok(cipher) => {
            let dir = app_data.join("secrets");
            if std::fs::create_dir_all(&dir).is_err() {
                return Envelope::err(error::SECRET_PLATFORM_ERROR, "cannot create secrets dir");
            }
            if std::fs::write(key_path(&app_data, &name), &cipher).is_err() {
                return Envelope::err(error::SECRET_PLATFORM_ERROR, "cannot write secret file");
            }
            Envelope::ok(json!({ "name": name, "stored": true }))
        }
        Err(e) => Envelope::err(error::SECRET_PLATFORM_ERROR, e),
    }
}

pub fn secret_get(params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let app_data = match params.get("appDataDir").and_then(|v| v.as_str()).map(std::path::PathBuf::from) {
        Some(a) => a,
        None => return missing_app_dir(),
    };
    if !is_safe_name(&name) {
        return Envelope::err(crate::rpc::error::INVALID_PARAMS, "invalid secret name");
    }
    let p = key_path(&app_data, &name);
    match std::fs::read(&p) {
        Ok(cipher) => match imp::unprotect(&cipher) {
            Ok(plain) => Envelope::ok(json!({ "name": name, "value": plain })),
            Err(e) => Envelope::err(error::SECRET_PLATFORM_ERROR, e),
        },
        Err(_) => Envelope::err(error::SECRET_NOT_FOUND, format!("secret not found: {}", name)),
    }
}

pub fn secret_delete(params: Value) -> Envelope {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Envelope::err(crate::rpc::error::INVALID_PARAMS, "name is required"),
    };
    let app_data = match params.get("appDataDir").and_then(|v| v.as_str()).map(std::path::PathBuf::from) {
        Some(a) => a,
        None => return missing_app_dir(),
    };
    if !is_safe_name(&name) {
        return Envelope::err(crate::rpc::error::INVALID_PARAMS, "invalid secret name");
    }
    match std::fs::remove_file(key_path(&app_data, &name)) {
        Ok(_) => Envelope::ok(json!({ "name": name, "deleted": true })),
        Err(_) => Envelope::err(error::SECRET_NOT_FOUND, format!("secret not found: {}", name)),
    }
}

fn missing_app_dir() -> Envelope {
    Envelope::err(
        crate::rpc::error::INVALID_PARAMS,
        "appDataDir is required (pass at initialize or per-call)",
    )
}

#[allow(dead_code)]
fn _unused(_x: Option<(std::path::PathBuf,)>) {
    let _ = secret_root();
}
