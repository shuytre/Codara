// 左栏：工作区 + 专家团角色会话树（M3：实例状态/角色/任务分级展示）
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { cards, chat, crew, setCards, setChat, setSettings, setUi, settings, ui } from '../../state/stores';

const ROLE_LABEL: Record<string, string> = {
  coordinator: '调度主控',
  architect: '架构规划师',
  developer: '开发工程师',
  reviewer: '审查员',
  tester: '测试验收员',
  builder: '构建工程师',
  researcher: '资料员',
};

const STATUS_CLASS: Record<string, string> = {
  QUEUED: 'st-queued',
  RUNNING: 'st-running',
  WAITING_APPROVAL: 'st-wait',
  WAITING_BUDGET: 'st-wait',
  SUBMITTED: 'st-done',
  CLOSED: 'st-done',
  FAILED: 'st-failed',
};

export function LeftPane(props: { onOpenSettings: () => void }) {
  const b = bridge();
  const [busy, setBusy] = createSignal(false);

  const openWorkspace = async () => {
    setBusy(true);
    try {
      const dir = await b.workspaceOpen();
      if (dir && settings.value) {
        // 重新加载设置以刷新工作区
        const v = await b.settingsGet();
        setSettings('value', v as never);
      }
    } finally {
      setBusy(false);
    }
  };

  // 新建对话：主进程建新会话并重置 AgentLoop，渲染层清空本栏
  const newChat = async () => {
    await b.chatNew();
    setChat({ entries: [], liveId: null, streaming: false, streamText: '' });
    setCards('list', []);
  };

  return (
    <aside class="left-pane">
      <div class="pane-title">工作区</div>
      <div class="ws-row">
        <span class="ws-path" title={settings.value?.workspacePath || '未打开工作区'}>
          {settings.value?.workspacePath || '未打开工作区'}
        </span>
        <button class="small" disabled={busy()} onClick={openWorkspace}>
          打开
        </button>
      </div>

      <div class="pane-title">
        任务树
        <button class="icon-btn" title="新建对话" onClick={newChat}>
          <IconPlus />
        </button>
      </div>
      <div class="task-tree">
        <div class="tree-node active">主对话</div>
        <Show when={crew.tasks.length > 0} fallback={<div class="tree-hint">专家会话（任务创建后显示）</div>}>
          <For each={crew.tasks}>
            {(t) => (
              <div class="crew-task">
                <div class={`tree-node task-${t.status.toLowerCase()}`}>
                  {t.title}
                  <span class={`st-badge ${STATUS_CLASS[t.status] ?? ''}`}>{t.status}</span>
                </div>
                <For each={t.instances}>
                  {(inst) => (
                    <div class={`tree-node child ${STATUS_CLASS[inst.status] ?? ''}`}>
                      {ROLE_LABEL[inst.role] || inst.role}
                      <span class={`st-badge ${STATUS_CLASS[inst.status] ?? ''}`}>{inst.status}</span>
                    </div>
                  )}
                </For>
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
