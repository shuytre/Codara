//! 错误码表（唯一来源，与 shared/src/envelope.ts ErrorCode 对齐）。
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL: i64 = -32603;

pub const PATH_ESCAPED: i64 = 1001;
pub const BASELINE_MISMATCH: i64 = 1002;
pub const BINARY_FILE: i64 = 1003;
pub const ENCODING_UNSUPPORTED: i64 = 1004;
pub const EDIT_ANCHOR_NOT_FOUND: i64 = 1005;
pub const EDIT_AMBIGUOUS: i64 = 1006;
pub const FILE_NOT_FOUND: i64 = 1007;

pub const TERM_SESSION_NOT_FOUND: i64 = 2001;
pub const TERM_TIMEOUT: i64 = 2002;

pub const CMD_REJECTED: i64 = 3001;
pub const CMD_OVERFLOW_BLOCKED: i64 = 3002;

pub const APPROVAL_REQUIRED: i64 = 4001;

pub const SNAPSHOT_NOT_FOUND: i64 = 5001;
pub const RESTORE_CONFLICT: i64 = 5002;

pub const SECRET_NOT_FOUND: i64 = 6001;
pub const SECRET_PLATFORM_ERROR: i64 = 6002;

pub const DB_MIGRATION_FAILED: i64 = 7001;
pub const DB_ERROR: i64 = 7002;

pub const LOCK_HELD: i64 = 9001;
pub const LOCK_STALE: i64 = 9002;
pub const CHECKPOINT_CORRUPT: i64 = 9003;

// 8xxx：索引（M5）
pub const INDEX_BUSY: i64 = 8001;
pub const SEMANTIC_DISABLED: i64 = 8002;
