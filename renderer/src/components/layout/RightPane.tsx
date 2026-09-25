// 右栏：上下文侧栏（改动文件/审批队列/终端标签/交接物/审计/用量）
import { Show, For } from 'solid-js';

import { bridge } from '../../ipc/client';
import { cards, usage } from '../../state/stores';
import { UsagePanel } from '../usage/UsagePanel';

export function RightPane() {
  const b = bridge();
  const pendingApprovals = () => cards.list.filter((c) => c.type === 'approval' && c.status === 'pending');
  const toolCalls = () => cards.list.filter((c) => c.type === 'tool-call');

  return (
    <aside class="right-pane">
      <UsagePanel />

      <div class="pane-title">审批队列</div>
      <Show
        when={pendingApprovals().length > 0}
        fallback={<div class="pane-empty">无待审批事项</div>}
      >
        <For each={pendingApprovals()}>
          {(c) => {
            const card = c as unknown as { risk: string; title: string };
            return (
              <div class={`approval-mini ${card.risk === 'high' ? 'risk-high' : ''}`}>{card.title}</div>
            );
          }}
        </For>
      </Show>

      <Show when={usage.budget.suspended}>
        <div class="budget-suspend">
          <div class="pane-title danger-text">预算熔断</div>
          <div class="small">本任务已消耗：</div>
          <div class="mono small">
            {usage.currentTask.promptTokens + usage.currentTask.completionTokens} tok · ¥
            {usage.currentTask.costCNY.toFixed(4)} · {usage.currentTask.turns} 轮
          </div>
          <button
            class="primary full"
            onClick={() =>
              b.budgetRespond({ action: 'extend', newTokenLimit: (usage.budget.tokenLimit || 0) + 500000 })
            }
          >
            续预算
          </button>
          <button class="full" onClick={() => b.budgetRespond({ action: 'reduce' })}>
            缩减范围
          </button>
          <button class="danger full" onClick={() => b.budgetRespond({ action: 'terminate' })}>
            终止任务
          </button>
        </div>
      </Show>

      <div class="pane-title">工具流水</div>
      <div class="tool-log">
        <For each={toolCalls().slice(-20).reverse()}>
          {(t) => (
            <div class={`tool-row ${t.ok ? 'ok' : 'bad'}`}>
              <span class="mono">{t.tool}</span>
              <span>{t.ok ? '✓' : '✗'}</span>
            </div>
          )}
        </For>
        <Show when={toolCalls().length === 0}>
          <div class="pane-empty">暂无工具调用</div>
        </Show>
      </div>
    </aside>
  );
}
