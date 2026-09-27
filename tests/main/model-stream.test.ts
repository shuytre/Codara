// 流式 tool_calls 聚合回归测试（B1）
//
// 背景：部分 OpenAI 兼容厂商不下发 tool_call 的 index / id。原实现把这
// 类增量一律并入「最后一个槽」，导致模型并行发起多个工具调用时：
//   - name 被拼接成 "readsearch"
//   - arguments 交错串成 '{"path":"a"{"pattern":"x"}}'
//   → 工具名未知 + JSON 解析失败，多工具调用整体报废。
//
// 修复后：无 index/id 时按「槽是否需要续帧」判定新槽，并保证单工具跨帧合并、
// 每帧重发全名、CR/LF/CRLF 分帧等形态均正确。
import * as http from 'http';

import { describe, expect, it } from 'vitest';

import { isJsonBalanced, ModelClient } from '../../electron/src/model/client';

/** 起一个假 OpenAI 兼容 SSE 服务，按给定分隔符回放帧 */
function fakeServer(frames: string[], sep = '\n\n'): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const f of frames) res.write(`data: ${f}${sep}`);
      res.write(`data: [DONE]${sep}`);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => server.close() });
    });
  });
}

function makeClient(endpoint: string, maxRetries = 0) {
  const settings = {
    get: (k: string) =>
      k === 'provider'
        ? { endpoint, model: 'm', maxRetries, timeoutMs: 2000, stripUnknown: true, effort: 'balanced' }
        : undefined,
  };
  return new ModelClient(settings as never, { getApiKey: async () => 'k' } as never);
}

/** 构造一帧 delta.tool_calls */
function frame(toolCalls: Array<Record<string, unknown>>, extraDelta: Record<string, unknown> = {}): string {
  return JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls, ...extraDelta } }] });
}

async function collect(frames: string[], sep = '\n\n') {
  const s = await fakeServer(frames, sep);
  const c = makeClient(s.url);
  try {
    return await c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
  } finally {
    s.close();
  }
}

describe('isJsonBalanced', () => {
  it('识别括号闭合 / 截断 / 字符串内括号', () => {
    expect(isJsonBalanced('{"path":"a"}')).toBe(true);
    expect(isJsonBalanced('{"path":"a')).toBe(false);
    expect(isJsonBalanced('{"path":"a"')).toBe(false); // 字符串未闭合
    expect(isJsonBalanced('')).toBe(false);
    expect(isJsonBalanced('{"a":"}]"}')).toBe(true); // 字符串内的括号不计数
    expect(isJsonBalanced('{"a":"}]"')).toBe(false);
    expect(isJsonBalanced('[{"newText":"x"}]')).toBe(true);
  });
});

describe('B1: 并行工具调用聚合（无 index / 无 id）', () => {
  it('同一帧内两个工具调用不塌成一槽', async () => {
    const r = await collect([
      frame([
        { function: { name: 'read', arguments: '{"path":"a"' } },
        { function: { name: 'search', arguments: '{"pattern":"x"' } },
      ]),
      // 后续帧只带续帧片段、无 name / 无 index / 无 id
      frame([{ function: { arguments: '}' } }, { function: { arguments: '}' } }]),
    ]);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['read', 'search']);
    expect(JSON.parse(r.toolCalls[0]!.arguments)).toEqual({ path: 'a' });
    expect(JSON.parse(r.toolCalls[1]!.arguments)).toEqual({ pattern: 'x' });
  });

  it('单工具跨多帧仍合并为一槽（不误开新槽）', async () => {
    const r = await collect([
      frame([{ function: { name: 'write', arguments: '{"path":"a",' } }]),
      frame([{ function: { arguments: '"edits":[{"newText":"x"' } }]),
      frame([{ function: { arguments: '}]}' } }]),
    ]);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.name).toBe('write');
    expect(JSON.parse(r.toolCalls[0]!.arguments)).toEqual({ path: 'a', edits: [{ newText: 'x' }] });
  });

  it('并行调用跨帧续写仍各自闭合', async () => {
    const r = await collect([
      frame([
        { function: { name: 'read', arguments: '{"path":' } },
        { function: { name: 'terminal', arguments: '{"command":' } },
      ]),
      frame([{ function: { arguments: '"src/a.ts"}' } }, { function: { arguments: '"dir"}' } }]),
    ]);
    expect(r.toolCalls).toHaveLength(2);
    expect(JSON.parse(r.toolCalls[0]!.arguments)).toEqual({ path: 'src/a.ts' });
    expect(JSON.parse(r.toolCalls[1]!.arguments)).toEqual({ command: 'dir' });
  });
});

describe('兼容性：厂商差异形态', () => {
  it('标准 index + id 形态', async () => {
    const r = await collect([
      frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":' } }]),
      frame([{ index: 0, id: 'c1', function: { arguments: '"a.txt"}' } }]),
    ]);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.name).toBe('read');
    expect(r.toolCalls[0]!.arguments).toBe('{"path":"a.txt"}');
  });

  it('每帧重发全名不拼成 readread', async () => {
    const r = await collect([
      frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }]),
      frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: 'th":"a"}' } }]),
    ]);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]!.name).toBe('read');
  });

  it('无 id 时聚合结束补齐合成 id（严格实现要求 tool_call_id 配对）', async () => {
    const r = await collect([frame([{ index: 0, function: { name: 'read', arguments: '{"path":"a"}' } }])]);
    expect(r.toolCalls[0]!.id).toBeTruthy();
  });

  it('CRLF 分帧（反向代理常见）不丢帧', async () => {
    const r = await collect(
      [
        JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
        frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }]),
      ],
      '\r\n\r\n'
    );
    expect(r.content).toBe('hello');
    expect(r.toolCalls).toHaveLength(1);
  });

  it('内容与工具调用混合产出', async () => {
    const r = await collect([
      JSON.stringify({ choices: [{ delta: { content: '我先读文件。' } }] }),
      frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }]),
    ]);
    expect(r.content).toBe('我先读文件。');
    expect(r.toolCalls).toHaveLength(1);
  });
});

describe('失败与重试路径', () => {
  it('HTTP 500 一次性重试后成功', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${frame([{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }])}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const c = makeClient(`http://127.0.0.1:${addr.port}/v1`, 2);
    try {
      const r = await c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
      expect(hits).toBe(2);
      expect(r.toolCalls).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('HTTP 400 不可重试，抛出含状态码的错误', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tool_call_id mismatch' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const c = makeClient(`http://127.0.0.1:${addr.port}/v1`, 3);
    try {
      await expect(c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined)).rejects.toThrow(/HTTP 400/);
    } finally {
      server.close();
    }
  });

  it('请求超时抛出可诊断错误', async () => {
    const server = http.createServer(() => {
      /* 永不响应，触发客户端 timeout */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const c = makeClient(`http://127.0.0.1:${addr.port}/v1`, 0);
    try {
      await expect(c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined)).rejects.toThrow(/timeout/);
    } finally {
      server.close();
    }
  });

  it('signal aborted 立即抛出，不进入重试', async () => {
    const server = http.createServer(() => {
      /* 挂起 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    const c = makeClient(`http://127.0.0.1:${addr.port}/v1`, 5);
    const ac = new AbortController();
    try {
      const p = c.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, () => undefined, ac.signal);
      ac.abort();
      await expect(p).rejects.toThrow(/aborted/);
    } finally {
      server.close();
    }
  });
});
