// 第 8 轮回归：最终回复必须在工具结果之后（需求 1）+ 过程摘要分流（需求 3）
//
// 用户需求原文：
//   需求 1：消息顺序严格保证 `assistant(tool_calls) → tool(result) → assistant(final)`
//     - assistant 返回 tool_calls 时不当最终回复展示
//     - 只有无 tool_calls 的 assistant content 才能作为最终回复
//     - 禁止在 tool_calls 之前输出最终回复
//     - 禁止同一条 assistant 消息同时含 tool_calls 和最终结论；若同时输出，丢弃最终文本只执行工具
//   需求 3：模型发起 tool_calls 时必须在同一 assistant 消息输出简短摘要文本（content）
//
// 落地点在 AgentLoop.run 的流式缓冲分流：
//   流式阶段无法预知后面是否跟 tool_calls —— 先把文本攒在 textBuf，
//   等模型返回后定性：无 tool_calls → 回放 onDelta（最终回复）；有 tool_calls → 当步骤摘要
//   发 onProcessStep（**绝不**发 onDelta，否则摘要会被当成正文展示在工具之前）。
import { describe, expect, it } from 'vitest';

import { AgentLoop } from '../../electron/src/loop/agentLoop';
import { ToolRuntime } from '../../electron/src/tools/runtime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';

interface Turn {
  content?: string;
  /** 该轮流式吐出的 delta 片段（按顺序触发 onDelta） */
  deltas?: string[];
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/**
 * 支持流式 delta 的模型桩。
 *
 * 关键：chatStream 的第三个参数才是「事件回调」——
 * 真实实现签名是 chatStream(req, onEvent, signal)，这里必须照此触发 delta，
 * 否则测不到「流式阶段先攒着」的分流逻辑。
 */
function makeStreamingModel(script: Turn[]) {
  const seen: Array<{ messages: any[] }> = [];
  let i = 0;
  return {
    seen,
    client: {
      chatStream: async (req: any, onEvent?: (e: any) => void) => {
        seen.push({ messages: JSON.parse(JSON.stringify(req.messages)) });
        const t = script[Math.min(i, script.length - 1)]!;
        i++;
        // 逐片吐 delta（模拟真实流式）
        for (const d of t.deltas ?? []) onEvent?.({ type: 'delta', text: d });
        return {
          content: t.content ?? '',
          toolCalls: t.toolCalls ?? [],
          usage: { promptTokens: 1, completionTokens: 1 },
          finishReason: (t.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        };
      },
    },
  };
}

function runWith(script: Turn[], sidecarHandler?: (m: string, p: any) => any) {
  const calls: Array<{ method: string; params: any }> = [];
  const sidecar = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return sidecarHandler ? sidecarHandler(method, params) : { ok: true, data: { method } };
    },
  };
  const budget = {
    tickTurn: () => undefined,
    record: () => undefined,
    isSuspended: () => false,
    checkBreaker: () => false,
    snapshot: () => ({}),
  };
  const gateway = new ApprovalGateway(sidecar as never);
  gateway.onApproval(async () => true);
  const settings = { get: (k: string) => (k === 'workspacePath' ? '/tmp/test-ws' : undefined) };
  const rt = new ToolRuntime(sidecar as never, budget as never, gateway, settings as never);
  const model = makeStreamingModel(script);
  const loop = new AgentLoop(model.client as never, sidecar as never, settings as never, budget as never, rt);

  // 记录事件流：顺序即真实时序，用于断言「最终回复在工具之后」
  const events: Array<{ kind: 'delta' | 'step' | 'done'; text: string; ok?: boolean }> = [];
  const cards: any[] = [];
  const run = loop.run('做点事', 'ask' as never, {
    onCard: (c: any) => cards.push(c),
    onDelta: (t: string) => events.push({ kind: 'delta', text: t }),
    onProcessStep: (t: string) => events.push({ kind: 'step', text: t }),
    onDone: (t: string, ok?: boolean) => events.push({ kind: 'done', text: t, ok }),
    onBudgetSuspended: () => undefined,
  } as never);
  return { run, events, cards, calls, model };
}

