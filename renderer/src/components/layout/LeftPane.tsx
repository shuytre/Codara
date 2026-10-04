// 左栏：Codex/豆包式对话分组列表（今天 / 更早）+ 设置入口
// 主对话固定首位；「+」新建对话；点击会话切换（恢复历史消息）
// 工作区入口已移至 Composer 底部工具行（ws-chip）
import { createSignal, For, Show } from 'solid-js';

import type { Card, ChatEntry } from '@codara/contract';
import type { ChatHistoryMessage, ChatHistoryToolCall } from '@codara/contract';
import { bridge } from '../../ipc/client';
import {
  MAIN_KEY,
  addConversation,
  appendEntry,
  clearSession,
  convs,
  isSessionRunning,
  removeConversation,
  setActiveConversation,
  setConvs,
  setUi,
  upsertCard,
} from '../../state/stores';

export function LeftPane(props: { onOpenSettings: () => void }) {
  const b = bridge();
  const [switching, setSwitching] = createSignal(false);

  // 新建对话：主进程建新会话，渲染层只清**新会话**的分区并入列表。
  // 以当前输入框里的首行文字作为标题：左栏才可辨识（否则全是「新对话 18:49」）。
  const newChat = async (title?: string) => {
    if (switching()) return;
    setSwitching(true);
    try {
      const r = await b.chatNew(title ? { title } : undefined);
      if (!r?.ok) throw new Error(r?.error || '新建对话失败');
      const sid = r.sessionId || `c-${Date.now()}`;
      clearSession(sid);
      addConversation({
        sessionId: sid,
        title: title?.trim().slice(0, 24) || `新对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        createdAt: Date.now(),
      });
    } catch (err) {
      setUi({ toast: `新建对话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 切换会话：主进程恢复历史消息（上下文与聊天流同步重建）
  //
  // 第 6 轮：**只清目标会话的分区**。此前 clearStream() 清的是唯一的全局流 ——
  // 切会话等于把另一个正在跑的任务的现场从 UI 上抹掉，用户切回去只剩半截。
  // 现在每个会话各有一份分区，切走再切回内容完整。
  const switchTo = async (sessionId: string, asMain = false) => {
    if (switching()) return;
    setSwitching(true);
    try {
      const r = await b.chatSwitch({ sessionId });
      if (!r?.ok) throw new Error(r?.error || '切换失败');
      clearSession(sessionId);
      renderHistory(sessionId, r.messages ?? []);
      setActiveConversation(asMain ? null : sessionId);
    } catch (err) {
      setUi({ toast: `切换会话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 删除会话：二次确认 → 主进程删 sidecar 行 → 本地分区与列表一并移除。
  // ⚠️ 必须定义在 return 之前：Solid 会把 return 编译成立即执行箭头，事件处理器在渲染期
  //    就被挂载；若此处用 const 且声明在 return 之后，点击时求值会命中 TDZ
  //    （ReferenceError: Cannot access 'deleteConversation' before initialization），
  //    表现为「点删除按钮毫无反应」。
  const deleteConversation = async (sessionId: string, title: string) => {
    if (switching()) return;
    // 原生 confirm：Electron 渲染层可用；用户在确认前不会发生任何删除
    const ok = window.confirm(`删除会话「${title}」？该会话的全部消息将一并删除，不可恢复。`);
    if (!ok) return;
    setSwitching(true);
    try {
      const r = await b.chatDelete({ sessionId });
      if (!r?.ok) throw new Error(r?.error || '删除失败');
      const wasActive = convs.activeId === sessionId;
      // 分区随会话一起丢弃（removeConversation 内部处理）
      removeConversation(sessionId);
      if (wasActive) {
        setActiveConversation(null); // 回主对话
        // 回主对话必须重建中栏历史，否则只剩空白欢迎页
        await loadHistoryToCenter();
      }
    } catch (err) {
      setUi({ toast: `删除会话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 把主进程回传的历史消息重建到**指定会话**的分区。
  // 抽成公共函数：switchTo / 切回主对话必须共享同一套重建逻辑，
  // 否则「切回主对话」这条路径会漏掉重建（清空后一片空白，用户以为历史丢失）。
  //
  // 第 6 轮：工具调用不再降级成 system 文本，而是生成与实时运行**同构**的
  // ToolCallCard 并回灌 cards 分区。此前历史只出文本，右栏「工具流水」只认
  // type==='tool-call' 的卡 —— 于是切回历史会话时右栏恒为「暂无工具调用」。
  const renderHistory = (sessionId: string, history: ChatHistoryMessage[]) => {
    let n = 0;
    for (const m of history) {
      const role = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : m.role === 'tool' ? 'system' : 'assistant';
      const idx = n++;
      // 结构化工具调用行：出卡而不是文本。
      // assistant 行若同时带正文（工具调用前的说明），正文在真实时间上先于工具卡，
      // 因此先补文本条目再补卡片条目。
      if (m.toolCalls && m.toolCalls.length > 0) {
        if (m.content) {
          appendEntry(sessionId, {
            id: `h-${sessionId}-${idx}-t`,
            role: 'assistant',
            text: m.content,
            createdAt: Date.now(),
          });
        }
        const cards: Card[] = m.toolCalls.map((tc: ChatHistoryToolCall, i: number) =>
          historyToolCard(sessionId, tc, `h-${sessionId}-${idx}-${i}`),
        );
        for (const c of cards) upsertCard(sessionId, c);
        appendEntry(sessionId, {
          id: `h-${sessionId}-${idx}`,
          role: 'event',
          text: '',
          createdAt: Date.now(),
          cards,
        });
        continue;
      }
      // 工具结果行没有自然语言正文，用「工具返回」前缀 + 原文呈现，避免中栏出现无名 JSON
      const text = m.content ?? (m.toolName ? `调用工具 ${m.toolName}…` : '（工具调用）');
      appendEntry(sessionId, {
        id: `h-${sessionId}-${idx}`,
        role: role as ChatEntry['role'],
        text: role === 'system' && m.role === 'tool' ? `工具返回：${text}` : text,
        createdAt: Date.now(),
      });
    }
  };

  // 切回主对话时重新拉取主对话历史并重建中栏
  const loadHistoryToCenter = async () => {
    try {
      const main = await b.chatMainSession();
      if (!main?.sessionId) return;
      await switchTo(main.sessionId, true);
    } catch {
      // 拉取失败保持空白即可，用户仍可继续发消息
    }
  };

  const MAIN: string = MAIN_KEY;
  const isActive = (id: string) => (convs.activeId === null ? id === MAIN : convs.activeId === id);
  // 主对话的运行态要看真实 sessionId（事件按它回来）
  const isRunning = (id: string) => (id === MAIN ? isSessionRunning(convs.mainId ?? '') : isSessionRunning(id));

  // 分组：今天 / 更早（豆包/Codex 分组逻辑）
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const todayConvs = () => convs.list.filter((c) => c.createdAt >= startOfToday);
  const earlierConvs = () => convs.list.filter((c) => c.createdAt < startOfToday);

  return (
    <aside class="left-pane">
      <div class="pane-title">
        对话
        <button class="icon-btn" title="新建对话" disabled={switching()} onClick={() => newChat()}>
          <IconPlus />
        </button>
      </div>
      <div class="conv-list">
        <div
          class={`conv-item ${isActive(MAIN) ? 'active' : ''}`}
          onClick={() => (convs.activeId === null ? undefined : switchToMain())}
        >
          <span class="conv-name">主对话</span>
          <Show when={isRunning(MAIN)}>
            <span class="conv-running" title="该会话正在跑任务" />
          </Show>
        </div>
        <Show when={todayConvs().length > 0}>
          <div class="conv-group">今天</div>
          <For each={todayConvs()}>{(c) => <ConvRow conv={c} active={isActive(c.sessionId)} running={isRunning(c.sessionId)} onSwitch={() => switchTo(c.sessionId)} onDelete={() => deleteConversation(c.sessionId, c.title)} />}</For>
        </Show>
        <Show when={earlierConvs().length > 0}>
          <div class="conv-group">更早</div>
          <For each={earlierConvs()}>{(c) => <ConvRow conv={c} active={isActive(c.sessionId)} running={isRunning(c.sessionId)} onSwitch={() => switchTo(c.sessionId)} onDelete={() => deleteConversation(c.sessionId, c.title)} />}</For>
        </Show>
      </div>

      {/* 「显示右栏」已整合进设置面板（视图开关） */}

      <div class="left-pane-foot">
        <button class="foot-btn" title="设置" onClick={props.onOpenSettings}>
          <IconSettings />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );

  // 切回主对话：主对话 session 由主进程记录（首次启动创建），用 chatSwitch 恢复。
  // 必须重建历史（此前只 clearStream 导致中栏空白）。
  function switchToMain() {
    void switchToMainAsync();
  }
  async function switchToMainAsync() {
    if (switching() || convs.activeId === null) return;
    setSwitching(true);
    try {
      const main = await b.chatMainSession();
      if (!main?.sessionId) throw new Error('主对话会话不可用');
      if (main.sessionId !== convs.mainId) setConvs('mainId', main.sessionId);
      await switchTo(main.sessionId, true);
    } catch (err) {
      setUi({ toast: `切回主对话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  }
}

/** 左栏单个会话行：标题 + 运行中圆点 + 删除按钮 */
function ConvRow(props: {
  conv: { sessionId: string; title: string };
  active: boolean;
  running: boolean;
  onSwitch: () => void;
  onDelete: () => void;
}) {
  return (
    <div class={`conv-item ${props.active ? 'active' : ''}`} onClick={props.onSwitch}>
      <span class="conv-name">{props.conv.title}</span>
      <Show when={props.running}>
        <span class="conv-running" title="该会话正在跑任务" />
      </Show>
      <button
        class="conv-del"
        title="删除会话"
        onClick={(e) => {
          e.stopPropagation();
          props.onDelete();
        }}
      >
        <IconTrash />
      </button>
    </div>
  );
}

/** 历史工具调用 → ToolCallCard（与 agentLoop 实时生成的卡同构） */
function historyToolCard(sessionId: string, tc: ChatHistoryToolCall, id: string): Card {
  return {
    id,
    type: 'tool-call',
    status: tc.ok ? 'done' : 'failed',
    createdAt: Date.now(),
    sessionId,
    tool: tc.name,
    paramsSummary: tc.args,
    summaryLine: buildSummaryLine(tc.name, tc.args),
    result: tc.result,
    ok: tc.ok,
  } as Card;
}

/**
 * 生成 `search · pattern=*.ts · mode=files` 形式的一行摘要。
 * 与主进程 toolSummaryLine 同算法（渲染层历史回灌与实时卡片要一致）。
 */
export function buildSummaryLine(tool: string, argsText: string): string {
  let params: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    } else {
      params = { value: parsed };
    }
  } catch {
    params = {};
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 40 ? v.slice(0, 40) + '…' : v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=[${v.length}]`);
    } else {
      // 对象型参数（write 的 edits 等）：只给键数，避免一行摘要又变成裸 JSON
      try {
        parts.push(`${k}={${Object.keys(v as object).length} keys}`);
      } catch {
        parts.push(`${k}=…`);
      }
    }
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? `${tool} · ${parts.join(' · ')}` : tool;
}

/** lucide: plus */
function IconPlus() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

/** lucide: trash-2（会话删除） */
function IconTrash() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

/** lucide: settings */
function IconSettings() {  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
