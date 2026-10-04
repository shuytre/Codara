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
  ChatSwitchResult,
  IPC,
  MemoryLoadResult,
  ModelsListResult,
  SettingsPayload,
  SettingsSetPayload,
  UsageSnapshot,
} from '@codara/contract';
import type { ChatHistoryToolCall } from '@codara/contract';

import { SettingsStore } from '../config/settingsStore';
import { SidecarManager } from '../sidecar/manager';
import { ModelClient } from '../model/client';
import { AgentLoop, TaskMode } from '../loop/agentLoop';
import { SessionRegistry } from '../loop/sessionRuntime';
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
  /**
   * 会话运行时注册表（第 6 轮并行隔离核心）。
   * 一个 sessionId 一份 AgentLoop + BudgetLedger + 审批等待表，
   * 切换/新建会话不再触碰其它会话的运行态。
   */
  sessions: SessionRegistry;
  /** 全局预算（仅 API Key 读写走它；会话级预算在 SessionRuntime 内） */
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

  // preload 已向渲染层暴露 workspaceGet，但此前 main 从未注册对应 handler，
  // 渲染层一旦调用即抛「No handler registered」—— 契约面必须闭合。
  ipcMain.handle(IPC.workspaceGet, async (): Promise<string | undefined> => {
    return settings.get('workspacePath') || undefined;
  });

  // ---------- 审批等待表（须在 chatSend 之前定义） ----------
  // 审批回调只能在注册期绑定一次：原实现放在 chatSend 内部，每次发送都会 push 一个新的
  // listener，导致第 N 次对话需要连点 N 次「批准」，且旧 listener 的 Promise 永不结算。
  //
  // 第 6 轮：审批按**会话**隔离。此前是一张全局 Map，chatAbort 会一次性 resolve
  // 全部 token —— 两个会话各自有待审批时，批准 A 会把 B 的也一起判为拒绝。
  // sessionId 由 gateway.check() 透传（每个会话一份 ToolRuntime，见 SessionRegistry），
  // 不依赖任何全局可变状态，因此两个会话并发时不会串台。
  const approvalWaitersBySession = new Map<string, Map<string, (approved: boolean) => void>>();
  function waitersFor(sessionId: string): Map<string, (approved: boolean) => void> {
    let m = approvalWaitersBySession.get(sessionId);
    if (!m) {
      m = new Map();
      approvalWaitersBySession.set(sessionId, m);
    }
    return m;
  }

  gateway.onApproval(async (card, sessionId) => {
    const win = mainWindowRef();
    const sid = sessionId || '__origin__';
    if (win && !win.isDestroyed()) {
      // 带上 sessionId：渲染层据此把卡片投递到对应会话的分区，而不是当前前台会话
      win.webContents.send(IPC.approvalRequest, { card, sessionId: sid });
    }
    return new Promise<boolean>((resolve) => {
      waitersFor(sid).set(card.approvalToken, resolve);
    });
  });

  // ---------- 对话 ----------
  //
  // 会话归属解析（贯穿本文件所有会话相关 handler）：
  //   显式 payload.sessionId > 注册表原点会话。
  // 渲染层始终显式带上当前会话 id；缺省回落仅作兼容（旧调用方 / 竞态首帧）。
  const resolveSessionId = (raw: unknown): string | null => {
    if (typeof raw === 'string' && raw.length > 0) return raw;
    return deps.sessions.origin();
  };

  ipcMain.handle(IPC.chatSend, async (event, payload: unknown): Promise<boolean> => {
    const p = ChatSendSchema.parse(payload);
    const win = mainWindowRef();
    if (!win) return false;
    // 每个会话一份 loop/budget —— 这是「切换会话不打断主任务」的关键。
    const sessionId = resolveSessionId(p.sessionId);
    if (!sessionId) return false;
    const rt = deps.sessions.acquire(sessionId);
    // 同一会话已有任务在跑：拒绝重入。
    // 此前是 abort 掉旧的再跑新的（隐式抢占），在会话并行后语义混乱 ——
    // 用户连点两次发送会把自己的提问截断。明确拒绝更安全。
    if (rt.loop.isRunning()) return false;
    // 流式过程中窗口可能已被关闭：此后任何 webContents.send 都会抛
    // 「Object has been destroyed」并穿透为 uncaughtException 杀掉主进程。
    const alive = () => !win.isDestroyed();
    const sendCard = (card: Card) => {
      if (alive()) win.webContents.send(IPC.chatEvent, { kind: 'card', card, sessionId });
    };

    // 流式增量（节流 50ms 批量推送）
    let deltaBuf = '';
    let deltaTimer: NodeJS.Timeout | null = null;
    const flushDelta = () => {
      if (deltaBuf) {
        if (alive()) win.webContents.send(IPC.chatEvent, { kind: 'delta', text: deltaBuf, sessionId });
        deltaBuf = '';
      }
      deltaTimer = null;
    };

    rt.budget.startTask(`main-${sessionId}`);
    await rt.loop.run(p.text, p.mode as TaskMode, {
      onCard: sendCard,
      onDelta: (t) => {
        deltaBuf += t;
        if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 50);
      },
      onDone: (full) => {
        if (deltaTimer) flushDelta();
        if (!alive()) return;
        win.webContents.send(IPC.chatEvent, {
          kind: 'done',
          text: full,
          usage: rt.budget.snapshot(),
          sessionId,
        });
      },
      onBudgetSuspended: () => {
        if (!alive()) return;
        // 单个对象载荷：subscribe 只取第一个参数，拆成 (snapshot, sessionId)
        // 会让渲染层永远拿不到 sessionId → 挂起提示串到别的会话。
        win.webContents.send(IPC.budgetSuspended, {
          ...rt.budget.snapshot(),
          sessionId,
        });
      },
    });
    return true;
  });

  ipcMain.handle(IPC.chatAbort, async (_e, payload?: unknown) => {
    // 定向中止：只停目标会话，其它会话的任务照常跑（第 6 轮核心修复）。
    // 此前无论切会话还是点「停」，都 abort 全局唯一 loop → 连带掐死后台任务。
    const sessionId = resolveSessionId(
      (payload as { sessionId?: unknown } | undefined)?.sessionId
    );
    if (sessionId) {
      deps.sessions.abort(sessionId);
      const waiters = approvalWaitersBySession.get(sessionId);
      if (waiters) {
        for (const [token, resolve] of waiters) {
          waiters.delete(token);
          resolve(false);
        }
        approvalWaitersBySession.delete(sessionId);
      }
    }
    // 「停」即回到逐次审批（规格 4.7）
    gateway.setGoalPreAuthorized(false);
    return true;
  });

  // 新建对话：创建新会话并绑定。
  //
  // 第 6 轮：**不再 abort / reset**。此前这里无条件 loop.abort() + loop.reset()，
  // 用户在主任务执行中点「+ 新建对话」会把正在跑的任务当场掐断
  // （用户反馈：主任务「突然转到你那个其他的会话，然后快速停止」）。
  // 现在每个会话一份 AgentLoop（见 SessionRegistry），切会话只是切渲染分区，
  // 其它会话的运行态（messages / 流式 / 审批）完全不受影响。
  ipcMain.handle(
    IPC.chatNew,
    async (_e, payload?: unknown): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
    try {
      // 标题优先用首条用户消息前 24 字：左栏列表才有可辨识的标题，
      // 否则一屏全是「对话 2026/9/28 18:49」这种无信息量的时间戳。
      const raw = (payload as { title?: unknown } | undefined)?.title;
      const title = typeof raw === 'string' ? raw.trim().slice(0, 24) : '';
      const sess = await sidecar.call('session.create', { kind: 'main', title: title || `对话 ${new Date().toLocaleString('zh-CN')}` });
      const data = sess.data as { sessionId?: string } | undefined;
      if (sess.ok && data?.sessionId) {
        const newId = String(data.sessionId);
        // 为新会话建独立 runtime（此时还没有消息，loop 是干净的）
        deps.sessions.acquire(newId);
        return { ok: true, sessionId: newId };
      }
      return { ok: false, error: 'session create failed' };
    } catch (err) {
      logger.warn('new chat session create failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 切换会话：绑定目标会话并恢复历史消息为模型上下文（左栏对话列表点击）
  ipcMain.handle(
    IPC.chatSwitch,
    async (_e, payload: unknown): Promise<ChatSwitchResult> => {
    try {
      const p = z.object({ sessionId: z.string().min(1) }).parse(payload);
      // 第 6 轮：不再 abort/reset —— 切会话不得打断其它会话正在跑的任务。
      // 目标会话的 runtime 若存在（之前聊过），沿用它保持上下文与运行态。
      const rt = deps.sessions.acquire(p.sessionId);
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
            const tcs = parsePersistedToolCalls(r.toolCalls);
            if (tcs) m.tool_calls = tcs;
            // 旧存储下 assistant tool_calls 行 content 是 ''（null 序列化产物）；
            // OpenAI 兼容接口对带 tool_calls 的 assistant 期待 content=null
            if (role === 'assistant' && content === '' && tcs) {
              m.content = null;
            }
            return m;
          })
          // assistant 带 tool_calls 时 content 为 null，若按 content 过滤会留下孤立的
          // role='tool' 消息，OpenAI 兼容接口会报 400（tool 消息必须有前置 tool_calls）。
          .filter((m) => Boolean(m.content) || Array.isArray(m.tool_calls))
          // 清理孤立 tool 消息：前置 assistant tool_calls 行若缺失/解析失败（旧版双重
          // 编码、历史损坏），孤立的 tool 消息会让之后每一轮请求都 400 —— 整个会话
          // 的工具调用从此全部失败。丢弃孤儿行，保住会话可用性。
          .filter((m, i, arr) => {
            if (m.role !== 'tool') return true;
            return arr.slice(0, i).some((prev) => {
              if (prev.role !== 'assistant' || !Array.isArray(prev.tool_calls)) return false;
              const id = m.tool_call_id;
              if (!id) return true;
              return (prev.tool_calls as Array<{ id?: string }>).some((t) => t.id === id);
            });
          });
        rt.loop.loadMessages(history as never[]);
        // 回传渲染层用于重建对话流：否则左栏切换会话后中栏一片空白，用户以为历史丢了。
        // ⚠️ 不能用「content 非空」过滤：带 tool_calls 的 assistant 行 content 恰好是 null
        //    （上面刚归一过），一旦按 content 过滤就会把工具调用记录整条丢掉，
        //    只留下孤立的 role='tool' 行 —— 中栏变成一段无归属的原始 JSON，用户视角就是
        //    「切换后对话内容消失了」。
        //
        // 第 6 轮：工具行补 toolCalls 结构（此前只有一句「调用工具：xxx」文本），
        // 否则切回会话后右栏「工具流水」永远是空的 —— 它只认 type='tool-call' 的卡，
        // 而历史里从来没人生成过这种卡。args/result 都在主进程配好对，渲染层直接建卡。
        const flat = rows.map((r) => {
          const role = String(r.role ?? 'assistant');
          const rawC = r.content;
          let content: string | null = null;
          if (typeof rawC === 'string') {
            try {
              const parsed = JSON.parse(rawC) as unknown;
              content = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            } catch {
              content = rawC;
            }
          }
          return { role, content, toolCalls: parsePersistedToolCalls(r.toolCalls) };
        });
        return {
          ok: true,
          messages: history
            .filter((m) => Boolean(m.content) || Array.isArray(m.tool_calls) || m.role === 'tool')
            .map((m, i) => {
              // assistant 带 tool_calls 且无正文时，用工具名合成一句可读摘要，避免中栏空白
              let content = typeof m.content === 'string' ? m.content : null;
              let toolName: string | undefined;
              let toolCalls: ChatHistoryToolCall[] | undefined;
              if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                const calls = m.tool_calls as Array<{
                  function?: { name?: string; arguments?: string };
                }>;
                const names = calls.map((t) => t.function?.name).filter((n): n is string => Boolean(n));
                toolName = names.join(' / ');
                if (!content && toolName) content = `调用工具：${toolName}`;
                // 配对结果：OpenAI 格式下，assistant 的 N 个 tool_calls 之后紧跟 N 条
                // role='tool' 消息（按顺序）。据此把参数与结果填回，渲染层才能生成
                // 与实时运行同构的 ToolCallCard。
                const results: Array<string | null> = [];
                for (let k = 1; k <= calls.length; k++) {
                  const nxt = flat[i + k];
                  results.push(nxt && nxt.role === 'tool' ? nxt.content : null);
                }
                toolCalls = calls.map((t, k) => {
                  const argsRaw = String(t.function?.arguments ?? '');
                  let argsText = argsRaw;
                  let ok = true;
                  try {
                    const parsed = JSON.parse(argsRaw) as unknown;
                    argsText = JSON.stringify(parsed);
                    const res = results[k];
                    if (typeof res === 'string') {
                      const r2 = JSON.parse(res) as { ok?: boolean };
                      if (r2 && r2.ok === false) ok = false;
                    }
                  } catch {
                    ok = false;
                  }
                  return {
                    name: String(t.function?.name ?? 'tool'),
                    args: argsText.slice(0, 2000),
                    result: (results[k] ?? '').slice(0, 800),
                    ok,
                  };
                });
              }
              return {
                role: String(m.role),
                content,
                toolName,
                ...(toolCalls ? { toolCalls } : {}),
              };
            }),
        };
      }
      return { ok: true };
    } catch (err) {
      logger.warn('chat switch failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 主对话原点会话 id（启动时创建；chatNew 换会话不影响原点，左栏「主对话」回切用）
  ipcMain.handle(IPC.chatMainSession, async (): Promise<{ sessionId: string | null }> => {
    return { sessionId: deps.sessions.origin() };
  });

  // 各会话运行态（渲染层左栏标「运行中」圆点；切换后仍能看到后台任务在跑）
  ipcMain.handle(
    IPC.chatRunning,
    async (): Promise<{ running: string[] }> => {
      return { running: deps.sessions.ids().filter((id) => deps.sessions.isRunning(id)) };
    }
  );

  // 历史会话列表（左栏对话列表数据源）。
  // 之前渲染层的 convs.list 是纯内存的：应用一重启就只剩「主对话」，用户以为
  // 「对话记录丢了」。会话其实一直在 sidecar 的 sqlite 里，补一条读取 RPC 即可。
  ipcMain.handle(
    IPC.chatList,
    async (): Promise<{
      ok: boolean;
      sessions: Array<{ sessionId: string; title: string | null; createdAt: number }>;
      error?: string;
    }> => {
    try {
      const res = await sidecar.call('session.list', { kind: 'main', limit: 200 });
      if (!res.ok) return { ok: false, sessions: [], error: res.error?.message ?? 'session.list failed' };
      const rows =
        (res.data as { sessions?: Array<{ sessionId?: unknown; title?: unknown; createdAt?: unknown }> } | undefined)
          ?.sessions ?? [];
      return {
        ok: true,
        sessions: rows
          .map((r) => ({
            sessionId: String(r.sessionId ?? ''),
            title: r.title == null ? null : String(r.title),
            createdAt: Number(r.createdAt ?? 0),
          }))
          .filter((r) => r.sessionId.length > 0),
      };
    } catch (err) {
      logger.warn('chat list failed', err);
      return { ok: false, sessions: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 用首条用户消息回填会话标题（左栏可辨识）。
  // 会话 id 由渲染层显式传入：并行会话下「当前会话」在主进程已无单一概念，
  // 若继续用 loop.getMainSessionId() 就会把 A 会的标题写到 B 会上。
  ipcMain.handle(IPC.chatRename, async (_e, payload: unknown): Promise<boolean> => {
    try {
      const raw = (payload as { title?: unknown; sessionId?: unknown } | undefined) ?? {};
      const title = String(raw.title ?? '').trim();
      const sid = resolveSessionId(raw.sessionId);
      if (!title || !sid) return false;
      const res = await sidecar.call('session.rename', { sessionId: sid, title: title.slice(0, 24) });
      return res.ok;
    } catch (err) {
      logger.warn('chat rename failed', err);
      return false;
    }
  });

  // 删除会话：级联删掉 sidecar 里的 sessions + messages 行。
  // 第 6 轮：**不再 abort 全局 loop / reset**。删除只影响目标会话：
  //   - 该会话正在跑 → 只 abort 它（否则删掉后台正在跑的任务仍会继续写库）；
  //   - 其余会话的 loop/流式/审批完全不动。
  // 渲染层负责在删除当前会话后切到别的会话（它才有 activeId 概念）。
  ipcMain.handle(
    IPC.chatDelete,
    async (_e, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      const p = z.object({ sessionId: z.string().min(1) }).parse(payload);
      const res = await sidecar.call('session.delete', { sessionId: p.sessionId });
      if (!res.ok) return { ok: false, error: res.error?.message ?? 'session.delete failed' };
      // 回收该会话的 runtime（含 abort + 结算其审批等待）
      deps.sessions.drop(p.sessionId);
      const waiters = approvalWaitersBySession.get(p.sessionId);
      if (waiters) {
        for (const [token, resolve] of waiters) {
          waiters.delete(token);
          resolve(false);
        }
        approvalWaitersBySession.delete(p.sessionId);
      }
      gateway.setGoalPreAuthorized(false);
      return { ok: true };
    } catch (err) {
      logger.warn('chat delete failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---------- Goal 预授权（M4，规格 4.7） ----------
  ipcMain.handle(IPC.goalPreauthorize, async (_e, payload: unknown): Promise<boolean> => {
    const p = GoalPreauthorizeSchema.parse(payload);
    // 三项全部勾选才开启；任一不勾选则维持逐次审批
    const all = p.confirmWorkspaceWrites && p.confirmWhitelistCommands && p.confirmBudget;
    gateway.setGoalPreAuthorized(all);
    return all;
  });

  // ---------- 审批响应（等待表与 listener 已在「对话」段之前注册一次） ----------
  // sessionId 必带：token 在各自会话的等待表里，缺省无法定位是哪条审批。
  ipcMain.handle(IPC.approvalRespond, async (_e, payload: unknown): Promise<boolean> => {
    const p = ApprovalRespondSchema.parse(payload);
    const sid = resolveSessionId(p.sessionId);
    if (!sid) return false;
    const waiters = approvalWaitersBySession.get(sid);
    const waiter = waiters?.get(p.approvalToken);
    if (waiter) {
      waiters!.delete(p.approvalToken);
      waiter(p.approved);
      return true;
    }
    return false;
  });

  // ---------- 预算 ----------
  // 多会话并行后预算按会话独立计量：快照必须把所有 runtime 相加，
  // 否则用户同时跑两条任务，顶栏/设置页只显示一条的消耗。
  ipcMain.handle(IPC.usageSnapshot, async (): Promise<UsageSnapshot> => {
    const total = deps.sessions.totalUsage();
    const limits = settings.get('budget');
    return {
      today: {
        promptTokens: total.task.promptTokens,
        completionTokens: total.task.completionTokens,
        costCNY: total.task.costCNY,
      },
      currentTask: {
        promptTokens: total.task.promptTokens,
        completionTokens: total.task.completionTokens,
        costCNY: total.task.costCNY,
        turns: total.turns,
      },
      budget: {
        turnsLimit: limits.turnsLimit,
        tokenLimit: limits.tokenLimit,
        costLimitCNY: limits.costLimitCNY,
        suspended: total.suspended,
      },
    };
  });

  ipcMain.handle(IPC.budgetRespond, async (_e, payload: unknown): Promise<boolean> => {
    const p = BudgetRespondSchema.parse(payload);
    const sid = resolveSessionId(p.sessionId);
    if (p.action === 'extend') {
      // 续预算按会话发放：把新上限写到发起该请求的会话账上。
      // 缺省时退化为「所有会话都续」——旧调用方只有全局预算一个概念。
      const targets = sid ? [sid] : deps.sessions.ids();
      for (const id of targets) {
        deps.sessions.acquire(id).budget.extend(p.newTokenLimit, p.newCostLimitCNY);
      }
    } else if (p.action === 'terminate') {
      // 终止只停目标会话；其余会话的预算熔断状态不受影响
      if (sid) deps.sessions.abort(sid);
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
    const recoverySession = resolveSessionId(
      (payload as { sessionId?: unknown } | undefined)?.sessionId
    );
    for (const name of p.names) {
      if (p.action === 'resume') {
        // 恢复：释放过期锁 + 加载最后检查点回放给对话流
        await sidecar.call('lock.release', { name }).catch(() => undefined);
        const ckpt = await sidecar.call('ckpt.load', { taskId: name }).catch(() => undefined);
        const win = mainWindowRef();
        if (win && ckpt?.ok) {
          // 带 sessionId：并行会话下这条「恢复」提示必须落回对应会话的流
          win.webContents.send(IPC.chatEvent, {
            kind: 'done',
            text: `【崩溃恢复】任务 ${name} 已从最后检查点恢复。\n检查点内容：${JSON.stringify((ckpt.data as { payload?: unknown })?.payload ?? {}).slice(0, 2000)}`,
            ...(recoverySession ? { sessionId: recoverySession } : {}),
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
  /** 目标会话 id（第 6 轮并行隔离：渲染层必须显式指定，缺省回落原点会话） */
  sessionId: z.string().min(1).optional(),
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
  /** 审批卡所属会话（第 6 轮：等待表按会话分桶，缺省无法定位） */
  sessionId: z.string().min(1).optional(),
});

const BudgetRespondSchema = z.object({
  action: z.enum(['extend', 'reduce', 'terminate']),
  newTokenLimit: z.number().optional(),
  newCostLimitCNY: z.number().optional(),
  /** 预算所属会话；缺省时 extend 作用于全部会话、terminate 不执行 */
  sessionId: z.string().min(1).optional(),
});

/**
 * 解析持久化的 tool_calls 字段，兼容两代存储：
 *  - 新版（sidecar as_str 取参）：单层 JSON 字符串
 *  - 旧版（sidecar Value::to_string 存参）：双重编码字符串
 * 解不出数组返回 undefined，由调用方按「tool_calls 缺失」处理
 * （孤立 tool 消息会被后续过滤规则清理，避免 API 400 打断整个会话）。
 */
function parsePersistedToolCalls(raw: unknown): unknown[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let v: unknown = raw;
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(v) ? v : undefined;
}

// 向导模板映射（与 shared VENDOR_TEMPLATES 同步）
const VENDOR_TEMPLATES_MAP: Record<string, { endpoint: string; defaultModel: string; pricing: { promptPerM: number; completionPerM: number } }> = {
  deepseek: { endpoint: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', pricing: { promptPerM: 2, completionPerM: 8 } },
  zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', pricing: { promptPerM: 0.1, completionPerM: 0.1 } },
  qwen: { endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', pricing: { promptPerM: 0.8, completionPerM: 2 } },
  moonshot: { endpoint: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k', pricing: { promptPerM: 12, completionPerM: 12 } },
  ollama: { endpoint: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder:7b', pricing: { promptPerM: 0, completionPerM: 0 } },
  lmstudio: { endpoint: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model', pricing: { promptPerM: 0, completionPerM: 0 } },
};
