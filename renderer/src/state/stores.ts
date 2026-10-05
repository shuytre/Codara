// 全局 signals stores：对话流 / 卡片 / 用量 / 设置 / UI
//
// 第 6 轮：**按会话分区**。
// 此前 chat.entries 与 cards.list 是两份全局数组，而主对话只有一个 AgentLoop，
// 于是「切会话」只能靠清空重建来实现 —— 副作用是另一个会话正在跑的任务
// 被连带清掉（用户反馈：主任务突然转到别的会话然后快速停止）。
// 现在改为：每个 sessionId 一份 entries/cards 分区，切换只是换一个 activeId，
// 后台会话的流式与工具流水继续按自己的分区累积，切回来即可看到完整现场。
import { createStore, produce } from 'solid-js/store';

import type { Card, ChatEntry, SettingsPayload, UsageSnapshot } from '@codara/contract';

/** 左栏「主对话」占位 id：真实 sessionId 尚未从主进程拿到时用它兜底 */
export const MAIN_KEY = '__main__';

/** 单个会话的对话流状态 */
export interface SessionChatState {
  entries: ChatEntry[];
  /** 本会话正在流式输出（用于「正在思考…」指示器） */
  streaming: boolean;
  streamText: string;
  /** 本轮流式回复的文本条目 id：delta 的实时挂载点，done 时收尾 */
  liveId: string | null;
  /**
   * 本轮工具执行过程的分组 id（第 8 轮）。
   *
   * 一轮用户任务从**首次 tool_calls** 起进入「执行过程」阶段，此后所有
   * step 摘要与工具卡都挂在这个 gid 下，由渲染层收进同一个折叠容器。
   * 用户发出新提问时清空（新一轮 = 新容器）。
   */
  liveProcessGroup: string | null;
}

function emptyChatState(): SessionChatState {
  return { entries: [], streaming: false, streamText: '', liveId: null, liveProcessGroup: null };
}

export const [chat, setChat] = createStore<{
  /** sessionId -> 会话流分区 */
  bySession: Record<string, SessionChatState>;
  mode: 'ask' | 'plan' | 'goal'; // 默认极简模式（纯问答零工具）
}>({ bySession: {}, mode: 'ask' });

/** 左栏会话列表（Codex/豆包式）：主对话固定首位，新建的对话追加 */
export interface ConversationItem {
  sessionId: string;
  title: string;
  createdAt: number;
}
export const [convs, setConvs] = createStore<{
  list: ConversationItem[];
  /** 当前查看的会话；null = 主对话 */
  activeId: string | null;
  /** 正在跑任务的会话 id 集合（左栏「运行中」标点） */
  running: string[];
  /**
   * 主对话的真实 sessionId（启动时主进程创建）。
   * 必须存：主对话在左栏是固定项、不在 list 里，但事件是按真实 sessionId 回来的 ——
   * 没有它，主对话的流式/工具卡就落不到任何分区（表现为「主对话突然没反应」）。
   */
  mainId: string | null;
}>({ list: [], activeId: null, running: [], mainId: null });

export function addConversation(item: ConversationItem): void {
  setConvs('list', (prev) => [...prev, item]);
  setConvs('activeId', item.sessionId);
}

export function setActiveConversation(sessionId: string | null): void {
  setConvs('activeId', sessionId);
}

export function removeConversation(sessionId: string): void {
  setConvs('list', (prev) => prev.filter((c) => c.sessionId !== sessionId));
  setConvs('activeId', (prev) => (prev === sessionId ? null : prev));
  setConvs('running', (prev) => prev.filter((id) => id !== sessionId));
  // 分区一并丢弃：否则删掉的会话仍占内存，且重新创建同 id 会话时读到旧残留
  setChat('bySession', sessionId, undefined as never);
  setCards('bySession', sessionId, undefined as never);
  setUi('pendingApprovals', (q) => q.filter((c) => c.sessionId !== sessionId));
}

/** 标记/取消标记某会话正在运行 */
export function setSessionRunning(sessionId: string, running: boolean): void {
  setConvs('running', (prev) => {
    const has = prev.includes(sessionId);
    if (running) return has ? prev : [...prev, sessionId];
    return has ? prev.filter((id) => id !== sessionId) : prev;
  });
}

export function isSessionRunning(sessionId: string): boolean {
  return convs.running.includes(sessionId);
}

/** 当前查看的会话 key：主对话用真实 sessionId（未就绪时退回占位 key） */
export function activeKey(): string {
  if (convs.activeId) return convs.activeId;
  return convs.mainId ?? MAIN_KEY;
}

