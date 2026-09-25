// 崩溃恢复横幅（规格 4.6）：启动检测到过期锁 → 恢复 / 忽略
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { bridge } from '../../ipc/client';

export function RecoveryBanner() {
  const b = bridge();
  const [locks, setLocks] = createSignal<Array<{ name: string; owner: string; heartbeat: number }> | null>(null);
  createEffect(() => {
    const off = b.onRecoveryNeeded((payload) => {
      setLocks((payload as { locks: Array<{ name: string; owner: string; heartbeat: number }> }).locks);
    });
    onCleanup(off);
  });
  const resolve = async (action: 'resume' | 'dismiss') => {
    const names = (locks() ?? []).map((l) => l.name);
    await b.recoveryResolve({ action, names });
    setLocks(null);
  };
  return (
    <Show when={locks()}>
      {(ls) => (
        <div class="recovery-banner">
          <span>
            检测到 {ls().length} 个异常中断的任务锁（{ls().map((l) => l.name).join('、')}）
          </span>
          <button class="primary small" onClick={() => resolve('resume')}>
            恢复
          </button>
          <button class="small" onClick={() => resolve('dismiss')}>
            忽略
          </button>
        </div>
      )}
    </Show>
  );
}
