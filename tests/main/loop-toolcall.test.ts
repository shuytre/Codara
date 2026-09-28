// AgentLoop 端到端回归：模型产出 tool_call → 管道执行 → 结果回注模型
//
// 覆盖验收标准：
//  1) 工具可被正常调用（read/write/terminal 真实触达 sidecar 方法）；
//  2) 调用失败时回注给模型的 error 信封清晰可追踪（含 code 与 message）；
//  3) 并行工具调用（无 index/id）不会串扰；
//  4) 工具失败不终止会话，模型仍有机会完成收尾回答。
import { describe, expect, it } from 'vitest';

import { AgentLoop, parseToolArgs, coerceToolArgs, sanitizeOutgoingMessages } from '../../electron/src/loop/agentLoop';
import { ToolRuntime } from '../../electron/src/tools/runtime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';

interface Turn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** 模型桩：按剧本逐轮返回；每轮记录收到的 messages 以便断言回注内容 */
function makeModel(script: Turn[]) {
  const seen: Array<{ messages: any[]; tools: any[] }> = [];
  let i = 0;
  return {
    seen,
    client: {
      chatStream: async (req: any) => {
        seen.push({ messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools ?? [] });
        const t = script[Math.min(i, script.length - 1)]!;
        i++;
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

function makeLoop(script: Turn[], sidecarHandler?: (m: string, p: any) => any) {
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
  const model = makeModel(script);
  const loop = new AgentLoop(model.client as never, sidecar as never, settings as never, budget as never, rt);
  return { loop, calls, model };
}

async function runLoop(script: Turn[], sidecarHandler?: (m: string, p: any) => any, mode: 'ask' | 'plan' | 'goal' = 'ask') {
  const { loop, calls, model } = makeLoop(script, sidecarHandler);
  const cards: any[] = [];
  let done = '';
  await loop.run('做点事', mode, {
    onCard: (c) => cards.push(c),
    onDelta: () => undefined,
    onDone: (t) => {
      done = t;
    },
    onBudgetSuspended: () => undefined,
  });
  return { calls, cards, model, done };
}

describe('端到端：工具正常调用', () => {
  it('read 工具调用触达 sidecar 并产出 done 卡片', async () => {
    const { calls, cards, done } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }] },
      { content: '读取完成' },
    ]);
    expect(calls.some((c) => c.method === 'fs.read')).toBe(true);
    expect(cards.some((c) => c.type === 'tool-call' && c.tool === 'read' && c.status === 'done')).toBe(true);
    expect(done).toBe('读取完成');
  });

  it('write 调用产出 diff 卡片', async () => {
    const { cards } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"a.html","create":true,"edits":[{"newText":"<html/>"}]}' }] },
      { content: '写入完成' },
    ]);
    expect(cards.some((c) => c.type === 'diff')).toBe(true);
  });

  it('并行两个工具调用（无 index/id 形态经聚合后）全部执行', async () => {
    const { calls } = await runLoop([
      {
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a.txt"}' },
          { id: 'c2', name: 'search', arguments: '{"pattern":"x"}' },
        ],
      },
      { content: '完成' },
    ]);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('fs.read');
    expect(methods).toContain('search.run');
  });
});

