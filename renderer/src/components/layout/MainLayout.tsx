// 三栏主布局：左栏（工作区/任务树）+ 中栏（对话流）+ 右栏（上下文侧栏，可折叠）
import { Show, createSignal, createEffect, onCleanup } from 'solid-js';

import { ui, setUi } from '../../state/stores';
import { LeftPane } from './LeftPane';
import { ConversationStream } from '../chat/ConversationStream';
import { Composer } from '../chat/Composer';
import { RecoveryBanner } from '../chat/RecoveryBanner';
import { RightPane } from './RightPane';
import { SettingsPage } from '../settings/SettingsPage';

export function MainLayout() {
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // 全局 toast：3.2s 自动清除（后一次覆盖前一次的定时器）
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (ui.toast) {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setUi({ toast: '' }), 3200);
    }
  });
  onCleanup(() => clearTimeout(toastTimer));

  return (
    <div class="main-layout">
      <header class="titlebar">
        <span class="logo">Codara</span>
        <span class="mode-hint">对话即全部 · 计划 / 审批 / 终端 / diff 都在对话流中</span>
      </header>
      <div class="columns">
        <LeftPane onOpenSettings={() => setSettingsOpen(true)} />
        <main class="center-pane">
          <RecoveryBanner />
          <ConversationStream />
          <Composer />
        </main>
        <Show when={ui.rightPaneVisible}>
          <RightPane />
        </Show>
      </div>
      <Show when={settingsOpen()}>
        <SettingsPage onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={ui.toast}>
        <div class="toast">{ui.toast}</div>
      </Show>
    </div>
  );
}