/** 当前会话的流状态（不存在时返回一个稳定的空对象视图） */
export function activeChat(): SessionChatState {
  return chat.bySession[activeKey()] ?? emptyChatState();
}

export const [cards, setCards] = createStore<{ bySession: Record<string, Card[]> }>({ bySession: {} });

/** 当前会话的卡片列表（右栏工具流水 / 审批队列的数据源） */
export function activeCards(): Card[] {
  return cards.bySession[activeKey()] ?? [];
}

export const [usage, setUsage] = createStore<UsageSnapshot>({
  today: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
  currentTask: { promptTokens: 0, completionTokens: 0, costCNY: 0, turns: 0 },
  budget: { turnsLimit: 200, suspended: false },
});

export const [settings, setSettings] = createStore<{ value: SettingsPayload | null }>({ value: null });

/** M3：专家团实例视图（左栏角色树） */
export const [crew, setCrew] = createStore<{
  tasks: import('@codara/contract').CrewTaskView[];
  instances: Record<string, import('@codara/contract').CrewInstanceView>;
}>({ tasks: [], instances: {} });

export const [ui, setUi] = createStore({
  rightPaneVisible: true,
  budgetDialogOpen: false,
  settingsOpen: false,
  /** 全局轻提示（toast）：非阻塞，MainLayout 自动清除 */
  toast: '' as string,
  /** 待处理审批队列：模型可能并行发起多个 ask 级工具，必须排队而非覆盖 */
  pendingApprovals: [] as import('@codara/contract').ApprovalCard[],
});

/** 队首审批卡（渲染为阻塞横幅）；队列为空返回 null */
export function headApproval(): import('@codara/contract').ApprovalCard | null {
  return ui.pendingApprovals[0] ?? null;
}

/** 入队待审批卡（同 token 幂等，避免重复 push 造成堆叠） */
export function setApprovalCard(card: import('@codara/contract').ApprovalCard | null): void {
  if (!card) {
    setUi('pendingApprovals', []);
    return;
  }
  setUi('pendingApprovals', produce((q: import('@codara/contract').ApprovalCard[]) => {
    if (!q.some((c) => c.approvalToken === card.approvalToken)) q.push(card);
  }));
}

/**
 * 裁决审批卡：三处引用必须同步，否则会残留「待审批」横幅。
 *  - cards.bySession（right pane 审批队列）
 *  - ui.pendingApprovals（阻塞横幅队列）
 *  - chat.bySession[*].entries[].cards（聊天流内嵌卡片，由 attachCardToLive 写入）
 * 已裁决的卡保留在 cards 里供审计追溯。
 *
 * 第 6 轮：跨会话查找 —— 审批卡可能属于后台会话（用户已切走），
 * 只在当前分区里找会永远找不到，结果是横幅关不掉、工具永久挂起。
 */
export function resolveApprovalCard(token: string, approved: boolean): void {
  const next = (approved ? 'approved' : 'rejected') as Card['status'];
  setCards('bySession', produce((bySession) => {
    for (const key of Object.keys(bySession)) {
      const list = bySession[key];
      if (!list) continue;
      const idx = list.findIndex((c) => c.type === 'approval' && (c as { approvalToken?: string }).approvalToken === token);
      if (idx >= 0) list[idx] = { ...list[idx]!, status: next } as Card;
    }
  }));
  setUi('pendingApprovals', (q) => q.filter((c) => c.approvalToken !== token));
  setChat('bySession', produce((bySession) => {
    for (const key of Object.keys(bySession)) {
      const st = bySession[key];
      if (!st) continue;
      for (const e of st.entries) {
        const list = e.cards;
        if (!list) continue;
        const idx = list.findIndex((c) => c.type === 'approval' && (c as { approvalToken?: string }).approvalToken === token);
        if (idx >= 0) list[idx] = { ...list[idx]!, status: next } as Card;
      }
    }
  }));
}

// ---------- 会话分区读写内部helper ----------

/** 取（必要时创建）某会话的流状态。分区必须**就地 mutate**，不能返回临时对象，
 *  否则 Solid 的 store 代理写不进去（表现为「切回会话内容又没了」）。 */
function state(key: string): SessionChatState {
  const existing = chat.bySession[key];
  if (existing) return existing;
  setChat('bySession', key, emptyChatState());
  return chat.bySession[key]!;
}

function cardList(key: string): Card[] {
  const existing = cards.bySession[key];
  if (existing) return existing;
  setCards('bySession', key, []);
  return cards.bySession[key]!;
}

