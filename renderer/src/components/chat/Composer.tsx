// 输入区：Codex 式布局 —— 输入框在上，下方左侧模式下拉、右侧模型切换 + 发送/终止
import { createSignal, For, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { appendEntry, chat, setChat, setSettings, settings, setUi, setUsage, usage } from '../../state/stores';

/** 原生下拉选项（ask=极简零工具；plan=标准全工具；goal=挂机自驱） */
const MODE_OPTIONS: Array<{ id: 'ask' | 'plan' | 'goal'; label: string; tip: string }> = [
  { id: 'ask', label: '极简模式（默认）', tip: '纯问答，不调用工具、不写文件' },
  { id: 'goal', label: 'Goal 模式', tip: '给定目标与验收标准，预授权后挂机自驱' },
  { id: 'plan', label: '标准模式（全工具）', tip: '全工具可用，先计划后执行' },
];

export function Composer() {
  const b = bridge();
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [precheckOpen, setPrecheckOpen] = createSignal(false);
  // Goal 预授权状态：确认通过后置 true，send 不再重复弹预检卡（修复「确认并启动」无反应）
  const [preauthorized, setPreauthorized] = createSignal(false);
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
    // Goal 模式且未预授权：先弹预授权告知卡（预授权通过后不再拦截）
    if (chat.mode === 'goal' && !preauthorized()) {
      setPrecheckOpen(true);
      return;
    }
    setText('');
    appendEntry({ id: `u-${Date.now()}`, role: 'user', text: t, createdAt: Date.now() });
    setChat({ streaming: true, streamText: '' });
    setSending(true);
    try {
      await b.chatSend({ text: t, mode: chat.mode });
    } catch (err) {
      // 原实现无 catch：端点不可达/未配 Key 时表现为「输入框清空了、什么都没发生」
      const msg = err instanceof Error ? err.message : String(err);
      setUi({ toast: `发送失败：${msg}` });
      appendEntry({
        id: `s-${Date.now()}`,
        role: 'system' as never,
        text: `发送失败：${msg}。请检查模型配置（端点与 API Key）后重试。`,
        createdAt: Date.now(),
      });
    } finally {
      setSending(false);
      setChat({ streaming: false });
      // 刷新用量（失败不影响主流程，且不能放在 finally 里 await，否则会掩盖上面的异常）
      void b.usageSnapshot().then(setUsage).catch(() => undefined);
    }
  };

  const confirmPrecheck = async () => {
    const ok = await b.goalPreauthorize({
      confirmWorkspaceWrites: ck1(),
      confirmWhitelistCommands: ck2(),
      confirmBudget: ck3(),
    });
    if (ok) {
      setPreauthorized(true);
      setPrecheckOpen(false);
      // 已预授权，自动重放发送（send 内守卫见 preauthorized 而非弹框状态）
      await send();
    } else {
      setUi({ toast: 'Goal 预授权未完成：需勾选全部三项' });
    }
  };

  const abort = async () => {
    await b.chatAbort();
    setChat({ streaming: false });
    // 主进程已撤销 Goal 预授权，本地状态同步回退
    setPreauthorized(false);
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
            ? '极简模式：提出问题，Agent 直接回答（零工具）'
            : chat.mode === 'plan'
              ? '标准模式：描述目标，Agent 先出计划，批准后执行'
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
          <select
            class="mode-select"
            value={chat.mode}
            title={MODE_OPTIONS.find((m) => m.id === chat.mode)?.tip}
            onChange={(e) => {
              setChat('mode', e.currentTarget.value as 'ask' | 'plan' | 'goal');
              // 切换模式后 Goal 预授权状态作废，再次进入 Goal 需重新确认
              setPreauthorized(false);
            }}
          >
            <For each={MODE_OPTIONS}>{(m) => <option value={m.id}>{m.label}</option>}</For>
          </select>
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
              <button class="send-btn danger" onClick={abort} title="终止">
                <IconStop />
              </button>
            }
          >
            <button class="send-btn primary" onClick={send} disabled={!text().trim()} title="发送（Ctrl+Enter）">
              <IconMoveUp />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** lucide: move-up（收短居中版：杆不过长、箭头与杆比例均衡，适配圆形按钮） */
function IconMoveUp() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M8 10l4-4 4 4" />
      <path d="M12 6v12" />
    </svg>
  );
}

/** lucide: square（终止） */
function IconStop() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
