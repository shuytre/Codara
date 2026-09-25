// mock-llm：本地 OpenAI 兼容端点（SSE 流式），供自动化测试。
// 场景注入：消息中包含 [MOCK:xxx] 指令时触发对应行为。
//   [MOCK:429]        → 先返回 3 次 429（带 Retry-After），之后正常
//   [MOCK:tool-read]  → 返回一次 read 工具调用，内容为读取指定文件
//   [MOCK:tool-write] → 返回一次 write 工具调用（追加一行）
//   [MOCK:long]       → 返回超长输出（治理管线测试）
//   默认             → 流式回显
import * as http from 'http';

const PORT = Number(process.env.MOCK_LLM_PORT || 8787);
let state429 = new Map(); // per-conversation 429 计数（简化：全局）

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const lastUser = [...(parsed.messages || [])].reverse().find((m) => m.role === 'user');
    const text = lastUser?.content || '';

    // 429 场景：前 3 次
    if (text.includes('[MOCK:429]')) {
      const n = state429.get('n') || 0;
      state429.set('n', n + 1);
      if (n < 3) {
        res.writeHead(429, { 'Retry-After': '0.1', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited (mock)' } }));
        return;
      }
      state429.set('n', 0);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 工具调用场景
    if (text.includes('[MOCK:tool-read]')) {
      const file = text.match(/\[MOCK:tool-read:([^\]]+)\]/)?.[1] || 'README.md';
      sendSse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-mock-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 42, completion_tokens: 7 } },
        { done: true },
      ]);
      return;
    }
    if (text.includes('[MOCK:tool-write]')) {
      const file = text.match(/\[MOCK:tool-write:([^\]]+)\]/)?.[1] || 'notes.txt';
      sendSse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-mock-2', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: file, edits: [{ insertAfter: 'hello', newText: 'world' }], create: true }) } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 12 } },
        { done: true },
      ]);
      return;
    }

    // 默认：流式回显 + usage
    const reply = text.includes('[MOCK:long]')
      ? ('Codara 治理管线测试输出。'.repeat(400) + '\n').repeat(5)
      : `收到：${text.replace(/\[MOCK:[^\]]+\]/g, '').trim()}（mock 回复）`;
    const chunks = reply.match(/.{1,16}/gs) || [];
    const events = chunks.map((c) => ({ choices: [{ delta: { content: c } }] }));
    events.push({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(reply.length / 4) } });
    events.push({ done: true });
    sendSse(res, events);
  });
});

function sendSse(res, events) {
  let i = 0;
  const timer = setInterval(() => {
    if (i >= events.length) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const e = events[i++];
    if (e.done) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }, 5);
}

server.listen(PORT, () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
});