export function appendEntry(key: string, e: ChatEntry): void {
  const st = state(key);
  setChat('bySession', key, 'entries', (prev) => [...prev, e]);
  void st;
}

/**
 * 写入/更新某会话的一张卡片。
 *
 * 第 7 轮修「右栏工具流水恒为『暂无工具调用』」：
 * 此前用 `setCards('bySession', key, produce(...))`。当 `bySession[key]` 还不存在时
 * （每个新会话的**第一次**卡片必然如此），Solid 对**函数式/produce 更新 + 不存在的路径**
 * 会**静默丢弃** —— 不抛错、什么都不写。于是聊天流照常出现工具卡（那条路径用的是
 * 直接赋值，能正常创建），但右栏读 `cards.bySession[key]` 永远拿到 undefined，
 * 表现就是「明明有工具调用，右栏却说暂无」。
 *
 * 改为读-改-写直接赋值：新会话首张卡片由此正常创建。
 * 顺带保证传入的 card 对象不被 store 代理污染（后续外部读到的就是原对象）。
 */
export function upsertCard(key: string, card: Card): void {
  const list = cards.bySession[key] ?? [];
  const idx = list.findIndex((c) => c.id === card.id);
  const next = idx >= 0 ? list.map((c, i) => (i === idx ? card : c)) : [...list, card];
  setCards('bySession', key, next);
}

/** 清空某会话的流与卡片（新建/切换会话时只清目标会话） */
export function clearSession(key: string): void {
  setChat('bySession', key, emptyChatState());
  setCards('bySession', key, []);
}

// ---------- 流式回复的实时挂载 ----------

/**
 * 第 8 轮：把「执行过程」与「最终回复」分成两类条目。
 *
 * 结构（一轮用户任务）：
 *   user(提问)
 *   ├─ process 分组 G  ← 折叠容器「已完成」
 *   │    step  「读取配置文件」     ← 模型给的一句话摘要
 *   │    card   read · path=a.json ← 工具卡
 *   │    step  「执行安装依赖」
 *   │    card   terminal · command=npm i
 *   └─ final  「已完成，改动是…」   ← 折叠容器**下方**
 *
 * 为什么要分组 id 而不是靠数组位置：工具卡事件与文本事件是异步到达的，
 * 且同一轮里可能穿插多条 step。用 groupId 显式归属，渲染层才能稳定地把
 * 它们收进同一个容器，不依赖到达顺序。
 */

/** 开始一个新过程分组（本轮首次 tool_calls 时创建） */
function ensureProcessGroup(key: string): string {
  const st = state(key);
  if (st.liveProcessGroup) return st.liveProcessGroup;
  const gid = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setChat('bySession', key, 'liveProcessGroup', gid);
  // 分组本身不产条目，只是给后续 step/card 打标；容器由渲染层按 groupId 聚合
  return gid;
}

/** 确保存在本轮 live 文本条目（首个 delta 到达时创建） */
function ensureLiveEntry(key: string): string {
  const st = state(key);
  if (st.liveId) return st.liveId;
  const id = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setChat('bySession', key, 'liveId', id);
  setChat('bySession', key, 'entries', (prev) => [
    ...prev,
    // 第 8 轮：显式标为 final（最终回复），渲染在折叠容器下方
    { id, role: 'assistant' as const, kind: 'final' as const, text: '', createdAt: Date.now() },
  ]);
  return id;
}

/**
 * 工具调用的步骤标题（模型给的摘要）。
 *
 * 渲染成折叠容器里的一行：`🔧 read 读取配置文件`。
 * text 为空串时仍建条目（渲染层回退到参数摘要），保证每步都有标题。
 */
