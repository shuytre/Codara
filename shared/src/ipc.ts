/**
 * 渲染层 ↔ 主进程 IPC 通道白名单（contextBridge 暴露面）。
 * 所有通道 payload 在主进程 ipc/validate.ts 做 schema 校验。
 */

import type { Card } from './cards';

export const IPC = {
  // 设置与凭据
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsIsConfigured: 'settings:is-configured', // 是否已完成首次向导
  settingsReset: 'settings:reset', // 恢复初始配置并重启（重现欢迎向导）
  modelsList: 'models:list', // 按 Base URL + API Key 在线拉取可用模型列表
  // 对话
  chatSend: 'chat:send', // renderer → main：用户消息
  chatAbort: 'chat:abort',
  chatNew: 'chat:new', // 新建对话（新会话 + 清空工作记忆）
  chatSwitch: 'chat:switch', // 切换会话（加载历史消息，恢复模型上下文）
  chatMainSession: 'chat:main-session', // 查询启动时创建的主对话原点会话 id
  chatRunning: 'chat:running', // 查询哪些会话正在跑任务（左栏「运行中」标点）
  chatList: 'chat:list', // 列出历史会话（左栏对话列表；来自 sidecar sessions 表，重启不丢）
  chatRename: 'chat:rename', // 用首条用户消息回填会话标题（左栏可辨识）
  chatDelete: 'chat:delete', // 删除会话（级联删消息；左栏悬停删除入口）
  chatEvent: 'chat:event', // main → renderer：流式事件/卡片（sendToView）
  // 审批
  approvalRespond: 'approval:respond',
  approvalRequest: 'approval:request', // main → renderer：审批卡
  // 预算
  usageSnapshot: 'usage:snapshot',
  budgetRespond: 'budget:respond', // 续预算/缩减范围/终止
  budgetSuspended: 'budget:suspended', // main → renderer
  // 模式
  modeSet: 'mode:set', // ask | plan | goal
  // 专家团（M3）
  crewStartTask: 'crew:start-task', // renderer → main：创建任务
  crewSpawn: 'crew:spawn', // renderer → main：直接派发实例（调试/手工模式）
  crewStatus: 'crew:status',
  crewInstance: 'crew:instance', // main → renderer：实例状态（左栏角色树）
  crewTask: 'crew:task', // main → renderer：任务状态
  crewCard: 'crew:card', // main → renderer：实例内卡片流水
  crewArtifact: 'crew:artifact', // main → renderer：交接物产出
  // Goal 预授权与崩溃恢复（M4）
  goalPreauthorize: 'goal:preauthorize', // renderer → main：用户勾选确认预授权
  recoveryNeeded: 'recovery:needed', // main → renderer：启动检测到过期锁
  recoveryPending: 'recovery:pending', // renderer → main：主动拉取待恢复锁（事件早于订阅会丢，故用 pull）
  recoveryResolve: 'recovery:resolve', // renderer → main：恢复 / 忽略
  // 记忆体系（M5，规格 7.6）
  memoryLoad: 'memory:load', // 返回全局/项目记忆正文与导入标记
  memoryImport: 'memory:import', // 一次性兼容导入（.codex / .workbuddy）
  memorySave: 'memory:save', // 可视化记忆编辑器保存
  // 代码索引（M5）
  indexStatus: 'index:status',
  indexConfigure: 'index:configure', // semantic 开关（默认关，规格 5.4）
  indexBuild: 'index:build', // 触发一个增量 tick
  // 工作区
  workspaceOpen: 'workspace:open',
  workspaceGet: 'workspace:get',
  // 系统
  uiReady: 'ui:ready',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** chat:send 请求体 */
export interface ChatSendPayload {
  text: string;
  mode: 'ask' | 'plan' | 'goal';
  /**
   * 目标会话 id（第 6 轮并行隔离）。
   * 必传语义：主进程按它取对应的 AgentLoop/BudgetLedger；缺省才回落到原点会话。
   */
  sessionId?: string;
}

/** settings:get 响应体 */
export interface SettingsPayload {
  configured: boolean;
  provider: {
    templateId?: string;
    endpoint: string;
    model: string;
    /** 候选模型列表（向导/设置页在线拉取后勾选保存，可切换） */
    models?: string[];
    effort: 'fast' | 'balanced' | 'max';
    contextLength: number;
    timeoutMs: number;
    maxRetries: number;
    stripUnknown?: boolean;
    pricing: { promptPerM: number; completionPerM: number };
    hasKey: boolean; // 不回传 Key 本体
  };
  budget: { turnsLimit: number; tokenLimit?: number; costLimitCNY?: number; concurrency: number };
  ui: { minimalMode: boolean; rightPaneVisible: boolean };
  workspacePath?: string;
}

/** settings:set 请求体 */
export interface SettingsSetPayload {
  provider?: Partial<Omit<SettingsPayload['provider'], 'hasKey'>>;
  apiKey?: string; // 明文仅经此通道写入，经 sidecar DPAPI 加密落库
  budget?: Partial<SettingsPayload['budget']>;
  ui?: Partial<SettingsPayload['ui']>;
  workspacePath?: string;
  wizardCompleted?: boolean;
}

/** models:list 请求体 */
export interface ModelsListPayload {
  endpoint: string; // OpenAI 兼容 base URL（含 /v1）
  apiKey?: string; // 本地端点可空
}

/** models:list 响应体 */
export interface ModelsListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/** usage:snapshot 响应 */
export interface UsageSnapshot {
  today: { promptTokens: number; completionTokens: number; costCNY: number };
  currentTask: { promptTokens: number; completionTokens: number; costCNY: number; turns: number };
  budget: {
    turnsLimit: number;
    tokenLimit?: number;
    costLimitCNY?: number;
    suspended: boolean;
  };
}

/** budget:respond 请求体 */
export interface BudgetRespondPayload {
  action: 'extend' | 'reduce' | 'terminate';
  newTokenLimit?: number;
  newCostLimitCNY?: number;
  /** 预算所属会话；缺省时 extend 作用于全部会话、terminate 不执行 */
  sessionId?: string;
}

/** approval:respond 请求体 */
export interface ApprovalRespondPayload {
  approvalToken: string;
  approved: boolean;
  /** 审批卡所属会话（第 6 轮：等待表按会话分桶，缺省无法定位） */
  sessionId?: string;
}

/** main → renderer：流式事件/卡片（全部携带 sessionId 供渲染层分区路由） */
export type ChatEventPayload =
  | { kind: 'delta'; text: string; sessionId?: string }
  | { kind: 'card'; card: Card; sessionId?: string }
  /**
   * 工具调用过程的步骤标题（模型为这一步写的摘要，如「读取配置文件」）。
   *
   * 与 delta 分开：delta 是**最终回复**的正文，process 属于「执行过程」，
   * 渲染层把它归进折叠容器。两者混用会让半截结论提前显示在工具卡之前。
   * text 为空串表示模型没给摘要，渲染层回退到参数摘要。
   */
  | { kind: 'process'; text: string; sessionId?: string }
  /** 本轮结束。ok=true 表示 text 是模型的最终回复；false 表示终止/错误说明 */
  | { kind: 'done'; text: string; ok?: boolean; usage?: unknown; sessionId?: string };

/**
 * 历史工具调用（chat:switch 回传）。
 * 第 6 轮新增：此前历史只回一句「调用工具：xxx」文本，切回会话后右栏
 * 「工具流水」永远是空的 —— 它只认 type='tool-call' 卡，而历史路径从不生成卡。
 */
export interface ChatHistoryToolCall {
  name: string;
  /** 参数 JSON 文本（截断到 2000） */
  args: string;
  /** 工具结果 JSON 文本（截断到 800）；无配对结果时为空串 */
  result: string;
  ok: boolean;
}

/** chat:switch 响应体中的单条历史消息 */
export interface ChatHistoryMessage {
  role: string;
  content: string | null;
  /** assistant 行的工具名摘要（多工具用 / 连接） */
  toolName?: string;
  /** assistant 行解析出的结构化工具调用（已配好参数与结果） */
  toolCalls?: ChatHistoryToolCall[];
}

/** chat:switch 响应体 */
export interface ChatSwitchResult {
  ok: boolean;
  error?: string;
  messages?: ChatHistoryMessage[];
}

/** crew:start-task 请求体（M3） */
export interface CrewStartTaskPayload {
  title: string;
}

/** crew:spawn 请求体（M3：直接派发实例） */
export interface CrewSpawnPayload {
  taskId: string;
  role: 'architect' | 'developer' | 'reviewer' | 'tester' | 'builder' | 'researcher';
  goal: string;
  acceptanceCriteria?: string[];
  fileScope?: string[];
  effort?: 'low' | 'medium' | 'high';
  maxTurns?: number;
}

/** goal:preauthorize 请求体（规格 4.7：逐项勾选确认） */
export interface GoalPreauthorizePayload {
  confirmWorkspaceWrites: boolean; // 工作区内文件写入跳过逐次审批
  confirmWhitelistCommands: boolean; // 白名单命令跳过逐次审批
  confirmBudget: boolean; // 预算上限与自动停机条件
}

/** recovery:needed 事件体（启动时检测到过期锁） */
export interface RecoveryNeededPayload {
  locks: Array<{ name: string; owner: string; heartbeat: number }>;
}

/** recovery:resolve 请求体 */
export interface RecoveryResolvePayload {
  action: 'resume' | 'dismiss';
  names: string[];
}

/** memory:load 响应体（M5） */
export interface MemoryLoadResult {
  global: string;
  project: string;
  globalPath: string;
  projectPath: string;
  imported: boolean; // 兼容导入标记（settingsStore）
  importable: string[]; // 检测到的可导入源（相对路径）
}

/** memory:save 请求体（M5） */
export interface MemorySavePayload {
  scope: 'global' | 'project';
  content: string; // 单文件 8KB 上限（token 膨胀防护）
}

/** index:configure 请求体（M5） */
export interface IndexConfigurePayload {
  semantic?: boolean;
}