describe('第8轮/需求1 — 最终回复必须在工具结果之后', () => {
  it('带 tool_calls 的轮次：content 走 onProcessStep，绝不走 onDelta', async () => {
    const { run, events } = runWith([
      { content: '先读取配置文件', deltas: ['先读取', '配置文件'], toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '读取完成，一切正常', deltas: ['读取完成，一切正常'] },
    ]);
    await run;

    const deltas = events.filter((e) => e.kind === 'delta').map((e) => e.text);
    const steps = events.filter((e) => e.kind === 'step').map((e) => e.text);

    // 最终回复（delta）只能来自第二轮
    expect(deltas.join('')).toBe('读取完成，一切正常');
    // 第一轮的文本成了步骤摘要
    expect(steps).toContain('先读取配置文件');
    // 关键：摘要不能被当成正文发出
    expect(deltas.join('')).not.toContain('先读取配置文件');
  });

  it('事件顺序严格为 step(摘要) → done(最终回复)，最终回复在最后', async () => {
    const { run, events } = runWith([
      { content: '执行安装依赖', toolCalls: [{ id: 'c1', name: 'terminal', arguments: '{"command":"npm i"}' }] },
      { content: '安装完成' },
    ]);
    await run;

    const kinds = events.map((e) => e.kind);
    // step 必须出现在 done 之前
    const firstStep = kinds.indexOf('step');
    const doneIdx = kinds.indexOf('done');
    expect(firstStep).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(firstStep);
    // 最后一个事件是 done
    expect(kinds[kinds.length - 1]).toBe('done');
    expect(events[events.length - 1]!.text).toBe('安装完成');
  });

  it('多轮工具调用：只有最后一轮无 tool_calls 的文本作为最终回复', async () => {
    const { run, events } = runWith([
      { content: '第一步：读取', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
      { content: '第二步：写入', toolCalls: [{ id: 'c2', name: 'write', arguments: '{"path":"a","create":true,"edits":[{"newText":"x"}]}' }] },
      { content: '全部完成' },
    ]);
    await run;

    const dones = events.filter((e) => e.kind === 'done');
    expect(dones).toHaveLength(1);
    expect(dones[0]!.text).toBe('全部完成');
    expect(dones[0]!.ok).toBe(true);

    // 两个中间轮的摘要都进了过程，不进正文
    const steps = events.filter((e) => e.kind === 'step').map((e) => e.text);
    expect(steps).toEqual(['第一步：读取', '第二步：写入']);
  });

  it('最终回复的 delta 是逐段回放（保持打字机效果，不是一次性抛出）', async () => {
    const { run, events } = runWith([{ content: 'abc', deltas: ['a', 'b', 'c'] }]);
    await run;

    const deltas = events.filter((e) => e.kind === 'delta').map((e) => e.text);
    // 缓冲阶段攒了 3 片，定性为最终回复后按原顺序回放
    expect(deltas).toEqual(['a', 'b', 'c']);
  });

  it('同一 assistant 消息同时含 tool_calls 与文本时：只执行工具，文本当摘要丢弃为正文', async () => {
    // 这正是用户明令禁止的形态：「禁止同一条 assistant 消息同时含 tool_calls 和最终结论」
    const { run, events, cards } = runWith([
      { content: '这是结论，同时我还要调工具', deltas: ['这是结论，同时我还要调工具'], toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '真正的结论', deltas: ['真正的结论'] },
    ]);
    await run;

    // 工具照常执行
    expect(cards.some((c) => c.type === 'tool-call')).toBe(true);
    // 「结论」没有作为正文出现（delta 里不含它）
    const deltas = events.filter((e) => e.kind === 'delta').map((e) => e.text).join('');
    expect(deltas).toBe('真正的结论');
    expect(deltas).not.toContain('这是结论');
  });

  it('模型直接给最终回复（无工具）：content 原样走 done，不产生步骤', async () => {
    const { run, events } = runWith([{ content: '你好，有什么可以帮你', deltas: ['你好，有什么可以帮你'] }]);
    await run;

    expect(events.filter((e) => e.kind === 'step')).toHaveLength(0);
    const done = events.find((e) => e.kind === 'done');
    expect(done!.text).toBe('你好，有什么可以帮你');
    expect(done!.ok).toBe(true);
  });
});

describe('第8轮/需求1 — 历史构造严格配对', () => {
  it('带 tool_calls 的 assistant 消息 content 为 null，且后续有配对的 tool 消息', async () => {
    const { run, model } = runWith([
      { content: '读取配置', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '完成' },
    ]);
    await run;

    // 第二轮请求携带第一轮完整历史
    const second = model.seen[1]!.messages;
    const asst = second.find((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(asst).toBeTruthy();
    // 严格接口要求：带 tool_calls 时 content 必须是 null（不能是空串，也不能带结论文本）
    expect(asst.content).toBeNull();

    // assistant(tool_calls) 之后必须紧跟 tool(result)（配对，否则接口 400）
    const idx = second.indexOf(asst);
    const after = second.slice(idx + 1);
    expect(after[0].role).toBe('tool');
    expect(after[0].tool_call_id).toBe('c1');
  });

  it('工具结果以 role=tool 追加，顺序在 assistant 与最终回复之间', async () => {
    const { run, model } = runWith([
      { content: '调工具', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '最终答复' },
    ]);
    await run;

    const second = model.seen[1]!.messages;
    const roles = second.map((m: any) => m.role);
    const asstIdx = roles.indexOf('assistant');
    const toolIdx = roles.indexOf('tool');
    // 历史里：assistant(tool_calls) 在 tool(result) 之前
    expect(asstIdx).toBeLessThan(toolIdx);
  });
});

describe('第8轮/需求3 — 步骤摘要必须能被渲染层用上', () => {
  it('模型给摘要 → 摘要进入 onProcessStep；工具卡照常产出', async () => {
    const { run, events, cards } = runWith([
      { content: '读取 a.json 看配置', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '看完了' },
    ]);
    await run;

    expect(events.find((e) => e.kind === 'step')!.text).toBe('读取 a.json 看配置');
    const card = cards.find((c) => c.type === 'tool-call');
    expect(card!.tool).toBe('read');
  });

  it('模型没给摘要（弱模型）→ step 为空串，渲染层回退参数摘要（不能崩）', async () => {
    const { run, events } = runWith([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.json"}' }] },
      { content: '好了' },
    ]);
    await run;

    // 仍应发出 step（空文本），把归属信息交给渲染层
    const step = events.find((e) => e.kind === 'step');
    expect(step).toBeTruthy();
    expect(step!.text).toBe('');
  });
});

describe('第8轮 — 错误路径不伪造最终回复', () => {
  it('模型调用失败：done(ok=false) 且文本是错误说明，不标记为最终回复', async () => {
    const calls: any[] = [];
    const sidecar = { call: async (m: string, p: any) => { calls.push(m); return { ok: true, data: {} }; } };
    const budget = { tickTurn: () => undefined, record: () => undefined, isSuspended: () => false, checkBreaker: () => false, snapshot: () => ({}) };
    const gateway = new ApprovalGateway(sidecar as never);
    gateway.onApproval(async () => true);
    const settings = { get: (k: string) => (k === 'workspacePath' ? '/tmp/test-ws' : undefined) };
    const rt = new ToolRuntime(sidecar as never, budget as never, gateway, settings as never);
    const client = { chatStream: async () => { throw new Error('网络不可达'); } };
    const loop = new AgentLoop(client as never, sidecar as never, settings as never, budget as never, rt);

    let doneText = '';
    let doneOk: boolean | undefined;
    await loop.run('hi', 'ask' as never, {
      onCard: () => undefined,
      onDelta: () => undefined,
      onProcessStep: () => undefined,
      onDone: (t: string, ok?: boolean) => { doneText = t; doneOk = ok; },
      onBudgetSuspended: () => undefined,
    } as never);

    expect(doneOk).toBe(false);
    expect(doneText).toContain('模型调用失败');
    expect(doneText).toContain('网络不可达');
  });
});

describe('第8轮 — system prompt 含工具调用顺序铁律', () => {
  it('首轮请求的 system 提示词声明了「先工具后结论」', async () => {
    const { run, model } = runWith([{ content: '好' }]);
    await run;
    const sys = model.seen[0]!.messages.find((m: any) => m.role === 'system');
    expect(sys).toBeTruthy();
    const text = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
    // 铁律要点应可被检索到（模型据此产出「摘要 + tool_calls」的分层输出）
    expect(text).toMatch(/tool_calls|工具调用/);
  });
});
