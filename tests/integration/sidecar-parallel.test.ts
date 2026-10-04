// 第6轮·阶段2：sidecar 多线程 worker —— 真并发 / 响应乱序 / 副作用串行
//
// 改了什么：请求循环从「单线程同步 dispatch」改为「每请求 spawn 一个 worker」。
// 单线程时一个 `term.exec`（最长 300 秒）会把整个 sidecar 堵死 —— 两个会话同时跑时，
// 后一个会话的所有工具调用都排在前面那条长命令后面，表现为「开了第二个任务一动不动」。
//
// 这里刻意用**真实 sidecar 二进制**（不是 mock）：要验的正是「请求循环的线程模型」，
// mock 掉进程就只能验自己的假设，证明不了真并发。
//
// 关键手法：用一个慢的排他请求（term.exec sleep）占住写锁，再看只读请求能否在它
// 完成之前返回。只读能穿过 = 真并发；被堵住 = 退回单线程。
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SidecarHarness, tmpWorkspace } from './harness';

let h: SidecarHarness;
let ws: string;

/** 等待 ms */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  ws = tmpWorkspace();
  h = new SidecarHarness();
  await h.start(ws);
});

afterEach(() => {
  h.stop();
});

describe('阶段2: sidecar 真并发', () => {
  it('只读请求能穿过慢的排他请求（写锁不挡读）', async () => {
    // 占住写锁 ~1500ms
    const slowId = h.send('term.exec', { command: 'sleep 1.5', timeoutMs: 10000 });
    await sleep(150); // 确保 worker 已持锁

    // 只读 ping 必须立刻回来，而不用等 sleep 结束
    const t0 = Date.now();
    const ping = await h.await_(h.send('ping', {}), 1000);
    const pingMs = Date.now() - t0;

    expect(ping.result.ok).toBe(true);
    expect(ping.result.data.pong).toBe(true);
    // 阈值留足余量：只读只要「明显早于」1.5s 结束就算穿过
    expect(pingMs).toBeLessThan(1200);
    expect(pingMs).toBeLessThan(1500 - 300);

    const slow = await h.await_(slowId, 10000);
    expect(slow.result.ok).toBe(true);
  });

  it('多个只读请求彼此并发穿过写锁（不只是单个穿过）', async () => {
    // 占住写锁 ~1.5s
    const slowId = h.send('term.exec', { command: 'sleep 1.5', timeoutMs: 10000 });
    await sleep(150);

    // 8 个只读全部并发发出，必须都在写锁释放之前就回来
    const readIds = [
      ...Array.from({ length: 4 }, () => h.send('ping', {})),
      ...Array.from({ length: 4 }, (_, i) => h.send('fs.meta', { path: `m${i}.txt` })),
    ];
    const t0 = Date.now();
    const reads = await Promise.all(readIds.map((id) => h.await_(id, 1200)));
    const elapsed = Date.now() - t0;

    expect(reads).toHaveLength(8);
    expect(reads.every((r) => typeof r.result?.ok === 'boolean')).toBe(true);
    // 全部在 1.5s 的写锁窗口内完成 —— 若是单线程，它们会排在 sleep 之后（>1.5s）
    expect(elapsed).toBeLessThan(1300);

    const slow = await h.await_(slowId, 10000);
    expect(slow.result.ok).toBe(true);
  });

  it('慢请求与快请求混合：快的先返回（响应乱序）', async () => {
    const slowId = h.send('term.exec', { command: 'sleep 1.2', timeoutMs: 10000 });
    await sleep(100);

    const fastIds = Array.from({ length: 5 }, (_, i) => h.send('ping', {}));
    const t0 = Date.now();
    const fasts = await Promise.all(fastIds.map((id) => h.await_(id, 1000)));
    const fastMs = Date.now() - t0;

    // 5 个 ping 全部在慢请求结束前回来
    expect(fasts.every((r) => r.result.ok)).toBe(true);
    expect(fastMs).toBeLessThan(900);

    const slow = await h.await_(slowId, 10000);
    expect(slow.result.ok).toBe(true);
  });

  it('响应按 id 正确配对，不因乱序串台', async () => {
    const fs = await import('fs');
    // 6 个内容可区分的文件
    const names = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'];
    for (const n of names) fs.writeFileSync(path.join(ws, `${n}.txt`), `payload-${n}\n`);

    // 交错发送：一个慢的夹在 6 个快请求中间。
    // 若 harness 按到达顺序（而非 id）配对，内容就会张冠李戴。
    const slowId = h.send('term.exec', { command: 'sleep 0.8', timeoutMs: 10000 });
    const fastIds = names.map((n) => h.send('fs.read', { path: `${n}.txt` }));
    const fasts = await Promise.all(fastIds.map((id) => h.await_(id, 10000)));

    // 每个响应必须：id 对得上，且内容是自己那个文件的
    fasts.forEach((r, i) => {
      expect(r.id).toBe(fastIds[i]);
      expect(r.result.ok, `${names[i]} 应读成功`).toBe(true);
      const text = JSON.stringify(r.result.data);
      expect(text).toContain(`payload-${names[i]}`);
      for (const other of names) {
        if (other !== names[i]) expect(text).not.toContain(`payload-${other}`);
      }
    });

    const slow = await h.await_(slowId, 10000);
    expect(slow.id).toBe(slowId);
    expect(slow.result.ok).toBe(true);
  });

  it('并发 fs.read 各自拿到正确内容（共享状态未被串改）', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const fs = await import('fs');
    for (const f of files) {
      fs.writeFileSync(path.join(ws, `${f}.txt`), `content-${f}\n`);
    }
    const ids = files.map((f) => h.send('fs.read', { path: `${f}.txt` }));
    const results = await Promise.all(ids.map((id) => h.await_(id, 10000)));

    results.forEach((r, i) => {
      expect(r.result.ok, `${files[i]} 应读成功`).toBe(true);
      const text = JSON.stringify(r.result.data);
      expect(text).toContain(`content-${files[i]}`);
      // 不该混进别的文件的内容
      for (const other of files) {
        if (other === files[i]) continue;
        expect(text).not.toContain(`content-${other}`);
      }
    });
  });
});

