/**
 * 九类结构化卡片（规格 2.2）+ 对话流消息契约（主进程 → 渲染层）。
 */

export type CardType =
  | 'plan'            // 计划卡片（可勾选/批准）
  | 'task-dispatch'   // 任务派发
  | 'tool-call'       // 工具调用流水（可展开）
  | 'diff'            // Diff 卡片（批准/拒绝）
  | 'approval'        // 审批申请
  | 'terminal'        // 终端输出块（已治理）
  | 'acceptance'      // 验收报告
  | 'artifact'        // 交接物
  | 'rollback';       // 回滚

export type CardStatus = 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'failed' | 'suspended';

export interface CardBase {
  id: string;
  type: CardType;
  status: CardStatus;
  createdAt: number;
  /** 关联任务 ID（M3/M4） */
  taskId?: string;
}

export interface PlanCard extends CardBase {
  type: 'plan';
  steps: Array<{ id: string; title: string; files?: string[]; risk?: string; verify?: string; done?: boolean }>;
}

export interface TaskDispatchCard extends CardBase {
  type: 'task-dispatch';
  role: string;
  goal: string;
  worktree?: string;
  taskId: string;
}

export interface ToolCallCard extends CardBase {
  type: 'tool-call';
  tool: string;
  paramsSummary: string;
  result?: string;
  ok?: boolean;
  cacheRef?: string;
  expanded?: boolean;
}

export interface DiffCard extends CardBase {
  type: 'diff';
  path: string;
  hunks: string; // unified diff 文本
  additions: number;
  deletions: number;
  snapshotId?: string;
}

export interface ApprovalCard extends CardBase {
  type: 'approval';
  title: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  payload: unknown; // 待批准的操作
  approvalToken: string;
}

export interface TerminalCard extends CardBase {
  type: 'terminal';
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  spillPath?: string;
}

export interface AcceptanceCard extends CardBase {
  type: 'acceptance';
  passed: boolean;
  evidence: string[]; // 退出码/断言/日志引用
  summary: string;
}

export interface ArtifactCard extends CardBase {
  type: 'artifact';
  artifactId: string;
  authorRole: string;
  artifactType: string;
  version: number;
  body: string;
}

export interface RollbackCard extends CardBase {
  type: 'rollback';
  target: string; // snapshotId 或 task
  restoredFiles: string[];
}

export type Card =
  | PlanCard | TaskDispatchCard | ToolCallCard | DiffCard | ApprovalCard
  | TerminalCard | AcceptanceCard | ArtifactCard | RollbackCard;

/** 对话流消息 */
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'event';
  text: string;
  createdAt: number;
  cards?: Card[]; // 关联卡片
  usage?: { promptTokens: number; completionTokens: number };
  model?: string;
  effort?: string;
}

/** 预算状态（用量面板） */
export interface BudgetState {
  turnsUsed: number;
  turnsLimit: number;
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
  costLimitCNY?: number;
  tokenLimit?: number;
  progress: number; // 0-1
  suspended: boolean;
}

export type BudgetSuspendAction = 'extend' | 'reduce' | 'terminate';
