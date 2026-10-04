// 会话并行隔离（主进程）：SessionRegistry 的核心语义
//
// 回归背景（用户原话：「在主任务进行时开启第二个任务，主任务的对话就会突然转到你
// 那个其他的会话，然后快速停止」）：此前主对话只有**一个** AgentLoop 全局单例，
// messages / aborted / runAbort / abortWaiters / approvalWaiters 全部共享，于是
// chatNew / chatSwitch / chatDelete 只能无条件 loop.abort() + loop.reset() ——
// 新建或切到别的会话，主任务被当场掐断。
//
// 本文件直接测真实的 SessionRegistry（不 mock），覆盖：
//   1. 每个会话一份 loop/budget/审批表
//   2. abort/drop 定向：停 A 不影响 B
//   3. 审批等待表按会话分桶，批准 A 不会把 B 判为拒绝
//   4. 用量汇总跨会话相加
//   5. 原点会话语义（chatNew 不改原点；删掉原点后置空）
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionRegistry } from '../../electron/src/loop/sessionRuntime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';
import { SettingsStore } from '../../electron/src/config/settingsStore';
import { BudgetLedger } from '../../electron/src/budget/ledger';
import { AgentLoop } from '../../electron/src/loop/agentLoop';
import { ModelClient } from '../../electron/src/model/client';
import { SidecarManager } from '../../electron/src/sidecar/manager';

function tmpSettings(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codara-sess-'));
  return new SettingsStore(dir);
}

/** 只用到 sidecar 的极少方法；这里给一个恒定信封的替身 */
function fakeSidecar(): SidecarManager {
  return {
    call: async () => ({ ok: true, data: null, error: null, truncated: false }),
  } as unknown as SidecarManager;
}

function makeRegistry(settings = tmpSettings(), sidecar = fakeSidecar(), model?: unknown) {
  const gateway = new ApprovalGateway(sidecar);
  const reg = new SessionRegistry({
    model: (model ?? new ModelClient(settings, new BudgetLedger(sidecar, settings))) as ModelClient,
    sidecar,
    settings,
    scheduler: undefined,
    gateway,
  });
  return { reg, gateway, settings, sidecar };
}

/**
 * 可控的假 model：chatStream 返回一个由测试自己 resolve 的 Promise。
 *
 * 必须可控：真实 ModelClient 会去连端点，run() 在 abort 后仍要等 HTTP 层真正返回
 * 才算结束，用它测「isRunning 立刻翻转」只会得到一个依赖网络的 flaky 断言。
 */
