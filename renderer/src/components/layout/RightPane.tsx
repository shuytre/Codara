// 右栏：上下文侧栏（改动文件/审批队列/终端标签/交接物/审计/用量）
//
// 第 6 轮：数据源改为**当前会话分区**（activeCards）。
// 此前读全局 cards.list：切会话后右栏仍显示另一个会话的工具流水，
// 而新会话因为历史路径从不生成 tool-call 卡，就恒为「暂无工具调用」。
import { Show, For, createMemo } from 'solid-js';

import { bridge } from '../../ipc/client';
import { activeCards, activeKey, convs, usage } from '../../state/stores';
import { UsagePanel } from '../usage/UsagePanel';

export function RightPane() {
  const b = bridge();
  const key = createMemo(() => activeKey());
  const pendingApprovals = createMemo(() => activeCards().filter((c) => c.type === 'approval' && c.status === 'pending'));
  const toolCalls = createMemo(() => activeCards().filter((c) => c.type === 'tool-call'));
  // 续预算/终止必须作用于发起请求的那个会话的账
  const targetSession = () => key();

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
              b.budgetRespond({
                action: 'extend',
                newTokenLimit: (usage.budget.tokenLimit || 0) + 500000,
                sessionId: targetSession(),
              })
            }
          >
            续预算
          </button>
          <button class="full" onClick={() => b.budgetRespond({ action: 'reduce', sessionId: targetSession() })}>
            缩减范围
          </button>
          <button class="danger full" onClick={() => b.budgetRespond({ action: 'terminate', sessionId: targetSession() })}>
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
