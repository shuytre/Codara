// 全局 signals stores：对话流 / 卡片 / 用量 / 设置 / UI
import { createStore, produce } from 'solid-js/store';

import type { Card, ChatEntry, SettingsPayload, UsageSnapshot } from '@codara/contract';

export const [chat, setChat] = createStore({
  entries: [] as ChatEntry[],
  streaming: false,
  streamText: '',
  mode: 'plan' as 'ask' | 'plan' | 'goal',
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

export function budgetProgress(): number {
  const b = usage.budget;
  if (b.tokenLimit) {
    const used = usage.currentTask.promptTokens + usage.currentTask.completionTokens;
    return Math.min(1, used / b.tokenLimit);
  }
  return b.turnsLimit > 0 ? Math.min(1, usage.currentTask.turns / b.turnsLimit) : 0;
}