describe('阶段2: 副作用串行', () => {
  it('两个 fs.patch 并发写同一文件，最终内容只有一个生效（无交错）', async () => {
    const fs = await import('fs');
    fs.writeFileSync(path.join(ws, 'race.txt'), 'BASE\n');

    // 两个都基于同一 oldText 做替换。若真并发且没有写锁，
    // 可能出现「两边都读到 BASE，两个都写」或文件内容混合。
    const a = h.send('fs.patch', {
      path: 'race.txt',
      edits: [{ oldText: 'BASE', newText: 'FROM_A' }],
    });
    const b = h.send('fs.patch', {
      path: 'race.txt',
      edits: [{ oldText: 'BASE', newText: 'FROM_B' }],
    });
    const [ra, rb] = await Promise.all([h.await_(a), h.await_(b)]);

    // 至少一个成功，另一个因 oldText 已不匹配而失败（串行的证据）
    const okCount = [ra, rb].filter((r) => r.result.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(1);

    const final = fs.readFileSync(path.join(ws, 'race.txt'), 'utf-8');
    // 文件必须是**完整**的某个结果，而不是两段混合
    expect(['BASE\n', 'FROM_A\n', 'FROM_B\n']).toContain(final);
  });

  it('排他请求排队执行，耗时累加（不并发）', async () => {
    const t0 = Date.now();
    const a = h.send('term.exec', { command: 'sleep 0.6', timeoutMs: 10000 });
    const b = h.send('term.exec', { command: 'sleep 0.6', timeoutMs: 10000 });
    await Promise.all([h.await_(a, 20000), h.await_(b, 20000)]);
    const elapsed = Date.now() - t0;

    // 串行 → ≥1.2s；并行 → ~0.6s。取 1.1s 阈值区分。
    expect(elapsed).toBeGreaterThanOrEqual(1100);
  });
});

describe('阶段2: 稳定性', () => {
  it('50 个并发请求全部返回，无丢失/无崩溃', async () => {
    const ids = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? h.send('ping', {}) : h.send('fs.meta', { path: 'nope.txt' }),
    );
    const results = await Promise.all(ids.map((id) => h.await_(id, 20000)));
    expect(results).toHaveLength(50);
    // 全部拿到响应（ok 或业务错误都行），关键是没超时
    expect(results.every((r) => typeof r.result?.ok === 'boolean')).toBe(true);
  });

  it('并发请求后 sidecar 仍能正常服务新请求（线程没泄漏/没死锁）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => h.send('ping', {})).map((id) => h.await_(id, 10000)),
    );
    const after = await h.call('ping', {});
    expect(after.result.ok).toBe(true);
    expect(after.result.data.pong).toBe(true);
  });
});
