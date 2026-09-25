// M5 集成测试：代码索引全流程（真实 sidecar 进程）+ 记忆注入（AgentLoop 接线）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 记忆测试：全局记忆路径指向隔离 HOME（spread actual 保留 tmpdir 等真实实现）
const FAKE_HOME = vi.hoisted(() => '/tmp/codara-it-mem-home');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => FAKE_HOME },
    homedir: () => FAKE_HOME,
  };
});

import { SidecarHarness, tmpWorkspace } from './harness';
import { AgentLoop, LoopCallbacks } from '../../electron/src/loop/agentLoop';
import { SettingsStore } from '../../electron/src/config/settingsStore';

let h: SidecarHarness;
let ws: string;

beforeEach(async () => {
  ws = tmpWorkspace();
  fs.rmSync(FAKE_HOME, { recursive: true, force: true }); // 隔离全局记忆
  h = new SidecarHarness();
  await h.start(ws);
});

afterEach(() => {
  h.stop();
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

// ---------------- Part A：代码索引（真实 sidecar） ----------------

describe('M5: index 生命周期（sidecar e2e）', () => {
  it('status 未初始化 → build 两 tick → files/symbols/gen 就绪', async () => {
    fs.writeFileSync(path.join(ws, 'lib.rs'), 'struct User;\ntrait Greeter { fn greet(&self); }\n');
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export class App { run(): void {} }\n');

    const s0 = await h.call('index.status', {});
    expect(s0.result.ok).toBe(true);

    const b1 = await h.call('index.build', {});
    expect(b1.result.ok).toBe(true);
    const b2 = await h.call('index.build', {});
    expect(b2.result.ok).toBe(true);
    expect(b2.result.data.done).toBe(true);
    expect(String(b2.result.data.cacheRef)).toMatch(/^idx:[0-9a-f]+:\d+$/);

    const s1 = await h.call('index.status', {});
    expect(s1.result.data.files).toBeGreaterThanOrEqual(2);
    expect(s1.result.data.symbols).toBeGreaterThanOrEqual(2);
    expect(s1.result.data.gen).toBeGreaterThanOrEqual(1);
  });

  it('index.symbols 返回符号与容器（Rust trait/impl）', async () => {
    fs.writeFileSync(
      path.join(ws, 'svc.rs'),
      'trait Greeter {\n    fn greet(&self);\n}\n\nimpl Greeter for User {\n    fn greet(&self) {}\n}\n'
    );
    await h.call('index.build', {});
    await h.call('index.build', {});
    const r = await h.call('index.symbols', { name: 'greet' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.total).toBeGreaterThanOrEqual(2);
    const kinds = r.result.data.symbols.map((s: { name: string; container: string | null }) => s.name);
    expect(kinds).toContain('greet');
    const containers = r.result.data.symbols.map((s: { container: string | null }) => s.container);
    expect(containers).toContain('Greeter');
    expect(containers).toContain('User');
  });

  it('索引未建库时 index.symbols 走文件名快路径（<1s 口径）', async () => {
    fs.writeFileSync(path.join(ws, 'payment_service.py'), 'class PaymentService:\n    pass\n');
    const r = await h.call('index.symbols', { name: 'payment' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.fastPath).toBe(true);
    expect(r.result.data.total).toBeGreaterThanOrEqual(1);
  });

  it('index.semantic 默认关闭返回 8002；开启后按 BM25F 排序', async () => {
    fs.writeFileSync(
      path.join(ws, 'payment_service.py'),
      'class PaymentService:\n    def charge(self, amount): return amount\n'
    );
    fs.mkdirSync(path.join(ws, 'docs'));
    fs.writeFileSync(path.join(ws, 'docs', 'payment-notes.md'), 'prose about payment plans\n');
    await h.call('index.build', {});
    await h.call('index.build', {});

    const off = await h.call('index.semantic', { query: 'payment' });
    expect(off.result.ok).toBe(false);
    expect(off.result.error.code).toBe(8002);

    const cfg = await h.call('index.configure', { semantic: true });
    expect(cfg.result.data.semanticEnabled).toBe(true);

    const on = await h.call('index.semantic', { query: 'payment' });
    expect(on.result.ok).toBe(true);
    expect(on.result.data.total).toBeGreaterThanOrEqual(2);
    const paths: string[] = on.result.data.results.map((x: { path: string }) => x.path);
    // 代码文件（content+name+path 三字段命中）排在散文之前
    expect(paths[0]).toBe('payment_service.py');
    // 分数单调递减
    const scores: number[] = on.result.data.results.map((x: { score: number }) => x.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('index.pause 暂停不消费队列；resume 恢复构建', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(ws, `m${i}.rs`), `fn f${i}() {}\n`);
    }
    await h.call('index.pause', {});
    const paused = await h.call('index.build', {});
    expect(paused.result.data.paused).toBe(true);
    expect(paused.result.data.scanned).toBe(0);

    await h.call('index.resume', {});
    const r1 = await h.call('index.build', {});
    expect(r1.result.data.paused).toBe(false);
    expect(r1.result.data.scanned).toBeGreaterThanOrEqual(5);
  });

  it('search symbols 模式委托代码索引', async () => {
    fs.writeFileSync(path.join(ws, 'a.rs'), 'fn parse_file_list() {}\n');
    await h.call('index.build', {});
    await h.call('index.build', {});
    const r = await h.call('search.run', { pattern: 'parse_file_list', mode: 'symbols' });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.total).toBeGreaterThanOrEqual(1);
    expect(r.result.data.symbols[0].name).toBe('parse_file_list');
  });
});

// ---------------- Part B：记忆注入（AgentLoop 接线） ----------------

interface CapturedRequest {
  messages: Array<{ role: string; content: string }>;
  tools: unknown;
}

function makeLoop(wsRoot: string | undefined): { loop: AgentLoop; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const model = {
    chatStream: async (req: CapturedRequest) => {
      captured.push({ messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools });
      return { content: 'done', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
  const settings = new SettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'codara-it-set-')));
  if (wsRoot) settings.patch({ workspacePath: wsRoot });
  const budget = { record: () => false, isSuspended: () => false, checkBreaker: () => false };
  const tools = { toolSpecs: () => [{ name: 'read' }], execute: async () => ({ ok: true }) };
  const sidecar = { call: async () => ({ ok: true, data: {} }) };
  const loop = new AgentLoop(model as never, sidecar as never, settings, budget as never, tools as never);
  return { loop, captured };
}

const noopCb = (): LoopCallbacks => ({
  onCard: () => undefined,
  onDelta: () => undefined,
  onDone: () => undefined,
  onBudgetSuspended: () => undefined,
});

describe('M5: 记忆注入（AgentLoop + withMemory）', () => {
  it('项目 AGENTS.md 注入 system 消息', async () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '## 编码规范\n全部使用 TypeScript。\n');
    const { loop, captured } = makeLoop(ws);
    await loop.run('帮我写个函数', 'ask', noopCb());
    const sys = captured[0]?.messages.find((m) => m.role === 'system');
    expect(sys).toBeTruthy();
    expect(sys!.content).toContain('### 项目记忆');
    expect(sys!.content).toContain('全部使用 TypeScript。');
    // 极简模式系统提示词主体保留
    expect(sys!.content.length).toBeGreaterThan('### 项目记忆'.length);
  });

  it('无记忆文件时 system 消息不含注入块', async () => {
    const { loop, captured } = makeLoop(ws);
    await loop.run('hi', 'ask', noopCb());
    const sys = captured[0]?.messages.find((m) => m.role === 'system');
    expect(sys).toBeTruthy();
    expect(sys!.content).not.toContain('### 项目记忆');
    expect(sys!.content).not.toContain('### 全局记忆');
  });

  it('crew.sandbox=true 跳过项目记忆正文（规格 4.8）', async () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '## 项目机密\n不要让沙箱看到。\n');
    fs.mkdirSync(path.join(FAKE_HOME, '.codara'), { recursive: true });
    fs.writeFileSync(path.join(FAKE_HOME, '.codara', 'AGENTS.md'), '全局通用偏好。');
    const { loop, captured } = makeLoop(ws);
    await loop.run('提权请求', 'goal', noopCb(), {
      role: 'developer',
      instanceId: 'i-1',
      sessionId: 's-1',
      sandbox: true,
    });
    const sys = captured[0]?.messages.find((m) => m.role === 'system');
    expect(sys).toBeTruthy();
    expect(sys!.content).toContain('全局通用偏好。'); // 全局保留
    expect(sys!.content).not.toContain('不要让沙箱看到。'); // 项目记忆正文豁免
    // 角色提示词主体注入（developer）
    expect(sys!.content).toContain('Developer');
  });

  it('普通 crew 角色注入全局+项目两层记忆（规格 4.5）', async () => {
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), '## 项目规则\nP 内容');
    fs.mkdirSync(path.join(FAKE_HOME, '.codara'), { recursive: true });
    fs.writeFileSync(path.join(FAKE_HOME, '.codara', 'AGENTS.md'), 'G 内容');
    const { loop, captured } = makeLoop(ws);
    await loop.run('goal', 'goal', noopCb(), {
      role: 'developer',
      instanceId: 'i-2',
      sessionId: 's-2',
    });
    const sys = captured[0]?.messages.find((m) => m.role === 'system');
    expect(sys!.content).toContain('G 内容');
    expect(sys!.content).toContain('P 内容');
  });
});
