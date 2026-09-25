// 中栏对话流：用户消息 / Agent 回复 / 流式增量 / 卡片渲染
import { For, Show, createEffect } from 'solid-js';

import { chat } from '../../state/stores';
import { CardRenderer } from '../cards/CardRenderer';

export function ConversationStream() {
  let container: HTMLDivElement | undefined;
  createEffect(() => {
    // 新内容自动滚动到底部
    chat.entries.length + chat.streamText.length;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  return (
    <div class="conversation" ref={container}>
      <Show
        when={chat.entries.length > 0 || chat.streamText}
        fallback={
          <div class="empty-state">
            <h2>Codara</h2>
            <p>用自然语言描述目标：例如「这个老项目编译不过，帮我修好」</p>
            <p class="hint">Ask 只读 · Plan 先计划后执行 · Goal 挂机自驱</p>
          </div>
        }
      >
        <For each={chat.entries}>
          {(entry) => (
            <div class={`entry entry-${entry.role}`}>
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
              <div class="entry-text">{entry.text}</div>
              <Show when={entry.cards && entry.cards.length > 0}>
                <For each={entry.cards}>{(card) => <CardRenderer card={card} />}</For>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <Show when={chat.streaming}>
        <div class="entry entry-assistant streaming">
          <div class="entry-meta">
            <span class="role">Codara</span>
            <span class="typing">…</span>
          </div>
          <div class="entry-text">{chat.streamText}</div>
        </div>
      </Show>
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
