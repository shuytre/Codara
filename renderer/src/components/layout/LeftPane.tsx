// 左栏：Codex/豆包式对话分组列表（今天 / 更早）+ 设置入口
// 主对话固定首位；「+」新建对话；点击会话切换（恢复历史消息）
// 工作区入口已移至 Composer 底部工具行（ws-chip）
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import {
  addConversation,
  appendEntry,
  cards,
  chat,
  convs,
  crew,
  removeConversation,
  setActiveConversation,
  setCards,
  setChat,
  setUi,
} from '../../state/stores';

export function LeftPane(props: { onOpenSettings: () => void }) {
  const b = bridge();
  const [switching, setSwitching] = createSignal(false);

  const clearStream = () => {
    setChat({ entries: [], liveId: null, streaming: false, streamText: '' });
    setCards('list', []);
  };

  // 新建对话：主进程建新会话并重置 AgentLoop，渲染层清空聊天流并入列表（用主进程返回的真实 sessionId）
  // 以当前输入框里的首行文字作为标题：左栏才可辨识（否则全是「新对话 18:49」）。
  const newChat = async (title?: string) => {
    if (switching()) return;
    setSwitching(true);
    try {
      const r = await b.chatNew(title ? { title } : undefined);
      if (!r?.ok) throw new Error(r?.error || '新建对话失败');
      clearStream();
      addConversation({
        sessionId: r.sessionId || `c-${Date.now()}`,
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
  const switchTo = async (sessionId: string) => {
    if (switching() || convs.activeId === sessionId) return;
    setSwitching(true);
    try {
      const r = await b.chatSwitch({ sessionId });
      if (!r?.ok) throw new Error(r?.error || '切换失败');
      clearStream();
      // 把主进程回传的历史重建到中栏：否则切换会话后中栏一片空白，用户以为历史丢失
      renderHistory(sessionId, (r.messages ?? []) as never[]);
      setActiveConversation(sessionId);
    } catch (err) {
      setUi({ toast: `切换会话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 删除会话：二次确认 → 主进程删 sidecar 行 → 本地列表移除。
  // 删的是当前会话时，主进程已把 AgentLoop 回退到主对话，渲染层同步清空中栏并回主对话。
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
      removeConversation(sessionId);
      if (wasActive) {
        clearStream();
        setActiveConversation(null); // 回主对话
        // 回主对话必须重建中栏历史，否则只剩空白欢迎页（见 switchToMainAsync）
        await loadHistoryToCenter();
      }
    } catch (err) {
      setUi({ toast: `删除会话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 把主进程回传的历史消息重建到中栏。
  // 抽成公共函数：switchTo 与 switchToMainAsync 必须共享同一套重建逻辑，
  // 否则「切回主对话」这条路径会漏掉重建（清空后一片空白，用户以为历史丢失）。
  // 工具调用行（content=null 的 assistant）与 role='tool' 行在此一并还原为可读条目，
  // 不再被 content 非空过滤误杀。
  const renderHistory = (sessionId: string, history: Array<{ role: string; content: string | null; toolName?: string }>) => {
    for (const [i, m] of history.entries()) {
      const role = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : m.role === 'tool' ? 'system' : 'assistant';
      // 工具结果行没有自然语言正文，用「工具返回」前缀 + 原文呈现，避免中栏出现无名 JSON
      const text = m.content ?? (m.toolName ? `调用工具 ${m.toolName}…` : '（工具调用）');
      appendEntry({
        id: `h-${sessionId}-${i}`,
        role: role as never,
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
      const r = await b.chatSwitch({ sessionId: main.sessionId });
      if (!r?.ok) return;
      clearStream();
      renderHistory(main.sessionId, (r.messages ?? []) as never[]);
    } catch {
      // 拉取失败保持空白即可，用户仍可继续发消息
    }
  };

  const MAIN: string = '__main__';
  const isActive = (id: string) => (convs.activeId === null ? id === MAIN : convs.activeId === id);

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
        </div>
        <Show when={todayConvs().length > 0}>
          <div class="conv-group">今天</div>
          <For each={todayConvs()}>
            {(c) => (
              <div class={`conv-item ${isActive(c.sessionId) ? 'active' : ''}`} onClick={() => switchTo(c.sessionId)}>
                <span class="conv-name">{c.title}</span>
                <button
                  class="conv-del"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c.sessionId, c.title);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            )}
          </For>
        </Show>
        <Show when={earlierConvs().length > 0}>
          <div class="conv-group">更早</div>
          <For each={earlierConvs()}>
            {(c) => (
              <div class={`conv-item ${isActive(c.sessionId) ? 'active' : ''}`} onClick={() => switchTo(c.sessionId)}>
                <span class="conv-name">{c.title}</span>
                <button
                  class="conv-del"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c.sessionId, c.title);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            )}
          </For>
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
      const r = await b.chatSwitch({ sessionId: main.sessionId });
      if (!r?.ok) throw new Error(r?.error || '切换失败');
      clearStream();
      renderHistory(main.sessionId, (r.messages ?? []) as never[]);
      setActiveConversation(null); // null = 主对话
    } catch (err) {
      setUi({ toast: `切回主对话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  }
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
