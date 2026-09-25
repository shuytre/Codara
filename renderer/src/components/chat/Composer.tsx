// 输入区：模式选择 + 发送/终止
import { createSignal, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { appendEntry, cards, chat, setChat, usage, setUsage } from '../../state/stores';

export function Composer() {
  const b = bridge();
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [precheckOpen, setPrecheckOpen] = createSignal(false);
  // 预授权三勾选（规格 4.7：逐项确认，任一未勾不开）
  const [ck1, setCk1] = createSignal(false);
  const [ck2, setCk2] = createSignal(false);
  const [ck3, setCk3] = createSignal(false);

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
          <div class="composer-bar">
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
      <div class="composer-bar">
        <span class="hint">Ctrl+Enter 发送 · 模式：{chat.mode.toUpperCase()} · 卡片 {cards.list.length}</span>
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
  );
}
