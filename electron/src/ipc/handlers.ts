// IPC 通道注册：白名单 + zod schema 校验（规格：IPC 全 schema 校验）
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import {
  ApprovalCard,
  ApprovalRespondPayload,
  BudgetRespondPayload,
  Card,
  ChatSendPayload,
  IPC,
  MemoryLoadResult,
  ModelsListResult,
  SettingsPayload,
  SettingsSetPayload,
  UsageSnapshot,
} from '@codara/contract';

import { SettingsStore } from '../config/settingsStore';
import { SidecarManager } from '../sidecar/manager';
import { ModelClient } from '../model/client';
import { AgentLoop, TaskMode } from '../loop/agentLoop';
import { BudgetLedger } from '../budget/ledger';
import { ToolRuntime } from '../tools/runtime';
import { ApprovalGateway } from '../tools/gateway';
import { CrewScheduler } from '../crew/scheduler';
import { loadMemory } from '../memory/load';
import { globalMemoryPath, projectMemoryPath } from '../memory/paths';
import { detectImportable, importMemory } from '../memory/import';
import { MEMORY_FILE_LIMIT_BYTES } from '../memory/parse';
import { logger } from '../util/logger';

interface HandlerDeps {
  mainWindowRef: () => BrowserWindow | null;
  settings: SettingsStore;
  sidecar: SidecarManager;
  model: ModelClient;
  loop: AgentLoop;
  budget: BudgetLedger;
  tools: ToolRuntime;
  scheduler: CrewScheduler;
  gateway: ApprovalGateway;
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { mainWindowRef, settings, sidecar, budget, tools, scheduler, gateway } = deps;

  // ---------- 设置 ----------
  ipcMain.handle(IPC.settingsGet, async (): Promise<SettingsPayload> => {
    const s = settings.getAll();
    const hasKey = await budget
      .getApiKey()
      .then((k) => k.length > 0)
      .catch(() => false);
    return {
      configured: s.wizardCompleted && s.provider.endpoint !== '',
      provider: {
        templateId: s.provider.templateId,
        endpoint: s.provider.endpoint,
        model: s.provider.model,
        effort: s.provider.effort,
        contextLength: s.provider.contextLength,
        timeoutMs: s.provider.timeoutMs,
        maxRetries: s.provider.maxRetries,
        stripUnknown: s.provider.stripUnknown,
        pricing: s.provider.pricing,
        hasKey,
      },
      budget: s.budget,
      ui: s.ui,
      workspacePath: s.workspacePath,
    };
  });

  ipcMain.handle(IPC.settingsSet, async (_e, payload: unknown): Promise<boolean> => {
    const p = SettingsSetSchema.parse(payload);
    const providerPatch: Record<string, unknown> = { ...(p.provider || {}) };
    // 模板映射
    if (p.provider?.templateId) {
      const tpl = VENDOR_TEMPLATES_MAP[p.provider.templateId];
      if (tpl) {
        providerPatch['endpoint'] = p.provider.endpoint || tpl.endpoint;
        providerPatch['model'] = p.provider.model || tpl.defaultModel;
        providerPatch['pricing'] = p.provider.pricing || tpl.pricing;
      }
    }
    settings.patch({
      provider: providerPatch as never,
      budget: p.budget as never,
      ui: p.ui as never,
      workspacePath: p.workspacePath,
      wizardCompleted: p.wizardCompleted,
    });
    if (p.apiKey) {
      await budget.saveApiKey(p.apiKey);
    }
    // 工作区切换 → sidecar 重新 initialize
    if (p.workspacePath) {
      await sidecar.setWorkspace(p.workspacePath);
    }
    return true;
  });

