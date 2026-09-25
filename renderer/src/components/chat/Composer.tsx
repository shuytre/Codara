// 输入区：Codex 式布局 —— 输入框在上，下方左侧模式胶囊、右侧模型切换 + 发送/终止
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { appendEntry, chat, setChat, setSettings, settings, setUsage, usage } from '../../state/stores';

const MODES: Array<{ id: 'ask' | 'plan' | 'goal'; label: string; tip: string }> = [
  { id: 'ask', label: 'Ask', tip: '只读问答，不写文件' },
  { id: 'plan', label: 'Plan', tip: '先计划后执行' },
  { id: 'goal', label: 'Goal', tip: '挂机自驱' },
];

export function Composer() {
  const b = bridge();
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [precheckOpen, setPrecheckOpen] = createSignal(false);
  // 预授权三勾选（规格 4.7：逐项确认，任一未勾不开）
  const [ck1, setCk1] = createSignal(false);
  const [ck2, setCk2] = createSignal(false);
  const [ck3, setCk3] = createSignal(false);

  // 当前厂商可用模型（向导在线拉取的多选列表；缺省回退当前模型）
  const modelOptions = (): string[] => {
    const p = settings.value?.provider;
    if (p?.models && p.models.length > 0) return p.models;
    return p?.model ? [p.model] : [];
  };

  const switchModel = async (m: string) => {
    setSettings('value', 'provider', 'model', m); // 乐观更新，失败由下次 settingsGet 校正
    try {
      await b.settingsSet({ provider: { model: m } });
    } catch {
      /* 保留乐观值；持久化失败不影响本会话 */
    }
  };

  const openWorkspace = async () => {
    const dir = await b.workspaceOpen();
    if (dir) {
      const v = await b.settingsGet();
      setSettings('value', v as never);
    }
  };

  const send = async () => {
    const t = text().trim();
    if (!t || sending()) return;
    // Goal 模式且未预授权：先弹预授权告知卡
    if (chat.mode === 'goal' && !precheckOpen()) {
      setPrecheckOpen(true);
      return;
    }
    setText('');
    appendEntry({ id: `u-${Date.now()}`, role: 'user', text: t, createdAt: Date.now() });
    setChat({ streaming: true, streamText: '' });
    setSending(true);
    try {
      await b.chatSend({ text: t, mode: chat.mode });
    } finally {
      setSending(false);
      setChat({ streaming: false });
      // 刷新用量
      const snap = await b.usageSnapshot();
      setUsage(snap);
    }
  };

  const confirmPrecheck = async () => {
    const ok = await b.goalPreauthorize({
      confirmWorkspaceWrites: ck1(),
      confirmWhitelistCommands: ck2(),
      confirmBudget: ck3(),
    });
    setPrecheckOpen(false);
    if (ok) {
      // 预授权完成，自动重放发送
      await send();
    }
  };

  const abort = async () => {
    await b.chatAbort();
    setChat({ streaming: false });
  };

  return (
    <div class="composer">
      <Show when={!settings.value?.workspacePath}>
        <div class="ws-banner">
          <span>未打开工作区 —— 文件 / 终端类工具无法执行</span>
          <button class="small" onClick={openWorkspace}>
            打开文件夹
          </button>
        </div>
      </Show>
      <Show when={usage.budget.suspended}>
        <div class="budget-banner">预算已熔断，任务已挂起 —— 请在右栏处理</div>
      </Show>
      <Show when={precheckOpen()}>
        <div class="goal-precheck">
          <div class="pane-title">Goal 模式预授权确认</div>
          <div class="small">进入 Goal 后将跳过以下操作的逐次审批（随时说「终止」回到逐次审批）：</div>
          <label class="check-row">
            <input type="checkbox" checked={ck1()} onChange={(e) => setCk1(e.currentTarget.checked)} />
            工作区内文件写入（写前自动快照，可回滚）
          </label>
          <label class="check-row">
            <input type="checkbox" checked={ck2()} onChange={(e) => setCk2(e.currentTarget.checked)} />
            白名单命令与测试命令
          </label>
          <label class="check-row">
            <input type="checkbox" checked={ck3()} onChange={(e) => setCk3(e.currentTarget.checked)} />
            预算上限（超限自动停机，不静默续杯）
          </label>
          <div class="small danger-text">仍必须人工审批：沙箱外写入、联网、安装软件、Git 历史改写、高危命令。</div>
          <div class="composer-actions" style={{ 'margin-top': '10px' }}>
            <button class="primary" disabled={!(ck1() && ck2() && ck3())} onClick={confirmPrecheck}>
              确认并启动 Goal
            </button>
            <button onClick={() => setPrecheckOpen(false)}>取消</button>
          </div>
        </div>
      </Show>
      <textarea
        rows="3"
        placeholder={
          chat.mode === 'ask'
            ? 'Ask：提出问题（Agent 只读，不写文件）'
            : chat.mode === 'plan'
              ? 'Plan：描述目标，Agent 先出计划，批准后执行'
              : 'Goal：给定目标与验收标准，挂机自驱'
        }
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
        }}
      />
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <div class="mode-pills">
            <For each={MODES}>
              {(m) => (
                <button
                  class="mode-pill"
                  classList={{ active: chat.mode === m.id }}
                  title={m.tip}
                  onClick={() => setChat('mode', m.id)}
                >
                  {m.label}
                </button>
              )}
            </For>
          </div>
          <span class="hint">Ctrl+Enter 发送</span>
        </div>
        <div class="composer-actions">
          <Show when={modelOptions().length > 0}>
            <select
              class="model-switch"
              value={settings.value?.provider.model}
              title="切换模型"
              onChange={(e) => void switchModel(e.currentTarget.value)}
            >
              <For each={modelOptions()}>{(m) => <option value={m}>{m}</option>}</For>
            </select>
          </Show>
          <Show
            when={!sending()}
            fallback={
              <button class="danger" onClick={abort}>
                终止
              </button>
            }
          >
            <button class="primary" onClick={send} disabled={!text().trim()}>
              发送
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
