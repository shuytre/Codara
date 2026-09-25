// M4: 崩溃恢复端到端（规格 4.6）
// 场景：任务持锁运行并写检查点 → sidecar 进程被强杀（模拟崩溃）→ 重启后
// 1) 锁检测为 stale（9002 分组进入 stale）→ 2) ckpt.load 恢复最后检查点 →
// 3) release 清理后可重新 acquire（recovery:resolve 的 sidecar 侧语义）。
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { SidecarHarness, tmpWorkspace } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('M4: 崩溃恢复端到端', () => {
  it('杀进程 → 重启 → stale 锁检测 → 检查点恢复 → 锁清理', async () => {
    const ws = tmpWorkspace();

    // ---- 第一次运行：正常任务持有锁 + 写检查点 ----
    const h1 = new SidecarHarness();
    await h1.start(ws);
    try {
      const lock = await h1.call('lock.acquire', { name: 'task-crash-1', owner: 'inst-1', ttlMs: 60_000 });
      expect(lock.result.ok).toBe(true);

      const w1 = await h1.call('ckpt.write', {
        taskId: 'task-crash-1',
        kind: 'tool-call',
        payload: { step: 1, files: ['src/a.rs'] },
      });
      expect(w1.result.ok).toBe(true);
      const w2 = await h1.call('ckpt.write', {
        taskId: 'task-crash-1',
        kind: 'status',
        payload: { step: 2, status: 'IN_PROGRESS', note: 'patch applied' },
      });
      expect(w2.result.ok).toBe(true);

      // 持锁期间重复获取 → 9001 LOCK_HELD
      const again = await h1.call('lock.acquire', { name: 'task-crash-1', ttlMs: 60_000 });
      expect(again.result.ok).toBe(false);
      expect(again.result.error?.code).toBe(9001);

      // 心跳续期后锁仍健康
      const hb = await h1.call('lock.heartbeat', { name: 'task-crash-1' });
      expect(hb.result.ok).toBe(true);
      const inspect1 = await h1.call('lock.inspect', { ttlMs: 60_000 });
      expect(inspect1.result.data.held).toHaveLength(1);
      expect(inspect1.result.data.stale).toHaveLength(0);
    } finally {
      // ---- 模拟崩溃：SIGKILL，无任何清理路径 ----
      h1.proc.kill('SIGKILL');
    }

    // ---- 第二次运行：重启后检测残留状态并恢复 ----
    await sleep(120); // 确保崩溃时间戳与后续 TTL 判定拉开
    const h2 = new SidecarHarness();
    await h2.start(ws);
    try {
      // 1. 锁残留：心跳年龄必然超过小 TTL → 进入 stale 分组
      await sleep(100);
      const inspect3 = await h2.call('lock.inspect', { ttlMs: 50 });
      const staleNames = (inspect3.result.data.stale as Array<{ name: string }>).map((l) => l.name);
      expect(staleNames).toContain('task-crash-1');
      expect(inspect3.result.ok).toBe(true);

      // 2. 检查点恢复：最后一条（step 2）可读回
      const loaded = await h2.call('ckpt.load', { taskId: 'task-crash-1' });
      expect(loaded.result.ok).toBe(true);
      expect(loaded.result.data.payload.step).toBe(2);
      expect(loaded.result.data.kind).toBe('status');

      const list = await h2.call('ckpt.list', { taskId: 'task-crash-1' });
      expect((list.result.data.checkpoints as unknown[]).length).toBe(2);

      // 3. 恢复/终止后锁清理：release → 重新 acquire 成功
      const rel = await h2.call('lock.release', { name: 'task-crash-1' });
      expect(rel.result.ok).toBe(true);
      const reAcquire = await h2.call('lock.acquire', { name: 'task-crash-1', owner: 'inst-2', ttlMs: 60_000 });
      expect(reAcquire.result.ok).toBe(true);

      const inspect4 = await h2.call('lock.inspect', { ttlMs: 60_000 });
      expect(inspect4.result.data.stale).toHaveLength(0);
      expect(inspect4.result.data.held).toHaveLength(1);
    } finally {
      h2.stop();
    }
  });

  it('崩溃后无 LATEST 的 ckpt.load 返回 CHECKPOINT_CORRUPT 而非崩溃', async () => {
    const ws = tmpWorkspace();
    const h = new SidecarHarness();
    await h.start(ws);
    try {
      const r = await h.call('ckpt.load', { taskId: 'task-never-existed' });
      expect(r.result.ok).toBe(false);
      expect(r.result.error?.code).toBe(9003); // CHECKPOINT_CORRUPT
      // 目录懒创建：tasks/task-never-existed 不应存在
      expect(fs.existsSync(path.join(ws, '.codara', 'tasks', 'task-never-existed'))).toBe(false);
    } finally {
      h.stop();
    }
  });
});
