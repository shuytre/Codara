// 用量面板：今日/本任务 token 与预估费用、预算上限进度条（U9）
import { Show, createResource } from 'solid-js';

import { bridge } from '../../ipc/client';
import { usage } from '../../state/stores';

export function UsagePanel() {
  const b = bridge();
  const [, { refetch }] = createResource(async () => {
    const snap = await b.usageSnapshot();
    return snap;
  });

  const totalTokens = () => usage.currentTask.promptTokens + usage.currentTask.completionTokens;
  const progress = () => {
    const b = usage.budget;
    if (b.tokenLimit) return Math.min(1, totalTokens() / b.tokenLimit);
    if (b.costLimitCNY) return Math.min(1, usage.currentTask.costCNY / b.costLimitCNY);
    return b.turnsLimit > 0 ? Math.min(1, usage.currentTask.turns / b.turnsLimit) : 0;
  };

  return (
    <div class="usage-panel">
      <div class="pane-title">用量与花费</div>
      <div class="usage-grid">
        <div>
          <span class="label">本任务</span>
          <span class="mono">{totalTokens()} tok</span>
        </div>
        <div>
          <span class="label">预估费用</span>
          <span class="mono">¥{usage.currentTask.costCNY.toFixed(4)}</span>
        </div>
        <div>
          <span class="label">轮次</span>
          <span class="mono">
            {usage.currentTask.turns}/{usage.budget.turnsLimit}
          </span>
        </div>
        <div>
          <span class="label">今日</span>
          <span class="mono">¥{usage.today.costCNY.toFixed(4)}</span>
        </div>
      </div>
      <div class="budget-bar">
        <div class="budget-fill" classList={{ warn: progress() > 0.8 }} style={{ width: `${progress() * 100}%` }} />
      </div>
      <div class="small hint">
        <Show when={usage.budget.tokenLimit}>token 上限 {usage.budget.tokenLimit}</Show>
        <Show when={usage.budget.costLimitCNY}>费用上限 ¥{usage.budget.costLimitCNY}</Show>
        <Show when={!usage.budget.tokenLimit && !usage.budget.costLimitCNY}>按轮次熔断（{usage.budget.turnsLimit} 轮）</Show>
      </div>
    </div>
  );
}
