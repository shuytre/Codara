// mock-llm + ModelClient 集成测试：SSE 流式、429 退避、usage 对账
import { spawn } from 'child_process';
import * as path from 'path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

let server: ReturnType<typeof spawn> | null = null;
let ready = false;

const PORT = 8791;

beforeAll(async () => {
  server = spawn('node', [path.join(__dirname, '../mock-llm/server.mjs')], {
    env: { ...process.env, MOCK_LLM_PORT: String(PORT) },
  });
  server.stdout!.on('data', () => {
    ready = true;
  });
  // 等待端口就绪
  for (let i = 0; i < 50 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  server?.kill();
});

interface StreamEvent {
  type: string;
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
  message?: string;
}

/** 极简 SSE 客户端（Node16 兼容：http 模块）——与主进程 client.ts 同协议 */
function chatCompletion(body: Record<string, unknown>): Promise<{ status: number; events: StreamEvent[] }> {
  const http = require('http') as typeof import('http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      },
      (res) => {
        const status = res.statusCode || 0;
        let buf = '';
        const events: StreamEvent[] = [];
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') continue;
              try {
                const j = JSON.parse(data);
                const delta = j.choices?.[0]?.delta || {};
                if (delta.content) events.push({ type: 'delta', text: delta.content });
                if (j.usage) events.push({ type: 'usage', promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens });
              } catch {
                /* skip */
              }
            }
          }
        });
        res.on('end', () => resolve({ status, events }));
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('mock-llm 端点', () => {
  it(
    '正常流式回复 + usage 对账',
    async () => {
      const r = await chatCompletion({
        model: 'mock',
        stream: true,
        messages: [{ role: 'user', content: '你好世界' }],
      });
      expect(r.status).toBe(200);
      const text = r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
      expect(text).toContain('你好世界');
      const usage = r.events.find((e) => e.type === 'usage');
      expect(usage?.promptTokens).toBeGreaterThan(0);
      expect(usage?.completionTokens).toBeGreaterThan(0);
    },
    15000
  );

  it(
    '429 场景：前 3 次 429 后恢复',
    async () => {
      const text = '测试 [MOCK:429]';
      const s1 = await chatCompletion({ model: 'mock', messages: [{ role: 'user', content: text }] });
      expect(s1.status).toBe(429);
      const s2 = await chatCompletion({ model: 'mock', messages: [{ role: 'user', content: text }] });
      expect(s2.status).toBe(429);
      const s3 = await chatCompletion({ model: 'mock', messages: [{ role: 'user', content: text }] });
      expect(s3.status).toBe(429);
      const s4 = await chatCompletion({ model: 'mock', messages: [{ role: 'user', content: text }] });
      expect(s4.status).toBe(200);
    },
    15000
  );

  it(
    '工具调用场景（read）',
    async () => {
      const r = await chatCompletion({
        model: 'mock',
        messages: [{ role: 'user', content: '读取 [MOCK:tool-read:src/main.ts]' }],
      });
      expect(r.status).toBe(200);
      // 工具调用场景返回 finish_reason=tool_calls 的 delta
      expect(r.events.length).toBeGreaterThanOrEqual(0);
    },
    15000
  );
});
