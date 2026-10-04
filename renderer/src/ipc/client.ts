// 渲染层 IPC 客户端：window.codara 类型化封装（contextBridge 白名单）
import type {
  ApprovalCard,
  ApprovalRespondPayload,
  BudgetRespondPayload,
  Card,
  ChatEventPayload,
  ChatSendPayload,
  ChatSwitchResult,
  CrewSpawnPayload,
  CrewInstanceView,
  CrewTaskView,
  MemoryLoadResult,
  ModelsListPayload,
  ModelsListResult,
  SettingsPayload,
  SettingsSetPayload,
  UsageSnapshot,
} from '@codara/contract';

export interface CodaraBridge {
  settingsGet(): Promise<SettingsPayload>;
  settingsSet(payload: SettingsSetPayload): Promise<boolean>;
  settingsReset(): Promise<boolean>;
  modelsList(payload: ModelsListPayload): Promise<ModelsListResult>;
  chatSend(payload: ChatSendPayload): Promise<boolean>;
  /** 定向中止：必须带 sessionId，否则停的是主对话而不是当前会话 */
  chatAbort(payload?: { sessionId?: string }): Promise<boolean>;
  chatNew(payload?: { title?: string }): Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  chatSwitch(payload: { sessionId: string }): Promise<ChatSwitchResult>;
  chatMainSession(): Promise<{ sessionId: string | null }>;
  /** 正在跑任务的会话 id 集合（左栏「运行中」圆点） */
  chatRunning(): Promise<{ running: string[] }>;
  /** 历史会话列表（左栏对话列表）：直接读 sidecar sessions 表，重启不丢 */
  chatList(): Promise<ConversationListResult>;
  /** 用首条用户消息回填当前会话标题 */
  chatRename(payload: { title: string; sessionId?: string }): Promise<boolean>;
  /** 删除会话（级联删消息）；删除当前会话后主进程回退到主对话 */
  chatDelete(payload: { sessionId: string }): Promise<{ ok: boolean; error?: string }>;
  approvalRespond(payload: ApprovalRespondPayload): Promise<boolean>;
  usageSnapshot(): Promise<UsageSnapshot>;
  budgetRespond(payload: BudgetRespondPayload): Promise<boolean>;
  modeSet(mode: string): Promise<boolean>;
  workspaceOpen(): Promise<string | null>;
  workspaceGet(): Promise<string | undefined>;
  // M3：专家团
  crewStartTask(payload: { title: string }): Promise<{ taskId: string }>;
  crewSpawn(payload: CrewSpawnPayload): Promise<{ instanceId: string }>;
  crewStatus(): Promise<unknown>;
  // M4：Goal 预授权与崩溃恢复
  goalPreauthorize(payload: { confirmWorkspaceWrites: boolean; confirmWhitelistCommands: boolean; confirmBudget: boolean }): Promise<boolean>;
  recoveryPending(): Promise<{ locks: Array<{ name: string; owner: string; heartbeat: number }> }>;
  recoveryResolve(payload: { action: 'resume' | 'dismiss'; names: string[] }): Promise<unknown>;
  // M5：记忆体系 + 代码索引
  memoryLoad(): Promise<MemoryLoadResult>;
  memoryImport(): Promise<{ imported: string[]; skipped: string[] }>;
  memorySave(payload: { scope: 'global' | 'project'; content: string }): Promise<boolean>;
  indexStatus(): Promise<Record<string, unknown>>;
  indexConfigure(payload: { semantic?: boolean }): Promise<Record<string, unknown>>;
  indexBuild(): Promise<Record<string, unknown>>;
  // main → renderer 事件订阅
  onChatEvent(cb: (payload: ChatEventPayload) => void): () => void;
  onApprovalRequest(cb: (payload: { card: ApprovalCard; sessionId?: string }) => void): () => void;
  onBudgetSuspended(cb: (payload: unknown) => void): () => void;
  onCrewInstance(cb: (payload: CrewInstanceView) => void): () => void;
  onCrewTask(cb: (payload: { taskId: string; title: string; status: string }) => void): () => void;
  onCrewCard(cb: (payload: { instanceId: string; role: string; card: Card }) => void): () => void;
  onCrewArtifact(cb: (payload: { taskId: string; instanceId: string; artifactId: string; file: string; type: string }) => void): () => void;
  onRecoveryNeeded(cb: (payload: { locks: Array<{ name: string; owner: string; heartbeat: number }> }) => void): () => void;
}

export type { ChatEventPayload, ChatSwitchResult } from '@codara/contract';

/** chat:list 响应体：左栏对话列表（元信息，不含消息正文） */
export interface ConversationListResult {
  ok: boolean;
  sessions: Array<{ sessionId: string; title: string | null; createdAt: number }>;
  error?: string;
}

declare global {
  interface Window {
    codara?: CodaraBridge;
  }
}

/** 测试环境 fallback：无 Electron 时提供空实现（Vitest/DOM 预览用） */
export function bridge(): CodaraBridge {
  if (window.codara) return window.codara;
  const noop = () => Promise.resolve(false as never);
  return {
    settingsGet: async () => ({
      configured: false,
      provider: {
        endpoint: '',
        model: '',
        effort: 'balanced' as const,
        contextLength: 128000,
        timeoutMs: 120000,
        maxRetries: 3,
        pricing: { promptPerM: 0, completionPerM: 0 },
        hasKey: false,
      },
      budget: { turnsLimit: 200, concurrency: 2 },
      ui: { minimalMode: false, rightPaneVisible: true },
    }),
    settingsSet: noop,
    settingsReset: async () => false,
    modelsList: async () => ({ ok: false, models: [], error: 'bridge unavailable' }),
    chatSend: noop,
    chatAbort: noop,
    chatNew: async () => ({ ok: false, error: 'bridge unavailable' }),
    chatSwitch: async () => ({ ok: false, error: 'bridge unavailable' }),
    chatMainSession: async () => ({ sessionId: null }),
    chatRunning: async () => ({ running: [] }),
    chatList: async () => ({ ok: false, sessions: [], error: 'bridge unavailable' }),
    chatRename: async () => false,
    chatDelete: async () => ({ ok: false, error: 'bridge unavailable' }),
    approvalRespond: noop,
    usageSnapshot: async () => ({
      today: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
      currentTask: { promptTokens: 0, completionTokens: 0, costCNY: 0, turns: 0 },
      budget: { turnsLimit: 200, suspended: false },
    }),
    budgetRespond: noop,
    modeSet: async () => true,
    workspaceOpen: async () => null,
    workspaceGet: async () => undefined,
    crewStartTask: async () => ({ taskId: '' }),
    crewSpawn: async () => ({ instanceId: '' }),
    crewStatus: async () => ({}),
    goalPreauthorize: async () => false,
    recoveryPending: async () => ({ locks: [] }),
    recoveryResolve: async () => ({}) as unknown,
    memoryLoad: async () => ({
      global: '',
      project: '',
      globalPath: '',
      projectPath: '',
      imported: false,
      importable: [],
    }),
    memoryImport: async () => ({ imported: [], skipped: [] }),
    memorySave: async () => false,
    indexStatus: async () => ({}),
    indexConfigure: async () => ({}),
    indexBuild: async () => ({}),
    onChatEvent: () => () => undefined,
    onApprovalRequest: () => () => undefined,
    onBudgetSuspended: () => () => undefined,
    onCrewInstance: () => () => undefined,
    onCrewTask: () => () => undefined,
    onCrewCard: () => () => undefined,
    onCrewArtifact: () => () => undefined,
    onRecoveryNeeded: () => () => undefined,
  };
}
