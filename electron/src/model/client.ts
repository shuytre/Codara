// 模型客户端：OpenAI 兼容流式（SSE）、429/5xx 指数退避、effort 映射、usage 对账
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

import {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelProvider,
  StreamEvent,
  mapEffort,
} from '@codara/contract';

import { SettingsStore } from '../config/settingsStore';
import { BudgetLedger } from '../budget/ledger';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export class ModelClient implements ModelProvider {
  constructor(
    private readonly settings: SettingsStore,
    private readonly budget: BudgetLedger
  ) {}

  get config() {
    return {
      ...this.settings.get('provider'),
      apiKey: '', // 不外泄
    } as never;
  }

  /** 流式对话：返回最终聚合结果；事件回调实时推送 */
  async chatStream(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const p = this.settings.get('provider');
    const apiKey = await this.budget.getApiKey();
    const maxRetries = p.maxRetries;

    let attempt = 0;
    for (;;) {
      attempt++;
      if (signal?.aborted) throw new Error('aborted');
      try {
        return await this.once(req, onEvent, apiKey, p.endpoint, p.model, p.stripUnknown === true, p.timeoutMs, signal);
      } catch (err) {
        const e = err as RetryableError;
        // 用户主动终止：不重试，直接抛出
        if (signal?.aborted || e.message === 'aborted') {
          throw new Error('aborted');
        }
        if (!e.retryable || attempt > maxRetries) {
          throw err;
        }
        const delay = e.retryAfterMs ?? Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.random() * 500;
        onEvent({
          type: 'error',
          message: `retrying after ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries}): ${e.message}`,
          retryable: true,
          retryAfterMs: delay,
          status: e.status,
        });
        await sleep(delay);
      }
    }
  }

  private once(
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
    apiKey: string,
    endpoint: string,
    model: string,
    stripUnknown: boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: req.messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (!stripUnknown) {
      body.reasoning_effort = mapEffort(this.settings.get('provider').effort);
    }

    let content = '';
    let reasoning = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: { promptTokens: number; completionTokens: number } = { promptTokens: 0, completionTokens: 0 };
    let finishReason = '';

    return this.httpStream(
      endpoint,
      apiKey,
      JSON.stringify(body),
      timeoutMs,
      (evt) => {
        // SSE delta 解析（归一层）
        if (evt.error) {
          throw evt.error;        }
        if (evt.done) {
          onEvent({ type: 'done' });
          return;
        }
        const payload = (evt.payload ?? {}) as SsePayload;
        const choice = payload.choices?.[0];
        if (!choice) {
          if (payload.usage) {
            usage = {
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
            };
            onEvent({ type: 'usage', ...usage });
          }
          return;
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          onEvent({ type: 'delta', text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            // 槽位定位：优先厂商下发的 index；缺 index 时按 id 匹配既有槽。
            // 部分兼容实现不发 index：原实现一律堆进 0 号槽，多工具并行时
            // arguments 交错损坏 → JSON.parse 失败 → 工具调用必失败。
            let idx: number;
            if (typeof tc.index === 'number') {
              idx = tc.index;
            } else if (tc.id) {
              const found = toolCalls.findIndex((t) => t.id === tc.id);
              idx = found >= 0 ? found : toolCalls.length;
            } else {
              // 无 index 无 id：归入最后一个槽（单工具场景的后续增量帧）
              idx = toolCalls.length > 0 ? toolCalls.length - 1 : 0;
            }
            while (toolCalls.length <= idx) {
              toolCalls.push({ id: '', name: '', arguments: '' });
            }
            const slot = toolCalls[idx] as { id: string; name: string; arguments: string };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) {
              const n = tc.function.name;
              // name 形态兼容：首帧赋值；厂商每帧重发全名则跳过（原实现 += 会
              // 拼出 "readread" → unknown tool）；累积式（新值含旧值）替换；其余增量拼接
              if (!slot.name) slot.name = n;
              else if (slot.name !== n && n.startsWith(slot.name)) slot.name = n;
              else if (slot.name !== n) slot.name += n;
            }
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            onEvent({ type: 'tool_call_delta', index: idx, id: tc.id, name: tc.function?.name, argsDelta: tc.function?.arguments });
          }
        }
        if (payload.usage) {
          usage = {
            promptTokens: payload.usage.prompt_tokens ?? 0,
            completionTokens: payload.usage.completion_tokens ?? 0,
          };
          onEvent({ type: 'usage', ...usage });
        }
      },
      signal
    ).then(() => {
      // 部分厂商从不下发 tool_call id：空 id 回注历史后，严格实现的
      // /chat/completions 会以 400 拒绝（tool_call_id 配对失败），
      // 从第一个工具轮次起整个会话全部请求失败 —— 聚合结束时必须补齐。
      for (let i = 0; i < toolCalls.length; i++) {
        const slot = toolCalls[i] as { id: string; name: string; arguments: string };
        if (!slot.id) slot.id = `call-${i}-${Date.now()}`;
      }
      // done 对账：无 usage 时按 chars/4 估算
      if (usage.promptTokens === 0 && usage.completionTokens === 0) {
        const promptChars = req.messages.reduce((n, m) => n + (m.content?.length || 0), 0);
        usage = {
          promptTokens: Math.ceil(promptChars / 4),
          completionTokens: Math.ceil((content.length + reasoning.length) / 4),
        };
        onEvent({ type: 'usage', ...usage });
      }
      return {
        content,
        reasoning,
        toolCalls,
        usage,
        finishReason,
      };
    });
  }

  /** SSE 流：手写分帧（空行分帧 → data: 行 → [DONE]） */
  private httpStream(
    endpoint: string,
    apiKey: string,
    body: string,
    timeoutMs: number,
    onChunk: (evt: SseEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const url = new URL(endpoint.replace(/\/$/, '') + '/chat/completions');
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    return new Promise<void>((resolve, reject) => {
      const req = mod.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
          signal,
        },
        (res) => {
          const status = res.statusCode || 500;
          if (status === 429 || status >= 500) {
            // 读出 body 便于诊断，然后作为可重试错误
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d as Buffer));
            res.on('end', () => {
              const retryAfterHeader = res.headers['retry-after'];
              const retryAfterMs = retryAfterHeader ? parseFloat(String(retryAfterHeader)) * 1000 : undefined;
              const err: RetryableError = Object.assign(
                new Error(`HTTP ${status}: ${Buffer.concat(chunks).toString().slice(0, 300)}`),
                { retryable: true, retryAfterMs, status }
              );
              reject(err);
            });
            return;
          }
          if (status >= 400) {
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d as Buffer));
            res.on('end', () => {
              reject(new Error(`HTTP ${status}: ${Buffer.concat(chunks).toString().slice(0, 500)}`));
            });
            return;
          }

          // SSE 解析
          let buffer = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            // 帧分隔符兼容三种行尾（SSE 规范允许 CR / LF / CRLF）。
            // 原实现只找 '\n\n'：CRLF 分帧的服务端（反向代理、部分厂商）会让
            // 所有帧滞留 buffer 直到流结束 —— content 与 toolCalls 全空，
            // 表现为「模型不产出任何工具调用」的静默失败。
            let m: RegExpExecArray | null;
            while ((m = SSE_FRAME_SEP.exec(buffer))) {
              const frame = buffer.slice(0, m.index);
              buffer = buffer.slice(m.index + m[0].length);
              for (const line of frame.split(SSE_LINE_SEP)) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                  onChunk({ done: true });
                  resolve();
                  return;
                }
                try {
                  onChunk({ payload: JSON.parse(data) });
                } catch {
                  // 跳过坏帧
                }
              }
            }
          });
          res.on('end', () => resolve());
          res.on('error', (e) => {
            const err: RetryableError = Object.assign(new Error(`stream error: ${e.message}`), {
              retryable: true,
            });
            reject(err);
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        const err: RetryableError = Object.assign(new Error('request timeout'), { retryable: true });
        reject(err);
      });
      req.on('error', (e) => {
        const err: RetryableError = Object.assign(new Error(`network: ${e.message}`), { retryable: true });
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }
}

interface SseEvent {
  payload?: unknown;
  done?: boolean;
  error?: Error;
}

/** OpenAI 兼容 SSE chunk（httpStream 只负责分帧，结构归一层解包） */
interface SsePayload {
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      reasoning_content?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface RetryableError extends Error {
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
}

/** SSE 空行分帧与行分割：CR / LF / CRLF 三种行尾形态均合法（WHATWG SSE 规范）。
 *  非 global regex：exec 总是从头匹配，循环内天然取「最靠前的分隔符」。 */
const SSE_FRAME_SEP = /\r\n\r\n|\n\n|\r\r/;
const SSE_LINE_SEP = /\r\n|\r|\n/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ChatMessage };