describe('端到端：失败回注清晰错误', () => {
  it('sidecar 返回业务错误时，回注模型的信封含 code 与 message', async () => {
    const { model } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"nope.txt"}' }] },
        { content: '文件不存在' },
      ],
      (m) => (m === 'fs.read' ? { ok: false, error: { code: 1007, message: 'not found: nope.txt' } } : { ok: true, data: {} })
    );
    // 第二轮请求里应包含 role='tool' 的结果消息
    const secondReq = model.seen[1]!;
    const toolMsg = secondReq.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(toolMsg).toBeTruthy();
    const payload = JSON.parse(toolMsg.content);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe(1007);
    expect(payload.error).toContain('not found');
  });

  it('参数错误（缺 path）回注精确错误且不触达 sidecar', async () => {
    const { calls, model } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { content: '已修正' },
    ]);
    expect(calls.filter((c) => c.method === 'fs.read').length).toBe(0);
    const toolMsg = model.seen[1]!.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    const payload = JSON.parse(toolMsg.content);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe(-32602);
    expect(payload.error).toContain('path');
  });

  it('arguments 非 JSON 时回注解析错误，不静默当空参数', async () => {
    const { calls, model } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'read', arguments: '这不是JSON' }] },
      { content: '收到' },
    ]);
    expect(calls.filter((c) => c.method === 'fs.read').length).toBe(0);
    const toolMsg = model.seen[1]!.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    expect(JSON.parse(toolMsg.content).error).toContain('不是合法 JSON');
  });

  it('工具抛异常（如超时）被捕获，回注错误并继续会话', async () => {
    const { model, done } = await runLoop(
      [
        { toolCalls: [{ id: 'c1', name: 'terminal', arguments: '{"command":"dir"}' }] },
        { content: '已说明卡点' },
      ],
      (m) => {
        if (m === 'term.exec') throw new Error('sidecar call timeout: term.exec');
        return { ok: true, data: {} };
      }
    );
    const toolMsg = model.seen[1]!.messages.find((x: any) => x.role === 'tool' && x.tool_call_id === 'c1');
    expect(JSON.parse(toolMsg.content).error).toContain('timeout');
    expect(done).toBe('已说明卡点'); // 会话未终止
  });

  it('未知工具回注「未知工具」而非权限拒绝', async () => {
    const { model } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'readfile', arguments: '{"path":"a"}' }] },
      { content: '改用 read' },
    ]);
    const toolMsg = model.seen[1]!.messages.find((x: any) => x.role === 'tool' && x.tool_call_id === 'c1');
    const payload = JSON.parse(toolMsg.content);
    expect(payload.code).toBe(-32601);
    expect(payload.error).toContain('未知工具');
  });
});

describe('端到端：工具集与系统提示词一致', () => {
  it('ask 模式只把 read/write/terminal/search 交给模型', async () => {
    const { model } = await runLoop([{ content: '好' }]);
    const names = model.seen[0]!.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['read', 'search', 'terminal', 'write']);
  });

  it('plan 模式暴露全量工具（含 git 与索引）', async () => {
    const { model } = await runLoop([{ content: '好' }], undefined, 'plan');
    const names = model.seen[0]!.tools.map((t: any) => t.name);
    expect(names).toContain('git');
    expect(names).toContain('index.symbols');
  });
});

// ---------------------------------------------------------------- 第四轮：坏 JSON 参数与对话中断
//
// 截图暴露的两个问题：
//  A) write 连续失败 —— 模型发的 arguments 是 {"create":true,"path":"x.py"}（缺 edits），
//     或被包成非法 JSON；旧实现只回注「JSON 语法错」，模型无法自纠，原样重发。
//  B) HTTP 400「Assistant tool call arguments must be valid JSON」—— 坏参数被钉进历史，
//     此后每轮请求都带毒，接口直接 400，整轮对话中断。

describe('A: parseToolArgs 常见坏形态自修复', () => {
  it('标准 JSON 正常解析', () => {
    expect(parseToolArgs('{"path":"a.txt"}')).toEqual({ path: 'a.txt' });
  });

  it('代码围栏包裹', () => {
    expect(parseToolArgs('```json\n{"path":"a.txt"}\n```')).toEqual({ path: 'a.txt' });
  });

  it('前置说明文字', () => {
    expect(parseToolArgs('好的，我来读取：{"path":"a.txt"}')).toEqual({ path: 'a.txt' });
  });

  it('尾逗号', () => {
    expect(parseToolArgs('{"path":"a.txt",}')).toEqual({ path: 'a.txt' });
  });

  it('单引号键值（弱模型常见非法形态，激进修复）', () => {
    expect(parseToolArgs("{'path':'a.txt','create':true}")).toEqual({ path: 'a.txt', create: true });
  });

  it('括号未闭合（截断）自动补齐', () => {
    expect(parseToolArgs('{"path":"a.txt"')).toEqual({ path: 'a.txt' });
    expect(parseToolArgs('{"edits":[{"newText":"x"}]')).toEqual({ edits: [{ newText: 'x' }] });
  });

  it('彻底无法修复时抛错（不能静默当空参数）', () => {
    expect(() => parseToolArgs('这不是JSON')).toThrow(/不是合法 JSON/);
  });
});

