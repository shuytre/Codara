// 中栏对话流：用户消息 / Agent 回复（Markdown）/ 实时卡片 / 打字指示
// 第 6 轮：只渲染**当前会话**的分区；条目顺序即真实事件顺序
// （文本与工具卡是彼此独立的 entry，不再固定「先文本后卡片」）
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import { activeChat, activeKey, headApprovalFor, resolveApprovalCard, ui } from '../../state/stores';
import { renderMarkdown } from '../../util/markdown';
import { CardRenderer } from '../cards/CardRenderer';
import { bridge } from '../../ipc/client';

export function ConversationStream() {
  let container: HTMLDivElement | undefined;
  // 当前会话的流（会话切换时整体换掉）
  const view = createMemo(() => activeChat());
  // 只保留有可渲染内容的条目：空文本且无卡片的 live entry 不占位
  const visibleEntries = createMemo(() =>
    view().entries.filter((e) => (e.text ?? '').length > 0 || (e.cards && e.cards.length > 0)),
  );

  createEffect(() => {
    // 深度追踪条目文本/卡片变化与流式状态，触发自动滚动到底部
    for (const e of visibleEntries()) {
      void e.text.length;
      void e.cards?.length;
    }
    void view().streaming;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  return (
    <div class="conversation" ref={container}>
      <Show
        when={visibleEntries().length > 0}
        fallback={
          <div class="empty-state">
            <h2>Codara</h2>
            <p>用自然语言描述目标：例如「这个老项目编译不过，帮我修好」</p>
            <p class="hint">极简 · 标准（全工具） · Goal 挂机自驱</p>
          </div>
        }
      >
        <For each={visibleEntries()}>
          {(entry) => (
            <div class={`entry entry-${entry.role}`}>
              {/* 工具卡事件不带表头：一张工具卡上面挂「Codara / 模型 / 用量」纯属噪声 */}
              <Show when={entry.role !== 'event'}>
                <div class="entry-meta">
                  <span class="role">{roleLabel(entry.role)}</span>
                  <Show when={entry.model}>
                    <span class="model">{entry.model} · {entry.effort}</span>
                  </Show>
                  <Show when={entry.usage}>
                    <span class="usage">
                      ↑{entry.usage!.promptTokens} ↓{entry.usage!.completionTokens} tok
                    </span>
                  </Show>
                </div>
              </Show>
              <Show when={entry.text}>
                <div class="entry-text md" innerHTML={renderMarkdown(entry.text)} />
              </Show>
              <Show when={entry.cards && entry.cards.length > 0}>
                <div class="entry-cards">
                  <For each={entry.cards}>{(card) => <CardRenderer card={card} />}</For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <Show when={view().streaming}>
        <div class="thinking-row">
          <span class="thinking-dot" />
          <span>正在思考…</span>
        </div>
      </Show>
      <Show when={headApprovalFor(activeKey())}>
        {(card) => <ApprovalBanner card={card()} />}
      </Show>
    </div>
  );
}

/** 阻塞式审批横幅：write/terminal/git 写操作必须人工裁决，未响应则工具永久挂起 */
function ApprovalBanner(props: { card: import('@codara/contract').ApprovalCard }) {
  const b = bridge();
  const [busy, setBusy] = createSignal(false);
  const respond = async (approved: boolean) => {
    setBusy(true);
    try {
      // 必须带 sessionId：主进程按会话分桶等待表，缺省会找不到这张卡的等待点
      await b.approvalRespond({
        approvalToken: props.card.approvalToken,
        approved,
        sessionId: props.card.sessionId,
      });
      resolveApprovalCard(props.card.approvalToken, approved);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={`approval-banner risk-${props.card.risk}`}>
      <div class="ab-head">
        <span class="ab-tag">待审批</span>
        <span class="ab-title">{props.card.title}</span>
        <Show when={ui.pendingApprovals.length > 1}>
          <span class="ab-queue">队列还有 {ui.pendingApprovals.length - 1} 项</span>
        </Show>
        <span class={`ab-risk risk-${props.card.risk}`}>风险：{props.card.risk}</span>
      </div>
      <div class="ab-reason">{props.card.reason}</div>
      <Show when={props.card.payload}>
        <pre class="ab-payload">{JSON.stringify(props.card.payload).slice(0, 500)}</pre>
      </Show>
      <div class="ab-actions">
        <button class="primary" disabled={busy()} onClick={() => respond(true)}>
          批准
        </button>
        <button class="danger" disabled={busy()} onClick={() => respond(false)}>
          拒绝
        </button>
      </div>
    </div>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return '你';
    case 'assistant':
      return 'Codara';
    case 'system':
      return '系统';
    default:
      return role;
  }
}
