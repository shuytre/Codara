// 左栏：Codex/豆包式对话分组列表（今天 / 更早）+ 设置入口
// 主对话固定首位；「+」新建对话；点击会话切换（恢复历史消息）
// 工作区入口已移至 Composer 底部工具行（ws-chip）
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import {
  appendEntry,
  cards,
  chat,
  convs,
  crew,
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

  // 新建对话：主进程建新会话并重置 AgentLoop，渲染层清空聊天流并刷新列表。
  // 标题由主进程按「对话 <时间>」生成；首条消息到达后 Composer 会调 chatRename 回填。
  // 列表不等本地推入，而是重新向 sidecar 拉取 —— 单一数据源，重启后一致。
  const newChat = async () => {
    if (switching()) return;
    setSwitching(true);
    try {
      const r = await b.chatNew();
      if (!r?.ok) throw new Error(r?.error || '新建对话失败');
      clearStream();
      setActiveConversation(r.sessionId || null);
      void refreshList();
    } catch (err) {
      setUi({ toast: `新建对话失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSwitching(false);
    }
  };

  // 从 sidecar 拉取会话列表（唯一数据源；重启不丢）
  const refreshList = async () => {
    try {
      const r = await b.chatList();
      if (!r?.ok) return;
      setConvs(
        'list',
        r.sessions
          .filter((x) => x.title !== '主对话')
          .map((x) => ({
            sessionId: x.sessionId,
            title: x.title || `对话 ${new Date(x.createdAt).toLocaleString('zh-CN')}`,
            createdAt: x.createdAt,
          }))
      );
    } catch {
      /* 列表拉取失败不阻断交互 */
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

      {/* 「显示右栏」已整合进设置面板（视图开关） */}

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