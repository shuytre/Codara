/**
 * 模型客户端事件契约（OpenAI 兼容流式归一层）。
 */
import { ToolSpec } from './tools';

export type Effort = 'fast' | 'balanced' | 'max';

export interface ModelConfig {
  endpoint: string; // OpenAI 兼容 base URL
  apiKey: string;
  model: string; // 当前激活模型
  /** 向导/设置页拉取并勾选的候选模型（可切换） */
  models?: string[];
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
  /** 常用模型预置（在线拉取失败时的候选 fallback） */
  models?: string[];
  pricing: { promptPerM: number; completionPerM: number };
  kind: 'cloud' | 'local' | 'custom';
  note?: string;
}

/**
 * 模型名以 2026-09 各厂商官方 API 为准：
 * - DeepSeek：deepseek-chat/-reasoner 已于 2026-07 退役 → 现行 deepseek-flash（V4.1-Flash）/ deepseek-v4-pro
 * - Agnes：apihub.agnes-ai.com/v1（OpenAI 兼容，订阅制；国内镜像 apihub.agnes-ai.cn）
 * - 智谱：旗舰 glm-5.3；免费档 glm-4.7-flash
 * - 千问：qwen3.8-max 旗舰；qwen3.8-flash 性价比档
 * - Kimi：kimi-k3 旗舰
 */
export const VENDOR_TEMPLATES: VendorTemplate[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    endpoint: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    pricing: { promptPerM: 2.1, completionPerM: 8.4 },
    kind: 'cloud',
    note: 'V4.1-Flash 现役 · 峰谷计价 · 国产直连',
  },
  {
    id: 'agnes',
    name: 'Agnes AI（订阅制）',
    endpoint: 'https://apihub.agnes-ai.com/v1',
    defaultModel: 'agnes-3.0-flash',
    models: ['agnes-3.0-flash', 'agnes-2.5-pro', 'agnes-2.5-flash', 'agnes-2.0-flash'],
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'cloud',
    note: 'OpenAI 兼容 · 国内镜像 apihub.agnes-ai.cn · 在线拉取含全部文本模型',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5', 'glm-4.7', 'glm-4.7-flash'],
    pricing: { promptPerM: 4.2, completionPerM: 15.4 },
    kind: 'cloud',
    note: 'glm-4.7-flash 免费档 · 编程订阅 Plan 可用',
  },
  {
    id: 'qwen',
    name: '阿里通义千问',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
    pricing: { promptPerM: 12, completionPerM: 36 },
    kind: 'cloud',
    note: 'qwen3.8-flash 性价比档（约 ¥1/¥3.3）',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    pricing: { promptPerM: 21, completionPerM: 105 },
    kind: 'cloud',
    note: 'K3 旗舰 · 1M 上下文',
  },
  {
    id: 'custom',
    name: '自定义端点（OpenAI 兼容）',
    endpoint: '',
    defaultModel: '',
    models: [],
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'custom',
    note: '任意 OpenAI 兼容服务：填 Base URL + Key 在线拉取模型',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型（零成本兜底）',
    endpoint: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    models: [],
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'local',
    note: '断网可用，代码不离开机器',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio 本地模型（零成本兜底）',
    endpoint: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    models: [],
    pricing: { promptPerM: 0, completionPerM: 0 },
    kind: 'local',
  },
];
