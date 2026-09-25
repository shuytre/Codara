// 渲染层 IPC 客户端：window.codara 类型化封装（contextBridge 白名单）
import type {
  ApprovalCard,
  ApprovalRespondPayload,
  BudgetRespondPayload,
  Card,
  ChatSendPayload,
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
  chatAbort(): Promise<boolean>;
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
  onApprovalRequest(cb: (payload: { card: ApprovalCard }) => void): () => void;
  onBudgetSuspended(cb: (payload: unknown) => void): () => void;
  onCrewInstance(cb: (payload: CrewInstanceView) => void): () => void;
  onCrewTask(cb: (payload: { taskId: string; title: string; status: string }) => void): () => void;
  onCrewCard(cb: (payload: { instanceId: string; role: string; card: Card }) => void): () => void;
  onCrewArtifact(cb: (payload: { taskId: string; instanceId: string; artifactId: string; file: string; type: string }) => void): () => void;
  onRecoveryNeeded(cb: (payload: { locks: Array<{ name: string; owner: string; heartbeat: number }> }) => void): () => void;
}

export type ChatEventPayload =
  | { kind: 'delta'; text: string }
  | { kind: 'card'; card: Card }
  | { kind: 'done'; text: string; usage?: unknown };

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
    recoveryResolve: async () => ({}),
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
