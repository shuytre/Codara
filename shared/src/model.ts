/**
 * 模型客户端事件契约（OpenAI 兼容流式归一层）。
 */
import { ToolSpec } from './tools';

export type Effort = 'fast' | 'balanced' | 'max';

export interface ModelConfig {
  endpoint: string; // OpenAI 兼容 base URL
  apiKey: string;
  model: string;
  contextLength: number;
  effort: Effort;
  timeoutMs: number;
  maxRetries: number;
  proxy?: string;
  /** 某些厂商拒绝未知字段；开启后请求剥离 reasoning_effort 等扩展字段 */
  stripUnknown?: boolean;
  /** 模板名（首次启动向导预置） */
  templateId?: string;
  pricing: { promptPerM: number; completionPerM: number }; // ¥/1M tokens
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done' }
  | { type: 'error'; message: string; retryable: boolean; retryAfterMs?: number; status?: number };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string; // role=tool 时
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

export interface ModelProvider {
  readonly config: ModelConfig;
  chatStream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResult>;
}

/** effort → reasoning_effort 映射（厂商差异在模板层处理） */
export function mapEffort(e: Effort): string {
  return e === 'fast' ? 'low' : e === 'balanced' ? 'medium' : 'high';
}

/** 首次启动向导预置模板（国产直连主打 + 本地兜底，规格 5.4/7.7） */
export interface VendorTemplate {
  id: string;
  name: string;
  endpoint: string;
  defaultModel: string;
  pricing: { promptPerM: number; completionPerM: number };
  kind: 'cloud' | 'local';
  note?: string;
}

export const VENDOR_TEMPLATES: VendorTemplate[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    endpoint: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    pricing: { promptPerM: 2, completionPerM: 8 },
    kind: 'cloud',
    note: '国产直连，无需科学上网',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    pricing: { promptPerM: 0.1, completionPerM: 0.1 },
    kind: 'cloud',
    note: '低价档位，Flash 型号缓存优惠',
  },
  {
    id: 'qwen',
    name: '阿里通义千问',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    pricing: { promptPerM: 0.8, completionPerM: 2 },
    kind: 'cloud',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    pricing: { promptPerM: 12, completionPerM: 12 },
    kind: 'cloud',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型（零成本兜底）',
    endpoint: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'local',
    note: '断网可用，代码不离开机器',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio 本地模型（零成本兜底）',
    endpoint: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'local',
  },
];
