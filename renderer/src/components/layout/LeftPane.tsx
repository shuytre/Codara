// 左栏：Codex/豆包式对话分组列表（今天 / 更早）+ 工作区 + 视图 + 设置入口
// 主对话固定首位；「+」新建对话；点击会话切换（恢复历史消息）
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import {
  addConversation,
  appendEntry,
  cards,
  chat,
  convs,
  crew,
  setActiveConversation,
  setCards,
  setChat,
  setSettings,
  setUi,
  settings,
  ui,
} from '../../state/stores';

export function LeftPane(props: { onOpenSettings: () => void }) {
  const b = bridge();
  const [busy, setBusy] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);

  const openWorkspace = async () => {
    setBusy(true);
    try {
      const dir = await b.workspaceOpen();
      if (dir && settings.value) {
        const v = await b.settingsGet();
        setSettings('value', v as never);
      }
    } finally {
      setBusy(false);
    }
  };

  const clearStream = () => {
    setChat({ entries: [], liveId: null, streaming: false, streamText: '' });
    setCards('list', []);
  };

  // 新建对话：主进程建新会话并重置 AgentLoop，渲染层清空聊天流并入列表（用主进程返回的真实 sessionId）
  const newChat = async () => {
    if (switching()) return;
    setSwitching(true);
    try {
      const r = await b.chatNew();
      if (!r?.ok) throw new Error(r?.error || '新建对话失败');
      clearStream();
      addConversation({
        sessionId: r.sessionId || `c-${Date.now()}`,
        title: `新对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
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
      const history = (r as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
      for (const [i, m] of history.entries()) {
        appendEntry({
          id: `h-${sessionId}-${i}`,
          role: (m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant') as never,
          text: m.content,
          createdAt: Date.now(),
        });
      }
      setActiveConversation(sessionId);
    } catch (err) {
      setUi({ toast: `切换会话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
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
      <div class="ws-row ws-row-head">
        <span class="ws-path" title={settings.value?.workspacePath || '未打开工作区'}>
          {settings.value?.workspacePath || '未打开工作区'}
        </span>
        <button class="small" disabled={busy()} onClick={openWorkspace}>
          打开
        </button>
      </div>

      <div class="pane-title">
        对话
        <button class="icon-btn" title="新建对话" disabled={switching()} onClick={newChat}>
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
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="pane-title">视图</div>
      <label class="check-row">
        <input
          type="checkbox"
          checked={ui.rightPaneVisible}
          onChange={(e) => setUi({ rightPaneVisible: e.currentTarget.checked })}
        />
        显示右栏
      </label>

      <div class="left-pane-foot">
        <button class="foot-btn" title="设置" onClick={props.onOpenSettings}>
          <IconSettings />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );

  // 切回主对话：主对话 session 由主进程记录（首次启动创建），用 chatSwitch 恢复
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

/** lucide: settings */
function IconSettings() {
  return (
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