  // ---------- 在线拉取模型列表（OpenAI 兼容 /models） ----------
  ipcMain.handle(IPC.modelsList, async (_e, payload: unknown): Promise<ModelsListResult> => {
    const p = ModelsListSchema.parse(payload);
    try {
      const url = new URL(p.endpoint.replace(/\/$/, '') + '/models');
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;
      const body = await new Promise<string>((resolve, reject) => {
        const req = mod.request(
          {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
            timeout: 15000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d as Buffer));
            res.on('end', () => {
              const status = res.statusCode || 500;
              const text = Buffer.concat(chunks).toString();
              if (status >= 400) {
                reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
                return;
              }
              resolve(text);
            });
          }
        );
        req.on('timeout', () => req.destroy(new Error('请求超时（15s）')));
        req.on('error', reject);
        req.end();
      });
      const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
      const models = (parsed.data ?? [])
        .map((m) => String(m.id ?? ''))
        .filter((id) => id.length > 0)
        .sort();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  // ---------- 恢复初始配置（清设置 + 重启重现向导） ----------
  ipcMain.handle(IPC.settingsReset, async (): Promise<boolean> => {
    try {
      // 尽力清除已存凭据（失败不阻塞重置）
      await budget.deleteApiKey().catch(() => undefined);
    } catch {
      // ignore
    }
    settings.resetToDefaults();
    // 重启应用：向导将重新出现
    const { app } = await import('electron');
    app.relaunch();
    app.exit(0);
    return true;
  });

  // ---------- 工作区 ----------
  ipcMain.handle(IPC.workspaceOpen, async (): Promise<string | null> => {
    const win = mainWindowRef();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || r.filePaths.length === 0) return null;
    const dir = r.filePaths[0] as string;
    settings.patch({ workspacePath: dir });
    await sidecar.setWorkspace(dir);
    return dir;
  });

