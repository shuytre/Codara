// App 根组件：首次启动向导 / 主布局路由 + IPC 事件订阅
import { createEffect, createResource, onCleanup, Show } from 'solid-js';

import { bridge } from './ipc/client';
import {
  MAIN_KEY,
  activeKey,
  appendDeltaToLive,
  appendEntry,
  attachCardToLive,
  finalizeLiveEntry,
  setChat,
  setConvs,
  setCrew,
  setSessionRunning,
  setSettings,
  setStreaming,
  setUi,
  setUsage,
  setApprovalCard,
} from './state/stores';
import { MainLayout } from './components/layout/MainLayout';
import { FirstRunWizard } from './components/wizard/FirstRunWizard';

export function App() {
  const b = bridge();
  const [s, { refetch }] = createResource(async () => {
    const v = await b.settingsGet();
    setSettings('value', v as never);
    setUi({ rightPaneVisible: v.ui.rightPaneVisible });
    return v;
  });

  // 启动时从 sidecar 拉取历史会话填充左栏。
  // convs.list 此前是纯内存的，重启即空 —— 用户看到「对话记录丢了」。会话其实一直在
  // sqlite 的 sessions 表里，这里补上读回。列表按 createdAt 倒序，左栏再分「今天/更早」。
  createEffect(() => {
    void (async () => {
      try {
        // 主对话真实 id：主对话在左栏是固定项（activeId=null），但事件按真实 id 回来，
        // 必须先存下来才能把主对话的流/卡片路由到正确分区。
        const main = await b.chatMainSession();
        if (main?.sessionId) setConvs('mainId', main.sessionId);
        const r = await b.chatList();
        if (!r?.ok) return;
        const items = r.sessions
          .filter((x) => x.title !== '主对话') // 主对话由左栏固定项承载，避免重复
          .map((x) => ({
            sessionId: x.sessionId,
            title: x.title || `对话 ${new Date(x.createdAt).toLocaleString('zh-CN')}`,
            createdAt: x.createdAt,
          }));
        setConvs('list', items);
      } catch {
        // 列表拉取失败不影响主流程：用户仍可新建对话
      }
    })();
  });

  // main → renderer 事件订阅：流式增量 / 卡片 / 完成 / 预算挂起
  //
  // 第 6 轮：**按 sessionId 路由**。此前所有事件都写进唯一的 live 条目，
  // 于是两个会话同时跑时后到的事件会把前一个的内容顶掉 —— 用户看到的正是
  // 「主任务突然转到你那个其他的会话，然后快速停止」。现在每个事件落到自己会话的分区。
  createEffect(() => {
    // 事件未带 sessionId 时（异常/降级路径）回落到当前查看的会话，
    // 保证至少不丢内容。
    const keyOf = (sid: unknown): string =>
      typeof sid === 'string' && sid.length > 0 ? sid : activeKey() || MAIN_KEY;

    const offChat = b.onChatEvent((payload) => {
      const p = payload as { kind: string; text?: string; card?: never; usage?: never; sessionId?: string };
      const key = keyOf(p.sessionId);
      if (p.kind === 'delta' && p.text) {
        setStreaming(key, true);
        setSessionRunning(key, true);
        appendDeltaToLive(key, p.text);
      } else if (p.kind === 'card' && p.card) {
        attachCardToLive(key, p.card);
      } else if (p.kind === 'done') {
        setStreaming(key, false);
        setSessionRunning(key, false);
        finalizeLiveEntry(key, p.text || '');
      }
    });
    // 预算/轮次挂起收尾。
    // 此前这里只 setUsage(payload)：流式标记不解除、live 条目不收尾、也不留任何文字，
    // 于是「执行完就断」——中栏空白、输入框像是还能用但没有回应，用户以为程序崩了。
    // 现在补齐三件事：解除 streaming、收尾当前回复、插入一条可读的系统说明。
    const offBudget = b.onBudgetSuspended((payload) => {
      const snap = payload as { sessionId?: string } & Record<string, unknown>;
      const key = keyOf(snap.sessionId);
      setUsage(snap as never);
      setStreaming(key, false);
      setSessionRunning(key, false);
      finalizeLiveEntry(key);
      appendEntry(key, {
        id: `sys-budget-${Date.now()}`,
        role: 'system',
        text: '已达本轮轮次/预算上限，任务在此暂停（进度已保存）。直接继续发送消息即可接着跑。',
        createdAt: Date.now(),
      });
    });
    // 审批卡（规格 6.1）：write/terminal/git 写操作需人工批准；
    // 必须渲染到对话流，否则 gateway.check() 永久挂起、工具卡停在「执行中」
    const offApproval = b.onApprovalRequest((payload) => {
      const key = keyOf(payload.sessionId);
      const card = { ...payload.card, sessionId: payload.card.sessionId ?? key };
      attachCardToLive(key, card);
      setApprovalCard(card);
    });
    // M3：专家团事件 → 左栏角色树
    const offInst = b.onCrewInstance((payload) => {
      const v = payload as import('@codara/contract').CrewInstanceView;
      setCrew('instances', v.instanceId, v);
      setCrew('tasks', (tasks) => {
        const idx = tasks.findIndex((t) => t.taskId === v.taskId);
        if (idx < 0) return tasks;
        const insts = tasks[idx].instances.filter((i) => i.instanceId !== v.instanceId).concat(v);
        return [...tasks.slice(0, idx), { ...tasks[idx], instances: insts }, ...tasks.slice(idx + 1)];
      });
    });
    const offTask = b.onCrewTask((payload) => {
      const v = payload as { taskId: string; title: string; status: string };
      setCrew('tasks', (tasks) => {
        const idx = tasks.findIndex((t) => t.taskId === v.taskId);
        const entry = { taskId: v.taskId, title: v.title, status: v.status as never, createdAt: Date.now(), instances: idx >= 0 ? tasks[idx].instances : [] };
        if (idx < 0) return [...tasks, entry];
        return [...tasks.slice(0, idx), { ...tasks[idx], ...entry, instances: tasks[idx].instances }, ...tasks.slice(idx + 1)];
      });
    });
    onCleanup(() => {
      offChat();
      offBudget();
      offApproval();
      offInst();
      offTask();
    });
  });

  return (
    <Show when={!s.loading} fallback={<div class="loading">加载中…</div>}>
      <Show when={s()} fallback={<div class="loading">加载失败</div>}>
        {(v) => (
          <Show when={v().configured} fallback={<FirstRunWizard onDone={() => refetch()} />}>
            <MainLayout />
          </Show>
        )}
      </Show>
    </Show>
  );
}
