// 全局 signals stores：对话流 / 卡片 / 用量 / 设置 / UI
import { createStore, produce } from 'solid-js/store';

import type { Card, ChatEntry, SettingsPayload, UsageSnapshot } from '@codara/contract';

export const [chat, setChat] = createStore({
  entries: [] as ChatEntry[],
  streaming: false,
  streamText: '',
  mode: 'plan' as 'ask' | 'plan' | 'goal',
  /** 本轮流式回复的条目 id：卡片/增量实时挂载点，done 时收尾 */
  liveId: null as string | null,
});

export const [cards, setCards] = createStore<{ list: Card[] }>({ list: [] });

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
});

export function appendEntry(e: ChatEntry): void {
  setChat('entries', (prev) => [...prev, e]);
}

export function upsertCard(card: Card): void {
  setCards('list', produce((list) => {
    const idx = list.findIndex((c) => c.id === card.id);
    if (idx >= 0) {
      list[idx] = card;
    } else {
      list.push(card);
    }
  }));
}

// ---------- 流式回复的实时挂载（卡片与增量统一进当前 assistant 条目） ----------

/** 确保存在本轮 live assistant 条目（首个 delta/卡片到达时创建） */
export function ensureLiveEntry(): string {
  if (chat.liveId) return chat.liveId;
  const id = `a-${Date.now()}`;
  setChat({ liveId: id });
  setChat('entries', (prev) => [...prev, { id, role: 'assistant', text: '', createdAt: Date.now(), cards: [] }]);
  return id;
}

/** 流式增量直接写入 live 条目 */
export function appendDeltaToLive(text: string): void {
  if (!text) return;
  const id = ensureLiveEntry();
  setChat('entries', (e) => e.id === id, 'text', (t) => t + text);
}

/** 卡片 upsert 到 live 条目（同 id 覆盖：running → done/failed 状态更新实时可见） */
export function attachCardToLive(card: Card): void {
  upsertCard(card);
  const id = ensureLiveEntry();
  setChat('entries', (entries) => {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return entries;
    const e = entries[idx]!;
    const list = e.cards ?? [];
    const ci = list.findIndex((c) => c.id === card.id);
    const next = ci >= 0 ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card];
    const updated = [...entries];
    updated[idx] = { ...e, cards: next };
    return updated;
  });
}

/** 收尾本轮 live 条目：写入最终文本与元信息，解除 live 标记 */
export function finalizeLiveEntry(
  finalText?: string,
  meta?: { model?: string; effort?: string; usage?: { promptTokens: number; completionTokens: number } }
): void {
  const id = chat.liveId;
  setChat({ liveId: null });
  if (!id) {
    // 无 live 条目（如异常直接 done）：回退为独立条目
    if (finalText) {
      appendEntry({ id: `a-${Date.now()}`, role: 'assistant', text: finalText, createdAt: Date.now(), ...meta });
    }
    return;
  }
  setChat('entries', (e) => e.id === id, (e) => ({
    ...e,
    text: finalText !== undefined && finalText !== '' ? finalText : e.text,
    ...meta,
  }));
}

export function budgetProgress(): number {
  const b = usage.budget;
  if (b.tokenLimit) {
    const used = usage.currentTask.promptTokens + usage.currentTask.completionTokens;
    return Math.min(1, used / b.tokenLimit);
  }
  return b.turnsLimit > 0 ? Math.min(1, usage.currentTask.turns / b.turnsLimit) : 0;
}
