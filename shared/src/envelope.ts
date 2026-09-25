/**
 * Codara 统一信封与错误码（主进程 ↔ sidecar ↔ 渲染层共用契约）。
 * 本文件是双端唯一来源；sidecar 侧错误码语义必须与此处一致。
 */

/** sidecar 工具响应业务信封（规格 3.4 / 6.0） */
export interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  /** 业务错误（ok=false 时必带） */
  error?: SidecarError;
  /** 结果被截断（分页/搜索超限/超长落盘） */
  truncated?: boolean;
  /** 重复读取/重复命令的缓存引用，如 @cache:path:12-40 */
  cacheRef?: string;
  /** 截断提示，如「共 N 行，可用 offset 续读」 */
  message?: string;
}

export interface SidecarError {
  code: number;
  message: string;
  /** 附加数据（如审批请求的 reason/risk） */
  data?: unknown;
}

/** 错误码表（sidecar rpc/error.rs 与此对齐） */
export const ErrorCode = {
  // 协议层
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // fs 层
  PATH_ESCAPED: 1001, // 越出工作区
  BASELINE_MISMATCH: 1002, // 基线哈希冲突，要求重读
  BINARY_FILE: 1003,
  ENCODING_UNSUPPORTED: 1004,
  EDIT_ANCHOR_NOT_FOUND: 1005,
  EDIT_AMBIGUOUS: 1006, // oldText 多处命中
  FILE_NOT_FOUND: 1007,
  // terminal 层
  TERM_SESSION_NOT_FOUND: 2001,
  TERM_TIMEOUT: 2002,
  // 命令纪律层
  CMD_REJECTED: 3001, // &&/; 长链、PS 子集违规、禁用命令
  CMD_OVERFLOW_BLOCKED: 3002,
  // 审批层
  APPROVAL_REQUIRED: 4001, // data: {reason, risk, approvalToken}
  APPROVAL_REJECTED: 4002,
  // 快照层
  SNAPSHOT_NOT_FOUND: 5001,
  RESTORE_CONFLICT: 5002,
  // secret 层
  SECRET_NOT_FOUND: 6001,
  SECRET_PLATFORM_ERROR: 6002,
  // db 层
  DB_MIGRATION_FAILED: 7001,
  DB_ERROR: 7002,
  // 锁/检查点
  LOCK_HELD: 9001,
  LOCK_STALE: 9002,
  CHECKPOINT_CORRUPT: 9003,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** JSON-RPC 请求帧（行分隔，MAX_FRAME=1MB） */
export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** sidecar → 主进程事件通知 */
export interface RpcNotification {
  jsonrpc: '2.0';
  method: 'event';
  params: {
    event: string;
    callId?: number;
    data?: unknown;
  };
}

export const MAX_FRAME_BYTES = 1024 * 1024; // 1MB，超限硬拒绝；大输出必须先落盘