export function appendProcessStep(key: string, text: string): void {
  const gid = ensureProcessGroup(key);
  const id = `ps-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setChat('bySession', key, 'entries', (prev) => [
    ...prev,
    {
      id,
      role: 'event' as const,
      kind: 'step' as const,
      processGroup: gid,
      text: text ?? '',
      createdAt: Date.now(),
    },
  ]);
}

/** 流式增量直接写入 live 条目 */
export function appendDeltaToLive(key: string, text: string): void {
  if (!text) return;
  const id = ensureLiveEntry(key);
  setChat('bySession', key, 'entries', (e) => e.id === id, produce((e: ChatEntry) => {
    e.text = (e.text ?? '') + text;
  }));
}

/**
 * 卡片 upsert：同 id 覆盖状态更新（running → done/failed 实时可见）。
 * - 已在某个 entry 里（状态更新）→ 就地替换
 * - 新卡片 → 追加为独立 entry，保持与文本的真实先后
 */
export function attachCardToLive(key: string, card: Card): void {
  const withSession = card.sessionId ? card : { ...card, sessionId: key };
  upsertCard(key, withSession);
  const st = state(key);
  // 状态更新：卡片已在流里，就地替换（可能跨 entry，罕见但要正确）
  for (const e of st.entries) {
    const list = e.cards;
    if (!list) continue;
    const ci = list.findIndex((c) => c.id === withSession.id);
    if (ci >= 0) {
      setChat('bySession', key, 'entries', (x) => x.id === e.id, 'cards', ci, withSession as Card);
      return;
    }
  }
  // 新卡片：独立 entry（role='event'），从而保留真实事件顺序
  // 第 8 轮：归属到当前过程分组（同一轮的所有工具卡收进同一个折叠容器）。
  const gid = ensureProcessGroup(key);
  const id = `ev-${withSession.id}`;
  setChat('bySession', key, 'entries', (prev) => [
    ...prev,
    {
      id,
      role: 'event' as const,
      kind: 'process' as const,
      processGroup: gid,
      text: '',
      createdAt: withSession.createdAt,
      cards: [withSession],
    },
  ]);
  // 第 7 轮：插卡即**收尾当前 live 文本条目**。
  //
  // 此前 liveId 在插卡后不清空，于是工具调用之后模型继续输出的文字会被
  // appendDeltaToLive 塞回**原来那个** live entry —— 而那个 entry 排在工具卡
  // 之前，于是结尾文字在渲染上「回到最前面」，与真实顺序相反。
  // 用户原话：「又是先输出文字、调用工具后，结尾不是连在工具调用的后面输出，
  // 而是回到最前面。」
  //
  // 收尾后 liveId 置空，下一个 delta 会另起新 entry，落在工具卡之后，顺序即真实。
  if (st.liveId) {
    setChat('bySession', key, 'liveId', null);
  }
}

/**
 * 收尾本轮 live 条目：写入最终文本与元信息，解除 live 标记。
 *
 * `isFinal=false` 表示这条文本是终止/错误说明，**不是**模型的最终回复：
 * 标成 system 并去掉 final 标记，避免它被当成正文留在会话里
 * （历史上「（已终止）」曾以 assistant 正文身份入档，重开会话看着像模型真的这么说）。
 * 同时清空过程分组，让下一次提问从干净状态开始。
 */
export function finalizeLiveEntry(
  key: string,
  finalText?: string,
  meta?: { model?: string; effort?: string; usage?: { promptTokens: number; completionTokens: number } },
  isFinal = true
): void {
  const st = state(key);
  const id = st.liveId;
  setChat('bySession', key, 'liveId', null);
  setChat('bySession', key, 'liveProcessGroup', null);
  if (!id) {
    // 无 live 条目（如异常直接 done）：回退为独立条目
    if (finalText) {
      setChat('bySession', key, 'entries', (prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: (isFinal ? 'assistant' : 'system') as 'assistant' | 'system',
          kind: isFinal ? ('final' as const) : undefined,
          text: finalText,
          createdAt: Date.now(),
          ...meta,
        },
      ]);
    }
    return;
  }
  setChat('bySession', key, 'entries', (e) => e.id === id, produce((e: ChatEntry) => {
    if (finalText !== undefined && finalText !== '') e.text = finalText;
    if (meta?.model) e.model = meta.model;
    if (meta?.effort) e.effort = meta.effort;
    if (meta?.usage) e.usage = meta.usage;
    if (!isFinal) {
      // 终止/错误说明：降级为系统提示，不再是「最终回复」
      e.role = 'system';
      e.kind = undefined;
    }
  }));
}

/** 置某会话的流式状态 */
export function setStreaming(key: string, streaming: boolean): void {
  state(key);
  setChat('bySession', key, { streaming, streamText: '' });
}

// ---------- 审批卡按会话隔离 ----------

/** 某会话队首审批卡（未指定则取当前会话） */
export function headApprovalFor(key: string): import('@codara/contract').ApprovalCard | null {
  return ui.pendingApprovals.find((c) => (c.sessionId ?? MAIN_KEY) === key) ?? null;
}

export function budgetProgress(): number {
  const b = usage.budget;
  if (b.tokenLimit) {
    const used = usage.currentTask.promptTokens + usage.currentTask.completionTokens;
    return Math.min(1, used / b.tokenLimit);
  }
  return b.turnsLimit > 0 ? Math.min(1, usage.currentTask.turns / b.turnsLimit) : 0;
}