function controllableModel() {
  const pending: Array<() => void> = [];
  const model = {
    chatStream: async (_req: unknown, cb: (e: { type: string; text?: string }) => void) => {
      cb({ type: 'delta', text: '' });
      await new Promise<void>((resolve) => pending.push(resolve));
      return { content: 'done', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
    },
  };
  return { model: model as unknown as ModelClient, release: () => pending.splice(0).forEach((r) => r()) };
}

describe('SessionRegistry — 会话并行隔离', () => {
  it('每个会话拿到独立的 AgentLoop / BudgetLedger / 审批表', () => {
    const { reg } = makeRegistry();
    const a = reg.acquire('sess-a');
    const b = reg.acquire('sess-b');

    expect(a.loop).not.toBe(b.loop);
    expect(a.budget).not.toBe(b.budget);
    expect(a.approvals).not.toBe(b.approvals);
    // 同名会话重复 acquire 返回同一实例（不能每次 send 都新建 loop）
    expect(reg.acquire('sess-a')).toBe(a);
  });

  it('loop 按会话绑定自己的 sessionId（消息落到正确的会话）', () => {
    const { reg } = makeRegistry();
    const a = reg.acquire('sess-a');
    const b = reg.acquire('sess-b');
    // AgentLoop.attachMainSession 决定 persist 写到哪个 sessionId
    expect(a.loop.getActiveSessionId()).toBe('sess-a');
    expect(b.loop.getActiveSessionId()).toBe('sess-b');
  });

  it('abort 目标会话不影响另一个会话（回归：切会话掐死主任务）', async () => {
    const { model, release } = controllableModel();
    const { reg } = makeRegistry(tmpSettings(), fakeSidecar(), model);
    const a = reg.acquire('sess-a');
    const b = reg.acquire('sess-b');
    // 让 A 进入 running，再停 A
    const ra = a.loop.run('hi', 'ask', {
      onCard: () => undefined,
      onDelta: () => undefined,
      onDone: () => undefined,
      onBudgetSuspended: () => undefined,
    });
    expect(a.loop.isRunning()).toBe(true);

    expect(reg.abort('sess-a')).toBe(true);
    // A 的这一轮收尾后退出 running
    release();
    await ra;
    expect(a.loop.isRunning()).toBe(false);
    // B 完全不受影响：没有 abort、没有 reset、实例还在
    expect(reg.peek('sess-b')).toBe(b);
    expect(b.loop.isRunning()).toBe(false);
  });

  it('审批等待按会话分桶：批准 A 不会把 B 一起判为拒绝', async () => {
    const { reg, gateway } = makeRegistry();
    const seen: Array<{ token: string; sessionId: string }> = [];
    // 复刻 handlers.ts 的 listener：把等待点登记到**对应会话**的表里
    gateway.onApproval(async (card, sessionId) => {
      const sid = sessionId || '__origin__';
      seen.push({ token: card.approvalToken, sessionId: sid });
      const rt = reg.acquire(sid);
      return new Promise<boolean>((resolve) => rt.approvals.set(card.approvalToken, resolve));
    });

    const gate = gateway as unknown as {
      check(tool: string, params: unknown, mode: 'ask' | 'plan' | 'goal', sessionId?: string): Promise<{ allowed: boolean }>;
    };
    // terminal 是 ask 级高危 → 必人工审批
    const pa = gate.check('terminal', { command: 'echo a' }, 'ask', 'sess-a');
    const pb = gate.check('terminal', { command: 'echo b' }, 'ask', 'sess-b');
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);

    // 只批准 A
    const tokenA = seen.find((s) => s.sessionId === 'sess-a')!.token;
    reg.acquire('sess-a').approvals.get(tokenA)!(true);

    const ra = await pa;
    // B 仍在等待 —— 关键：没有被 A 的批准连带结算
    expect(ra.allowed).toBe(true);
    expect(reg.acquire('sess-b').approvals.size).toBe(1);

    // 再批准 B，两条各自放行
    const tokenB = seen.find((s) => s.sessionId === 'sess-b')!.token;
    reg.acquire('sess-b').approvals.get(tokenB)!(true);
    expect((await pb).allowed).toBe(true);
  });

  it('abort 只结算目标会话的审批等待', async () => {
    const { reg, gateway } = makeRegistry();
    gateway.onApproval(async (card, sessionId) => {
      const rt = reg.acquire(sessionId);
      return new Promise<boolean>((resolve) => rt.approvals.set(card.approvalToken, resolve));
    });
    const gate = gateway as unknown as {
      check(tool: string, params: unknown, mode: 'ask' | 'plan' | 'goal', sessionId?: string): Promise<{ allowed: boolean; reason?: string }>;
    };
    const pa = gate.check('terminal', { command: 'echo a' }, 'ask', 'sess-a');
    const pb = gate.check('terminal', { command: 'echo b' }, 'ask', 'sess-b');
    await Promise.resolve();
    await Promise.resolve();

    reg.abort('sess-a');
    expect(reg.acquire('sess-a').approvals.size).toBe(0);
    expect(reg.acquire('sess-b').approvals.size).toBe(1);
    expect((await pa).allowed).toBe(false);
    // B 的 Promise 仍挂着 —— 不能被 A 的中止连带 resolve
    let settled = false;
    void pb.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('drop 只回收目标会话（删会话不牵连别人）', () => {
    const { reg } = makeRegistry();
    reg.acquire('sess-a');
    reg.acquire('sess-b');
    expect(reg.drop('sess-a')).toBe(true);
    expect(reg.peek('sess-a')).toBeUndefined();
    expect(reg.peek('sess-b')).toBeDefined();
    expect(reg.drop('sess-a')).toBe(false);
  });

  it('有挂起审批的会话不被 gc 回收', () => {
    const { reg } = makeRegistry();
    const a = reg.acquire('sess-a');
    reg.acquire('sess-b');
    // A 挂着一条待审批：用户可能随时回来批准，绝不能被当成闲置回收
    a.approvals.set('tok', () => undefined);
    a.lastUsedAt = Date.now() - 60 * 60_000; // 假装闲置很久
    const n = reg.gc(1000);
    expect(n).toBe(0);
    expect(reg.peek('sess-a')).toBeDefined();
  });

  it('闲置超时的会话被 gc 回收', () => {
    const { reg } = makeRegistry();
    const a = reg.acquire('sess-a');
    reg.acquire('sess-b');
    a.lastUsedAt = Date.now() - 60 * 60_000;
    expect(reg.gc(1000)).toBe(1);
    expect(reg.peek('sess-a')).toBeUndefined();
    expect(reg.peek('sess-b')).toBeDefined();
  });

  it('用量汇总跨会话相加（跑两条任务不能只显示一条的消耗）', () => {
    const { reg } = makeRegistry();
    const a = reg.acquire('sess-a');
    const b = reg.acquire('sess-b');
    a.budget.startTask('t');
    b.budget.startTask('t');
    a.budget.tickTurn();
    a.budget.record(100, 10);
    b.budget.tickTurn();
    b.budget.record(200, 20);
    const total = reg.totalUsage();
    expect(total.task.promptTokens).toBe(300);
    expect(total.task.completionTokens).toBe(30);
    expect(total.turns).toBe(2);
  });

  it('isRunning 只反映正在跑任务的会话', async () => {
    const { model, release } = controllableModel();
    const { reg } = makeRegistry(tmpSettings(), fakeSidecar(), model);
    reg.acquire('sess-a');
    reg.acquire('sess-b');
    expect(reg.isRunning('sess-a')).toBe(false);
    const ra = reg.acquire('sess-a').loop.run('hi', 'ask', {
      onCard: () => undefined,
      onDelta: () => undefined,
      onDone: () => undefined,
      onBudgetSuspended: () => undefined,
    });
    expect(reg.isRunning('sess-a')).toBe(true);
    expect(reg.isRunning('sess-b')).toBe(false);
    expect(reg.isRunning('never-created')).toBe(false);
    release();
    await ra;
    expect(reg.isRunning('sess-a')).toBe(false);
  });

  it('原点会话：setOrigin 设定后 chatNew 不改原点，删掉原点后置空', () => {
    const { reg } = makeRegistry();
    reg.setOrigin('main-1');
    expect(reg.origin()).toBe('main-1');
    // 新建会话只是新增一条，不影响原点
    reg.acquire('new-1');
    expect(reg.origin()).toBe('main-1');
    reg.drop('main-1');
    expect(reg.origin()).toBeNull();
  });

  it('未设原点时 origin() 为 null（降级模式不崩）', () => {
    const { reg } = makeRegistry();
    expect(reg.origin()).toBeNull();
  });
});
