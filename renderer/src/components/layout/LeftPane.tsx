// 左栏：工作区 + 专家团角色会话树（M3：实例状态/角色/任务分级展示）
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { chat, crew, setSettings, setUi, settings, ui } from '../../state/stores';

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

export function LeftPane() {
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

      <div class="pane-title">任务树</div>
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
      <div class="mode-indicator">
        当前模式：
        <select
          value={chat.mode}
          onChange={(e) => {
            chat.mode = e.currentTarget.value as 'ask' | 'plan' | 'goal';
          }}
        >
          <option value="ask">Ask（只读）</option>
          <option value="plan">默认（极简）</option>
          <option value="goal">Goal（挂机）</option>
        </select>
      </div>
    </aside>
  );
}
