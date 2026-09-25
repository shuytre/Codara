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
    onEvent: (e: StreamEvent) => void
  ): Promise<ChatResult> {
    const p = this.settings.get('provider');
    const apiKey = await this.budget.getApiKey();
    const maxRetries = p.maxRetries;

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.once(req, onEvent, apiKey, p.endpoint, p.model, p.stripUnknown === true, p.timeoutMs);
      } catch (err) {
        const e = err as RetryableError;
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
    timeoutMs: number
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
          throw evt.error;
        }
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
            const idx: number = tc.index ?? 0;
            while (toolCalls.length <= idx) {
              toolCalls.push({ id: '', name: '', arguments: '' });
            }
            const slot = toolCalls[idx] as { id: string; name: string; arguments: string };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
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
      }
    ).then(() => {
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

  /** SSE 流：手写分帧（\n\n → data: 行 → [DONE]） */
  private httpStream(
    endpoint: string,
    apiKey: string,
    body: string,
    timeoutMs: number,
    onChunk: (evt: SseEvent) => void
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
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of frame.split('\n')) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ChatMessage };
