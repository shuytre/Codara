// AgentLoop 端到端回归：模型产出 tool_call → 管道执行 → 结果回注模型
//
// 覆盖验收标准：
//  1) 工具可被正常调用（read/write/terminal 真实触达 sidecar 方法）；
//  2) 调用失败时回注给模型的 error 信封清晰可追踪（含 code 与 message）；
//  3) 并行工具调用（无 index/id）不会串扰；
//  4) 工具失败不终止会话，模型仍有机会完成收尾回答。
import { describe, expect, it } from 'vitest';

import { AgentLoop } from '../../electron/src/loop/agentLoop';
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
