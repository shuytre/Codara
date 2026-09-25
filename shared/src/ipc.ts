/**
 * 渲染层 ↔ 主进程 IPC 通道白名单（contextBridge 暴露面）。
 * 所有通道 payload 在主进程 ipc/validate.ts 做 schema 校验。
 */

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
}

/** approval:respond 请求体 */
export interface ApprovalRespondPayload {
  approvalToken: string;
  approved: boolean;
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

/** memory:save 请求体（可视化记忆编辑器） */
export interface MemorySavePayload {
  scope: 'global' | 'project';
  content: string; // 单文件 8KB 上限（token 膨胀防护）
}

/** index:configure 请求体（M5） */
export interface IndexConfigurePayload {
  semantic?: boolean;
}
