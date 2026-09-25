/**
 * 五类工具契约（规格 3.4，模型可见短契约）+ 标准预设调度工具。
 * 参数类型即模型可见 schema 的 TypeScript 投影。
 */
import type { Envelope } from './envelope';

// ---------- 3.4.1 read ----------
export interface ReadParams {
  path: string;
  offset?: number; // 起始行号（1 起），默认 1
  limit?: number; // 默认 200，最大 2000
  encoding?: 'auto' | 'utf-8' | 'gbk' | 'gb18030';
}
export interface ReadResult {
  path: string;
  totalLines: number;
  offset: number;
  lines: Array<{ no: number; text: string }>;
  encoding: string;
  binary?: { size: number; mime: string; headHex: string }; // 二进制只给元信息
}

// ---------- 3.4.2 write（唯一写通道） ----------
export type WriteEdit =
  | { oldText: string; newText: string }
  | { insertAfter: string; newText: string }
  | { insertBefore: string; newText: string };

export interface WriteParams {
  path: string;
  edits: WriteEdit[];
  /** 新建文件必须 true；已存在文件禁止整文件覆盖 */
  create?: boolean;
  /** 基线哈希（来自最近一次 read），文件已被改动时拒绝写入 */
  baselineHash?: string;
}

// ---------- 3.4.3 terminal ----------
export interface TerminalParams {
  command: string; // 单条命令；禁止 && / ; 长链
  cwd?: string;
  timeoutMs?: number; // 默认 30000，上限 300000
  input?: string;
  sessionId?: string; // 持久会话
}
export interface TerminalResult {
  sessionId: string;
  exitCode: number;
  stdout: string; // 已过治理管线
  stderr: string;
  durationMs: number;
  truncated?: boolean;
  spillPath?: string; // 超长落盘路径
}

// ---------- 3.4.4 git ----------
export type GitOp =
  | 'status' | 'diff' | 'log' | 'show' | 'branch' | 'worktree-list' // 只读 auto
  | 'commit' | 'branch-create' | 'worktree-create' | 'worktree-remove' | 'revert'; // 需批准

export interface GitParams {
  op: GitOp;
  args?: Record<string, string>;
}

// ---------- 3.4.5 search ----------
export interface SearchParams {
  pattern: string;
  path?: string;
  glob?: string[];
  mode?: 'rg' | 'files' | 'symbols';
  caseSensitive?: boolean;
  context?: number; // 默认 0，最大 3
  maxResults?: number; // 默认 100
}
export interface SearchResult {
  matches: Array<{ path: string; line: number; text: string; contextBefore?: string[]; contextAfter?: string[] }>;
  totalMatches: number;
}

// 调度工具参数/交接物 schema 统一见 ./crew.ts（TaskPacket / CrewArtifact，M3 单一来源）

// ---------- 工具名注册表 ----------
export const TOOL_NAMES = ['read', 'write', 'terminal', 'git', 'search'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** 统一工具调用结果 */
export type ToolEnvelopeMap = {
  read: Envelope<ReadResult>;
  write: Envelope<{ path: string; bytesWritten: number; snapshotId: string; snapshotRef?: string }>;
  terminal: Envelope<TerminalResult>;
  git: Envelope<{ output: string }>;
  search: Envelope<SearchResult>;
};

/** 工具 OpenAI function-calling 定义（注入模型 system/tools；M3 扩展 task.* 调度工具） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