  // ---------- 对话 ----------
  ipcMain.handle(IPC.chatSend, async (event, payload: unknown): Promise<boolean> => {
    const p = ChatSendSchema.parse(payload);
    const win = mainWindowRef();
    if (!win) return false;

    const sendCard = (card: Card) => {
      win.webContents.send(IPC.chatEvent, { kind: 'card', card });
    };
    const sendApproval = (card: ApprovalCard) => {
      win.webContents.send(IPC.approvalRequest, { card });
    };
    // 审批 → 渲染层
    gateway.onApproval(async (card) => {
      sendApproval(card);
      return new Promise<boolean>((resolve) => {
        approvalWaiters.set(card.approvalToken, resolve);
      });
    });

    // 流式增量（节流 50ms 批量推送）
    let deltaBuf = '';
    let deltaTimer: NodeJS.Timeout | null = null;
    const flushDelta = () => {
      if (deltaBuf) {
        win.webContents.send(IPC.chatEvent, { kind: 'delta', text: deltaBuf });
        deltaBuf = '';
      }
      deltaTimer = null;
    };

    budget.startTask(`main-${Date.now()}`);
    await deps.loop.run(p.text, p.mode as TaskMode, {
      onCard: sendCard,
      onDelta: (t) => {
        deltaBuf += t;
        if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 50);
      },
      onDone: (full) => {
        if (deltaTimer) flushDelta();
        win.webContents.send(IPC.chatEvent, {
          kind: 'done',
          text: full,
          usage: budget.snapshot(),
        });
      },
      onBudgetSuspended: () => {
        win.webContents.send(IPC.budgetSuspended, budget.snapshot());
      },
    });
    return true;
  });

  ipcMain.handle(IPC.chatAbort, async () => {
    deps.loop.abort();
    // 「停」即回到逐次审批（规格 4.7）
    gateway.setGoalPreAuthorized(false);
    return true;
  });

  // 新建对话：切换新会话（原会话消息仍在 sidecar 中），清空 AgentLoop 工作记忆
  ipcMain.handle(IPC.chatNew, async (): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
    try {
      deps.loop.abort();
      gateway.setGoalPreAuthorized(false);
      deps.loop.reset();
      const sess = await sidecar.call('session.create', { kind: 'main', title: `对话 ${new Date().toLocaleString('zh-CN')}` });
      const data = sess.data as { sessionId?: string } | undefined;
      if (sess.ok && data?.sessionId) {
        deps.loop.attachMainSession(String(data.sessionId));
        return { ok: true, sessionId: String(data.sessionId) };
      }
      return { ok: false, error: 'session create failed' };
    } catch (err) {
      logger.warn('new chat session create failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 切换会话：绑定目标会话并恢复历史消息为模型上下文（左栏对话列表点击）
  ipcMain.handle(IPC.chatSwitch, async (_e, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      const p = z.object({ sessionId: z.string().min(1) }).parse(payload);
      deps.loop.abort();
      deps.loop.reset();
      deps.loop.attachMainSession(p.sessionId);
      // 恢复历史（roleId=main 约定；失败不阻塞切换，仅失去模型上下文）
      const hist = await sidecar.call('msg.list', { sessionId: p.sessionId, roleId: 'main', limit: 200 });
      if (hist.ok) {
        const rows = (hist.data as { messages?: Array<Record<string, unknown>> } | undefined)?.messages ?? [];
        const history = rows
          .map((r) => {
            const role = String(r.role ?? 'assistant');
            const raw = r.content;
            let content = '';
            if (typeof raw === 'string') {
              try {
                const parsed = JSON.parse(raw) as unknown;
                content = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
              } catch {
                content = raw;
              }
            }
            const m: Record<string, unknown> = { role, content };
            if (r.toolCallId) m.tool_call_id = r.toolCallId;
            if (r.toolCalls) {
              try {
                m.tool_calls = JSON.parse(String(r.toolCalls));
              } catch {
                /* 忽略损坏行 */
              }
            }
            return m as never;
          })
          .filter((m) => Boolean((m as { content?: string }).content));
        deps.loop.loadMessages(history);
      }
      return { ok: true };
    } catch (err) {
      logger.warn('chat switch failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 主对话原点会话 id（启动时创建；chatNew 换会话不影响原点，左栏「主对话」回切用）
  ipcMain.handle(IPC.chatMainSession, async (): Promise<{ sessionId: string | null }> => {
    return { sessionId: deps.loop.getMainSessionId() };
  });

  // ---------- Goal 预授权（M4，规格 4.7） ----------
  ipcMain.handle(IPC.goalPreauthorize, async (_e, payload: unknown): Promise<boolean> => {
    const p = GoalPreauthorizeSchema.parse(payload);
    // 三项全部勾选才开启；任一不勾选则维持逐次审批
    const all = p.confirmWorkspaceWrites && p.confirmWhitelistCommands && p.confirmBudget;
    gateway.setGoalPreAuthorized(all);
    return all;
  });

  // ---------- 审批 ----------
  const approvalWaiters = new Map<string, (approved: boolean) => void>();
  ipcMain.handle(IPC.approvalRespond, async (_e, payload: unknown): Promise<boolean> => {
    const p = ApprovalRespondSchema.parse(payload);
    const waiter = approvalWaiters.get(p.approvalToken);
    if (waiter) {
      approvalWaiters.delete(p.approvalToken);
      waiter(p.approved);
      return true;
    }
    return false;
  });

  // ---------- 预算 ----------
  ipcMain.handle(IPC.usageSnapshot, async (): Promise<UsageSnapshot> => {
    const snap = budget.snapshot();
    return {
      today: {
        promptTokens: snap.task.promptTokens,
        completionTokens: snap.task.completionTokens,
        costCNY: snap.task.costCNY,
      },
      currentTask: {
        promptTokens: snap.task.promptTokens,
        completionTokens: snap.task.completionTokens,
        costCNY: snap.task.costCNY,
        turns: snap.turns,
      },
      budget: {
        turnsLimit: snap.budget.turnsLimit,
        tokenLimit: snap.budget.tokenLimit,
        costLimitCNY: snap.budget.costLimitCNY,
        suspended: snap.suspended,
      },
    };
  });

  ipcMain.handle(IPC.budgetRespond, async (_e, payload: unknown): Promise<boolean> => {
    const p = BudgetRespondSchema.parse(payload);
    if (p.action === 'extend') {
      budget.extend(p.newTokenLimit, p.newCostLimitCNY);
    } else if (p.action === 'terminate') {
      deps.loop.abort();
    }
    // reduce：注入缩减指令由 M4 Goal 细化
    return true;
  });

  // ---------- 模式 ----------
  ipcMain.handle(IPC.modeSet, async (_e, mode: string) => {
    return ['ask', 'plan', 'goal'].includes(mode);
  });

  // ---------- 专家团（M3） ----------
  ipcMain.handle(IPC.crewStartTask, async (_e, payload: unknown): Promise<{ taskId: string }> => {
    const p = CrewStartTaskSchema.parse(payload);
    const view = await scheduler.startTask(p.title);
    return { taskId: view.taskId };
  });

  ipcMain.handle(IPC.crewSpawn, async (_e, payload: unknown): Promise<{ instanceId: string }> => {
    const p = CrewSpawnSchema.parse(payload);
    return scheduler.spawnInstance(p);
  });

  ipcMain.handle(IPC.crewStatus, async () => {
    return scheduler.taskStatus({});
  });

  // ---------- 崩溃恢复（M4，规格 4.6） ----------
  ipcMain.handle(IPC.recoveryResolve, async (_e, payload: unknown): Promise<unknown> => {
    const p = RecoveryResolveSchema.parse(payload);
    for (const name of p.names) {
      if (p.action === 'resume') {
        // 恢复：释放过期锁 + 加载最后检查点回放给对话流
        await sidecar.call('lock.release', { name }).catch(() => undefined);
        const ckpt = await sidecar.call('ckpt.load', { taskId: name }).catch(() => undefined);
        const win = mainWindowRef();
        if (win && ckpt?.ok) {
          win.webContents.send(IPC.chatEvent, {
            kind: 'done',
            text: `【崩溃恢复】任务 ${name} 已从最后检查点恢复。\n检查点内容：${JSON.stringify((ckpt.data as { payload?: unknown })?.payload ?? {}).slice(0, 2000)}`,
          });
        }
        logger.info('recovery resumed', { name });
      } else {
        // 忽略：仅释放过期锁
        await sidecar.call('lock.release', { name }).catch(() => undefined);
        logger.info('recovery dismissed', { name });
      }
    }
    return { resolved: p.names.length };
  });

  // ---------- 记忆体系（M5，规格 7.6） ----------
  ipcMain.handle(IPC.memoryLoad, async (): Promise<MemoryLoadResult> => {
    const ws = settings.get('workspacePath') || undefined;
    const mem = loadMemory(ws);
    return {
      global: mem.global,
      project: mem.project,
      globalPath: globalMemoryPath(),
      projectPath: ws ? projectMemoryPath(ws) : '',
      imported: settings.get('memoryImported') === true,
      importable: detectImportable(ws ?? '').map((s) => s.file),
    };
  });

  ipcMain.handle(IPC.memoryImport, async (): Promise<{ imported: string[]; skipped: string[] }> => {
    const ws = settings.get('workspacePath');
    if (!ws) return { imported: [], skipped: [] };
    const r = importMemory(ws);
    if (r.imported.length > 0) {
      settings.patch({ memoryImported: true });
    }
    return { imported: r.imported, skipped: r.skipped };
  });

  ipcMain.handle(IPC.memorySave, async (_e, payload: unknown): Promise<boolean> => {
    const p = MemorySaveSchema.parse(payload);
    if (Buffer.byteLength(p.content, 'utf-8') > MEMORY_FILE_LIMIT_BYTES) {
      throw new Error(`memory file exceeds ${MEMORY_FILE_LIMIT_BYTES} bytes`);
    }
    const target = p.scope === 'global' ? globalMemoryPath() : projectMemoryPath(settings.get('workspacePath') || '');
    if (!target) throw new Error('workspace not set');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, p.content, 'utf-8');
    return true;
  });

  // ---------- 代码索引（M5） ----------
  ipcMain.handle(IPC.indexStatus, async () => (await sidecar.call('index.status', {})).data);
  ipcMain.handle(IPC.indexConfigure, async (_e, payload: unknown) => {
    const p = IndexConfigureSchema.parse(payload);
    return (await sidecar.call('index.configure', p)).data;
  });
  ipcMain.handle(IPC.indexBuild, async () => (await sidecar.call('index.build', {})).data);

  // ---------- 窗口 ----------
  ipcMain.handle(IPC.windowMinimize, () => mainWindowRef()?.minimize());
  ipcMain.handle(IPC.windowMaximize, () => {
    const w = mainWindowRef();
    if (w?.isMaximized()) {
      w.unmaximize();
    } else w?.maximize();
  });
  ipcMain.handle(IPC.windowClose, () => mainWindowRef()?.close());

  logger.info('ipc handlers registered');
}

// ---------- zod schemas ----------
const ChatSendSchema = z.object({
  text: z.string().min(1).max(32000),
  mode: z.enum(['ask', 'plan', 'goal']),
});

const CrewStartTaskSchema = z.object({
  title: z.string().min(1).max(200),
});

const CrewSpawnSchema = z.object({
  taskId: z.string().min(1),
  role: z.enum(['architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher']),
  goal: z.string().min(1).max(16000),
  acceptanceCriteria: z.array(z.string().max(2000)).max(20).optional(),
  fileScope: z.array(z.string().max(500)).max(100).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
});

const GoalPreauthorizeSchema = z.object({
  confirmWorkspaceWrites: z.boolean(),
  confirmWhitelistCommands: z.boolean(),
  confirmBudget: z.boolean(),
});

const RecoveryResolveSchema = z.object({
  action: z.enum(['resume', 'dismiss']),
  names: z.array(z.string().min(1)).min(1).max(50),
});
const MemorySaveSchema = z.object({
  scope: z.enum(['global', 'project']),
  content: z.string(),
});
const IndexConfigureSchema = z.object({
  semantic: z.boolean().optional(),
});

const ModelsListSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
});

const SettingsSetSchema = z.object({
  provider: z
    .object({
      templateId: z.string().optional(),
      endpoint: z.string().optional(),
      model: z.string().optional(),
      models: z.array(z.string()).optional(),
      effort: z.enum(['fast', 'balanced', 'max']).optional(),
      contextLength: z.number().optional(),
      timeoutMs: z.number().optional(),
      maxRetries: z.number().optional(),
      stripUnknown: z.boolean().optional(),
      pricing: z.object({ promptPerM: z.number(), completionPerM: z.number() }).optional(),
    })
    .optional(),
  apiKey: z.string().optional(),
  budget: z
    .object({
      turnsLimit: z.number().optional(),
      tokenLimit: z.number().optional(),
      costLimitCNY: z.number().optional(),
      concurrency: z.number().optional(),
    })
    .optional(),
  ui: z.object({ minimalMode: z.boolean().optional(), rightPaneVisible: z.boolean().optional() }).optional(),
  workspacePath: z.string().optional(),
  wizardCompleted: z.boolean().optional(),
});

const ApprovalRespondSchema = z.object({
  approvalToken: z.string(),
  approved: z.boolean(),
});

const BudgetRespondSchema = z.object({
  action: z.enum(['extend', 'reduce', 'terminate']),
  newTokenLimit: z.number().optional(),
  newCostLimitCNY: z.number().optional(),
});

// 向导模板映射（与 shared VENDOR_TEMPLATES 同步）
const VENDOR_TEMPLATES_MAP: Record<string, { endpoint: string; defaultModel: string; pricing: { promptPerM: number; completionPerM: number } }> = {
  deepseek: { endpoint: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', pricing: { promptPerM: 2, completionPerM: 8 } },
  zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', pricing: { promptPerM: 0.1, completionPerM: 0.1 } },
  qwen: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', pricing: { promptPerM: 0.8, completionPerM: 2 } },
  moonshot: { endpoint: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k', pricing: { promptPerM: 12, completionPerM: 12 } },
  ollama: { endpoint: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder:7b', pricing: { promptPerM: 0, completionPerM: 0 } },
  lmstudio: { endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model', pricing: { promptPerM: 0, completionPerM: 0 } },
};
