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
  /**
   * 所属会话（第 6 轮并行隔离）。
   * 渲染层按它把卡片投递到对应会话的分区；缺省时由事件 payload 上的 sessionId 补齐。
   * 没有这个字段时，两个会话同时跑工具，卡片会全部堆到当前前台会话 —— 用户切回来
   * 看到的是另一个任务的工具流水。
   */
  sessionId?: string;
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
  /**
   * 单行可读摘要（第 6 轮）：形如 `search · pattern=*.ts · mode=files`。
   * paramsSummary 是 JSON.stringify 的截断串，直接展示会是一整块裸 JSON；
   * 渲染层改为默认只显示这一行，点击才展开 paramsSummary。
   */
  summaryLine?: string;
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
  /**
   * 条目种类（第 8 轮）。
   *
   * - `final`：本轮最终回复正文（assistant）。渲染在折叠容器**下方**。
   * - `process`：工具执行过程（步骤摘要 + 工具卡）。进折叠容器，默认折叠。
   * - `step`：过程里的一条步骤标题（模型给的一句话摘要）。
   *
   * 缺省（undefined）视为最终回复，兼容历史数据。
   */
  kind?: 'final' | 'process' | 'step';
  /**
   * 该条 step 所属的过程分组 id。
   *
   * 一轮用户任务 = 一个过程分组：从第一条 tool_calls 到最后一条工具结果。
   * 渲染层按这个 id 把散落的 step / 工具卡收进同一个折叠容器。
   */
  processGroup?: string;
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
