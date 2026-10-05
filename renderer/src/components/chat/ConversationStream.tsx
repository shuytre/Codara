// 中栏对话流：用户消息 / 最终回复（Markdown）/ 工具执行过程（折叠容器）
//
// 第 6 轮：只渲染**当前会话**的分区；条目顺序即真实事件顺序。
// 第 8 轮：把「执行过程」与「最终回复」分层 ——
//   过程（step 摘要 + 工具卡）收进默认折叠的「已完成」容器，
//   最终回复渲染在容器**下方**，顺序严格为 assistant(tool_calls) → tool → assistant(final)。
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';

import type { ChatEntry } from '@codara/contract';
import { activeChat, activeKey, headApprovalFor, resolveApprovalCard, ui } from '../../state/stores';
import { renderMarkdown } from '../../util/markdown';
import { CardRenderer } from '../cards/CardRenderer';
import { bridge } from '../../ipc/client';

export function ConversationStream() {
  let container: HTMLDivElement | undefined;
  // 当前会话的流（会话切换时整体换掉）
  const view = createMemo(() => activeChat());

  /**
   * 把扁平 entries 聚合成「渲染块」（第 8 轮）。
   *
   * 输入（真实事件顺序）：
   *   user, step(读取配置), card(read), step(执行安装), card(terminal), final(最终回复)
   * 输出：
   *   user, process(容器: [step, card, step, card]), final
   *
   * 规则：
   * - 带 processGroup 的 step/process 条目按 groupId 收进同一个容器
   * - 容器**插在分组内第一条条目原来的位置**（保持与用户提问的相对顺序，
   *   也保证多轮提问时每个容器各归其位）
   * - final 条目保持原位（渲染在容器之后）
   * - 已完结的审批卡不占位（第 7 轮）
   */
  type Block =
    | { kind: 'entry'; entry: ChatEntry }
    | { kind: 'process'; gid: string; at: number; items: ChatEntry[] };

  const blocks = createMemo<Block[]>(() => {
    const out: Block[] = [];
    const seen = new Set<string>();
    for (const raw of view().entries) {
      // 过滤已完结的审批卡（未决的必须留着 —— 那是用户唯一的批准入口）
      let entry = raw;
      if (entry.cards) {
        const keep = entry.cards.filter((c) => !(c.type === 'approval' && c.status !== 'pending'));
        if (keep.length !== entry.cards.length) entry = { ...entry, cards: keep };
      }
      const hasText = (entry.text ?? '').length > 0;
      const hasCards = !!entry.cards && entry.cards.length > 0;
      if (!hasText && !hasCards) continue; // 空条目不占位

      const gid = entry.processGroup;
      if (gid && (entry.kind === 'step' || entry.kind === 'process')) {
        if (seen.has(gid)) {
          const b = out.find((x) => x.kind === 'process' && x.gid === gid);
          if (b && b.kind === 'process') b.items.push(entry);
          continue;
        }
        seen.add(gid);
        out.push({ kind: 'process', gid, at: entry.createdAt, items: [entry] });
        continue;
      }
      out.push({ kind: 'entry', entry });
    }
    return out;
  });

  createEffect(() => {
    // 深度追踪条目文本/卡片变化与流式状态，触发自动滚动到底部
    for (const b of blocks()) {
      if (b.kind === 'entry') {
        void b.entry.text.length;
        void b.entry.cards?.length;
      } else {
        for (const it of b.items) {
          void it.text.length;
          void it.cards?.length;
        }
      }
    }
    void view().streaming;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  });

  return (
    <div class="conversation" ref={container}>
      <Show
        when={blocks().length > 0}
        fallback={
          <div class="empty-state">
            <h2>Codara</h2>
            <p>用自然语言描述目标：例如「这个老项目编译不过，帮我修好」</p>
            <p class="hint">极简 · 标准（全工具） · Goal 挂机自驱</p>
          </div>
        }
      >
        <For each={blocks()}>
          {(block) => (
            <Show
              when={block.kind === 'process' ? block : null}
              fallback={<EntryView entry={(block as { entry: ChatEntry }).entry} />}
            >
              {(proc) => (
                <div class="entry entry-event">
                  {/* 需求 2：过程默认折叠，标题「已完成」；点开后才是每一步明细 */}
                  <details class="process-details">
                    <summary class="process-summary">
                      <span class="process-caret" aria-hidden="true" />
                      <span class="process-title">已完成</span>
                      <span class="process-count">
                        {processStepCount(proc())} 步
                      </span>
                    </summary>
                    <div class="process-body">
                      <For each={proc().items}>
                        {(item) => (
                          <Show
                            when={item.kind === 'step'}
                            fallback={
                              <div class="entry-cards">
                                <For each={item.cards}>{(card) => <CardRenderer card={card} />}</For>
                              </div>
                            }
                          >
                            <ProcessStepLine text={item.text} prevCards={prevCardsOf(proc(), item)} />
                          </Show>
                        )}
                      </For>
                    </div>
                  </details>
                </div>
              )}
            </Show>
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

/**
 * 单个条目的渲染（用户消息 / 最终回复 / 系统说明）。
 * 从主组件里抽出，供 block 聚合后的两种形态复用。
 */
function EntryView(props: { entry: ChatEntry }) {
  return (
    <div class={`entry entry-${props.entry.role}`}>
      {/* 工具卡事件不带表头：一张工具卡上面挂「Codara / 模型 / 用量」纯属噪声 */}
      <Show when={props.entry.role !== 'event'}>
        <div class="entry-meta">
          <span class="role">{roleLabel(props.entry.role)}</span>
          <Show when={props.entry.model}>
            <span class="model">{props.entry.model} · {props.entry.effort}</span>
          </Show>
          <Show when={props.entry.usage}>
            <span class="usage">
              ↑{props.entry.usage!.promptTokens} ↓{props.entry.usage!.completionTokens} tok
            </span>
          </Show>
        </div>
      </Show>
      <Show when={props.entry.text}>
        <div class="entry-text md" innerHTML={renderMarkdown(props.entry.text)} />
      </Show>
      <Show when={props.entry.cards && props.entry.cards.length > 0}>
        <div class="entry-cards">
          <For each={props.entry.cards}>{(card) => <CardRenderer card={card} />}</For>
        </div>
      </Show>
    </div>
  );
}

/**
 * 工具的 MCP 标识（需求 3 第 1 条）。
 *
 * 每个工具一个专属标识，看着就能分辨这步在干什么类型的事。
 * 用具名映射而不是「取首字母」之类的机械规则 —— 机械规则产出的是
 * 无语义的字符，起不到「一眼分辨」的作用。
 */
const TOOL_BADGE: Record<string, string> = {
  read: '📖',
  write: '✏️',
  patch: '🔧',
  search: '🔍',
  terminal: '🖥️',
  git: '🌿',
  snapshot: '📸',
  restore: '⏪',
  rollback: '⏪',
  index: '🗂️',
  memory: '🧠',
  web: '🌐',
  fetch: '🌐',
  artifact: '📦',
  acceptance: '✅',
  plan: '📋',
  crew: '👥',
  task: '👥',
  handoff: '🤝',
  budget: '💰',
  secret: '🔑',
  db: '🗄️',
  audit: '📝',
  cache: '⚡',
};

/**
 * 未知工具用中性扳手，而不是留空 —— 空位会让整行对不齐。
 *
 * 匹配顺序：**先按更长的键匹配**。
 * `web_search` 同时包含 `web` 和 `search`，若按对象声明顺序（search 在前）
 * 会得到 🔍。虽然语义上两者都说得通，但这属于「碰巧对」，换个工具名就可能翻车 ——
 * 显式按最长匹配（更具体的意图）优先，结果才稳定可预期。
 */
export function toolBadge(tool: string): string {
  const key = (tool || '').toLowerCase();
  if (TOOL_BADGE[key]) return TOOL_BADGE[key];
  // 前缀/包含匹配：读更长的键优先（read_file → read，web_search → web）
  const keys = Object.keys(TOOL_BADGE).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (key.includes(k)) return TOOL_BADGE[k]!;
  }
  return '🔧';
}

/**
 * 过程里的一行步骤：`📖 read 读取配置文件`（需求 3）。
 *
 * 摘要优先用模型给的 content；模型没给（弱模型常见）时回退到该步骤
 * 对应工具卡的参数摘要，保证这一行永远不空、始终能看出这步做了什么。
 */
function ProcessStepLine(props: { text: string; prevCards: string[] }) {
  const summary = () => props.text.trim();
  const fallback = () => props.prevCards.join(' / ');
  const toolName = () => {
    const first = props.prevCards[0] ?? '';
    return first.split(' ')[0] || 'tool';
  };
  return (
    <div class="process-step">
      <span class="process-badge" aria-hidden="true">{toolBadge(toolName())}</span>
      <span class="process-tool mono">{toolName()}</span>
      <span class="process-desc">{summary() || fallback()}</span>
    </div>
  );
}

/** 过程分组内的步骤数（用于容器标题右侧的「N 步」） */
function processStepCount(proc: { items: ChatEntry[] }): number {
  return proc.items.filter((i) => i.kind === 'step').length;
}

/**
 * 取某条 step **紧邻其后的**工具卡的工具名，用于给这一行配徽标。
 *
 * 事件顺序是 step → card（模型先给摘要，再发起调用），所以向后找第一条
 * 带卡片的条目即为该步骤对应的工具。找不到就返回空数组，由调用方回退。
 */
function prevCardsOf(proc: { items: ChatEntry[] }, item: ChatEntry): string[] {
  const idx = proc.items.indexOf(item);
  for (let i = idx + 1; i < proc.items.length; i++) {
    const c = proc.items[i];
    if (c?.cards?.length) {
      return c.cards.map((card) => {
        const t = card as { tool?: string; summaryLine?: string };
        return t.summaryLine ? `${t.tool ?? ''} ${t.summaryLine}`.trim() : (t.tool ?? '');
      });
    }
    if (c?.kind === 'step') break; // 已经到下一步了，说明本步没有卡片
  }
  return [];
}
