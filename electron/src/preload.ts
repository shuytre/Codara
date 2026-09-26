// preload：contextBridge 白名单暴露（规格：IPC 全 schema 校验，渲染层零 Node 能力）
import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type ApprovalCard, type ChatSendPayload, type CrewSpawnPayload, type ModelsListPayload, type SettingsSetPayload } from '@codara/contract';

function subscribe<T = unknown>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => cb(payload as T);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (payload: SettingsSetPayload) => ipcRenderer.invoke(IPC.settingsSet, payload),
  settingsReset: () => ipcRenderer.invoke(IPC.settingsReset),
  modelsList: (payload: ModelsListPayload) => ipcRenderer.invoke(IPC.modelsList, payload),
  chatSend: (payload: ChatSendPayload) => ipcRenderer.invoke(IPC.chatSend, payload),
  chatAbort: () => ipcRenderer.invoke(IPC.chatAbort),
  chatNew: () => ipcRenderer.invoke(IPC.chatNew),
  chatSwitch: (payload: { sessionId: string }) => ipcRenderer.invoke(IPC.chatSwitch, payload),
  chatMainSession: () => ipcRenderer.invoke(IPC.chatMainSession),
  approvalRespond: (payload: { approvalToken: string; approved: boolean }) =>
    ipcRenderer.invoke(IPC.approvalRespond, payload),
  usageSnapshot: () => ipcRenderer.invoke(IPC.usageSnapshot),
  budgetRespond: (payload: { action: 'extend' | 'reduce' | 'terminate'; newTokenLimit?: number; newCostLimitCNY?: number }) =>
    ipcRenderer.invoke(IPC.budgetRespond, payload),
  modeSet: (mode: string) => ipcRenderer.invoke(IPC.modeSet, mode),
  workspaceOpen: () => ipcRenderer.invoke(IPC.workspaceOpen),
  workspaceGet: () => ipcRenderer.invoke(IPC.workspaceGet),
  // M3：专家团
  crewStartTask: (payload: { title: string }) => ipcRenderer.invoke(IPC.crewStartTask, payload),
  crewSpawn: (payload: CrewSpawnPayload) => ipcRenderer.invoke(IPC.crewSpawn, payload),
  crewStatus: () => ipcRenderer.invoke(IPC.crewStatus),
  // M4：Goal 预授权 + 崩溃恢复
  goalPreauthorize: (payload: { confirmWorkspaceWrites: boolean; confirmWhitelistCommands: boolean; confirmBudget: boolean }) =>
    ipcRenderer.invoke(IPC.goalPreauthorize, payload),
  recoveryPending: () => ipcRenderer.invoke(IPC.recoveryPending),
  recoveryResolve: (payload: { action: 'resume' | 'dismiss'; names: string[] }) =>
    ipcRenderer.invoke(IPC.recoveryResolve, payload),
  // M5：记忆体系 + 代码索引
  memoryLoad: () => ipcRenderer.invoke(IPC.memoryLoad),
  memoryImport: () => ipcRenderer.invoke(IPC.memoryImport),
  memorySave: (payload: { scope: 'global' | 'project'; content: string }) =>
    ipcRenderer.invoke(IPC.memorySave, payload),
  indexStatus: () => ipcRenderer.invoke(IPC.indexStatus),
  indexConfigure: (payload: { semantic?: boolean }) => ipcRenderer.invoke(IPC.indexConfigure, payload),
  indexBuild: () => ipcRenderer.invoke(IPC.indexBuild),
  onChatEvent: (cb: (payload: unknown) => void) => subscribe(IPC.chatEvent, cb),
  onApprovalRequest: (cb: (payload: { card: ApprovalCard }) => void) => subscribe(IPC.approvalRequest, cb),
  onBudgetSuspended: (cb: (payload: unknown) => void) => subscribe(IPC.budgetSuspended, cb),
  onCrewInstance: (cb: (payload: unknown) => void) => subscribe(IPC.crewInstance, cb),
  onCrewTask: (cb: (payload: unknown) => void) => subscribe(IPC.crewTask, cb),
  onCrewCard: (cb: (payload: unknown) => void) => subscribe(IPC.crewCard, cb),
  onCrewArtifact: (cb: (payload: unknown) => void) => subscribe(IPC.crewArtifact, cb),
  onRecoveryNeeded: (cb: (payload: unknown) => void) => subscribe(IPC.recoveryNeeded, cb),
};

contextBridge.exposeInMainWorld('codara', api);