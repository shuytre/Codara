//! Sidecar RPC 信封与请求/响应类型（与 shared/src/envelope.ts 对齐）。
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 1024 * 1024; // 1MB；大输出必须先落盘

/// JSON-RPC 请求（行分隔帧）
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[serde(rename = "jsonrpc")]
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: i64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// 业务错误（code 与 shared ErrorCode 对齐）
#[derive(Debug, Clone, Serialize)]
pub struct SidecarError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// 统一业务信封
#[derive(Debug, Serialize)]
pub struct Envelope {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SidecarError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_ref: Option<String>,
    #[serde(rename = "cacheRef", skip_serializing_if = "Option::is_none")]
    pub cache_ref_camel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Envelope {
    pub fn ok(data: Value) -> Self {
        Envelope {
            ok: true,
            data: Some(data),
            error: None,
            truncated: None,
            cache_ref: None,
            cache_ref_camel: None,
            message: None,
        }
    }
    pub fn err(code: i64, message: impl Into<String>) -> Self {
        Envelope {
            ok: false,
            data: None,
            error: Some(SidecarError {
                code,
                message: message.into(),
                data: None,
            }),
            truncated: None,
            cache_ref: None,
            cache_ref_camel: None,
            message: None,
        }
    }
    pub fn err_with(code: i64, message: impl Into<String>, data: Value) -> Self {
        Envelope {
            ok: false,
            data: None,
            error: Some(SidecarError {
                code,
                message: message.into(),
                data: Some(data),
            }),
            truncated: None,
            cache_ref: None,
            cache_ref_camel: None,
            message: None,
        }
    }
    pub fn truncated(mut self, msg: impl Into<String>) -> Self {
        self.truncated = Some(true);
        self.message = Some(msg.into());
        self
    }
    pub fn cache_ref(mut self, r: impl Into<String>) -> Self {
        let s = r.into();
        self.cache_ref_camel = Some(s.clone());
        self.cache_ref = Some(s);
        self
    }
}

/// sidecar → 主进程事件通知
#[derive(Debug, Serialize)]
pub struct RpcNotification {
    pub jsonrpc: &'static str,
    pub method: &'static str,
    pub params: NotificationParams,
}

#[derive(Debug, Serialize)]
pub struct NotificationParams {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<i64>,
    #[serde(rename = "callId", skip_serializing_if = "Option::is_none")]
    pub call_id_camel: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcNotification {
    pub fn new(event: &str, call_id: Option<i64>, data: Value) -> Self {
        RpcNotification {
            jsonrpc: "2.0",
            method: "event",
            params: NotificationParams {
                event: event.to_string(),
                call_id,
                call_id_camel: call_id,
                data: Some(data),
            },
        }
    }
}