describe('A: coerceToolArgs 缺参精确回注', () => {
  const writeSpec = {
    name: 'write',
    description: '',
    parameters: { type: 'object', required: ['path', 'edits'], properties: { path: { type: 'string', description: '目标路径' }, edits: { type: 'array', description: '编辑项' } } },
  } as any;

  it('write 且 create=true 仅给 path → 自动补空 edits（建空文件）', () => {
    const r = coerceToolArgs(writeSpec, { path: 'desktop_pet.py', create: true });
    expect(r.params).toEqual({ path: 'desktop_pet.py', create: true, edits: [{ newText: '' }] });
    expect(r.note).toContain('空文件');
    expect(r.error).toBeUndefined();
  });

  it('write 且 create≠true 缺 edits → 不兜底，回注精确错误（不覆盖已有文件）', () => {
    const r = coerceToolArgs(writeSpec, { path: 'a.ts' });
    expect(r.params).toBeUndefined();
    expect(r.error).toContain('edits');
    expect(r.error).toContain('必填');
    expect(r.error).toContain('正确形状示例');
  });

  it('必填齐全时原样返回（不打扰）', () => {
    const p = { path: 'a.txt', edits: [{ newText: 'x' }] };
    expect(coerceToolArgs(writeSpec, p).params).toBe(p);
  });

  it('非对象参数回注错误', () => {
    expect(coerceToolArgs(writeSpec, 'oops').error).toContain('JSON 对象');
  });
});

describe('A 端到端: 截图里的 write 缺 edits 不再死循环', () => {
  it('create=true 仅给 path → 补齐后成功建文件（不再回注错误空转）', async () => {
    const { calls, cards } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"create":true,"path":"desktop_pet.py"}' }] },
      { content: '已创建' },
    ]);
    // 触达 sidecar 并成功
    expect(calls.some((c) => c.method === 'fs.patch')).toBe(true);
    expect(cards.some((c) => c.type === 'tool-call' && c.tool === 'write' && c.status === 'done')).toBe(true);
  });

  it('缺 edits 且非新建 → 回注含正确示例的错误（模型可一次改对）', async () => {
    const { calls, model } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"a.ts"}' }] },
      { content: '已修正' },
    ]);
    expect(calls.filter((c) => c.method === 'fs.patch').length).toBe(0);
    const toolMsg = model.seen[1]!.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1');
    const payload = JSON.parse(toolMsg.content);
    expect(payload.error).toContain('edits');
    expect(payload.error).toContain('正确形状示例');
  });
});

describe('B: sanitizeOutgoingMessages 发送前清洗历史', () => {
  it('坏 arguments 被重写为合法 JSON，且 tool_call 不被删除（避免孤立 tool 消息）', () => {
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{bad json' } }] },
    ] as any;
    const out = sanitizeOutgoingMessages(msgs);
    const args = out[0]!.tool_calls![0]!.function.arguments;
    expect(() => JSON.parse(args)).not.toThrow();
    expect(JSON.parse(args).__invalid_arguments__).toContain('{bad json');
    expect(out[0]!.tool_calls!.length).toBe(1); // 保留配对
  });

  it('合法 arguments 原样保留', () => {
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    ] as any;
    const out = sanitizeOutgoingMessages(msgs);
    expect(out[0]!.tool_calls![0]!.function.arguments).toBe('{"path":"a"}');
  });

  it('assistant 带 tool_calls 时 content 空串置 null（严格接口要求）', () => {
    const msgs = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    ] as any;
    expect(sanitizeOutgoingMessages(msgs)[0]!.content).toBeNull();
  });

  it('不改动原数组（历史保留原文供排查）', () => {
    const bad = '{oops';
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: bad } }] },
    ] as any;
    sanitizeOutgoingMessages(msgs);
    expect(msgs[0].tool_calls[0].function.arguments).toBe(bad);
  });

  it('端到端：坏参数历史被清洗后，第二轮请求里每条 tool_calls.arguments 都是合法 JSON', async () => {
    const { model } = await runLoop([
      { toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"a.ts"}' }] },
      { toolCalls: [{ id: 'c2', name: 'read', arguments: '{"path":"a.ts"}' }] },
      { content: '完成' },
    ]);
    // 第二轮请求携带第一轮的 assistant.tool_calls：必须已清洗为合法 JSON
    const secondReq = model.seen[1]!;
    const assistants = secondReq.messages.filter((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistants.length).toBeGreaterThan(0);
    for (const a of assistants) {
      for (const tc of a.tool_calls) {
        expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
      }
    }
  });
});
