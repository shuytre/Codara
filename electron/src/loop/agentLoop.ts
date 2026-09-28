// 单 Agent 主循环（M2：极简模式直连驱动；M3：同一循环驱动专家团角色实例）
// 流程：用户消息 → chatStream → tool_calls? → 工具管道 → 结果回注 → 循环；预算熔断检查
import {
  Card,
  ChatMessage,
  CrewRole,
  PlanCard,
  ToolCallCard,
  ToolSpec,
} from '@codara/contract';

import { ROLE_DEFS, toolSpecsForRole } from '../crew/roles';

import { ModelClient } from '../model/client';
import { SidecarManager } from '../sidecar/manager';
import { SettingsStore } from '../config/settingsStore';
import { BudgetLedger } from '../budget/ledger';
import { ToolRuntime } from '../tools/runtime';
import { loadMemory } from '../memory/load';
import { withMemory } from '../memory/inject';
import { logger } from '../util/logger';

export type TaskMode = 'ask' | 'plan' | 'goal';

/** 极简模式（ask）少工具集：直干长编码而非零工具（用户反馈：极简 = 少工具 + 长 Agent 编码 + PowerShell，2026-09-27） */
const ASK_TOOLS = new Set(['read', 'search', 'write', 'terminal']);

/** M3：专家团角色实例运行上下文（会话隔离由 sessionId + roleId 绑定） */
export interface CrewRunContext {
  role: CrewRole;
  instanceId: string;
  sessionId: string;
  /** 沙箱"自动审查"临时技术会话（规格 4.8）：不注入项目记忆正文 */
  sandbox?: boolean;
}

export interface LoopCallbacks {
  onCard: (card: Card) => void;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onBudgetSuspended: () => void;
}

export class AgentLoop {
  private messages: ChatMessage[] = [];
  private aborted = false;
  private planApproved = false;
  private pendingPlan: PlanCard | null = null;
  /** 本轮运行的终止控制器：中断流式请求 / 工具执行 / 审批等待 */
  private runAbort: AbortController | null = null;
  /** abort 时唤醒所有 race 等待点 */
  private abortWaiters: Array<() => void> = [];

  constructor(
    private readonly model: ModelClient,
    private readonly sidecar: SidecarManager,
    private readonly settings: SettingsStore,
    private readonly budget: BudgetLedger,
    private readonly tools: ToolRuntime
  ) {}

  abort(): void {
    this.aborted = true;
    // 中断正在进行的流式请求（http 层 socket 直接断开）
    this.runAbort?.abort();
    // 唤醒所有 await 等待点（审批等待、工具执行等）
    for (const w of this.abortWaiters.splice(0)) w();
  }

  /** 可中断等待：正常完成返回其值；真实失败向上抛错；仅 abort() 触发时返回 undefined */
  private raceAbort<T>(p: Promise<T>): Promise<T | undefined> {
    if (this.aborted) return Promise.resolve(undefined);
    return new Promise<T | undefined>((resolve, reject) => {
      const waiter = () => resolve(undefined);
      this.abortWaiters.push(waiter);
      p.then(
        (v) => {
          const i = this.abortWaiters.indexOf(waiter);
          if (i >= 0) this.abortWaiters.splice(i, 1);
          resolve(v);
        },
        (e) => {
          const i = this.abortWaiters.indexOf(waiter);
          if (i >= 0) this.abortWaiters.splice(i, 1);
          // abort 引发的连带失败（socket 中断等）不算真实错误；其余必须抛出
          if (this.aborted) {
            resolve(undefined);
            return;
          }
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      );
    });
  }

  approvePlan(): void {
    this.planApproved = true;
  }

  reset(): void {
    this.messages = [];
    this.planApproved = false;
    this.pendingPlan = null;
  }

  /** 会话切换：恢复历史消息为模型上下文（配合 attachMainSession 使用） */
  loadMessages(history: ChatMessage[]): void {
    this.messages = history.slice();
    this.planApproved = false;
    this.pendingPlan = null;
  }

  async run(userText: string, mode: TaskMode, cb: LoopCallbacks, crew?: CrewRunContext): Promise<void> {
    this.aborted = false;
    this.runAbort = new AbortController();
    const signal = this.runAbort.signal;
    // 工具集：plan/goal 全量；ask（极简）少工具直干（去掉 git 与索引类，写与终端仍走审批卡）
    const allSpecs = this.tools.toolSpecs(false);
    const modeSpecs = mode === 'ask' ? allSpecs.filter((t) => ASK_TOOLS.has(t.name)) : allSpecs;
    // 系统提示词：专家团角色用角色提示词；主对话用三模式变体
    const systemPrompt = crew
      ? ROLE_DEFS[crew.role].systemPrompt
      : buildSystemPrompt(mode, modeSpecs.map((t) => t.name));
    // M5 记忆注入（规格 4.5/4.8）：全局/项目记忆统一注入所有角色；
    // 沙箱临时技术会话跳过项目记忆正文（4.8），角色会话历史隔离不变
    const mem = loadMemory(this.settings.get('workspacePath') || undefined);
    const fullSystemPrompt = withMemory(systemPrompt, mem, { sandbox: crew?.sandbox });
    const toolSpecs = crew
      ? toolSpecsForRole(this.tools.toolSpecs(true), crew.role)
      : modeSpecs;
    if (this.messages.length === 0) {
      const sysMsg: ChatMessage = { role: 'system', content: fullSystemPrompt };
      this.messages.push(sysMsg);
      void this.persist(crew, sysMsg);
    }
    const userMsg: ChatMessage = { role: 'user', content: userText };
    this.messages.push(userMsg);
    void this.persist(crew, userMsg);

    let iterations = 0;
    // 轮次上限：角色实例用角色矩阵；主对话按模式（ask 直干长编码给足轮次）
    const maxIter = crew ? ROLE_DEFS[crew.role].maxTurns : mode === 'goal' ? 40 : mode === 'ask' ? 20 : 12;

    for (;;) {
      if (this.aborted) break;
      iterations++;
      if (iterations > maxIter || this.budget.isSuspended()) {
        cb.onBudgetSuspended();
        break;
      }

      let result;
      try {
        result = await this.model.chatStream(
          {
            // 发送前清洗：把历史里非法的 tool_calls.arguments 重写为合法 JSON。
            // 坏 JSON 一旦被 push 进 this.messages 就会污染此后每一轮请求，
            // 接口直接 400（Assistant tool call arguments must be valid JSON）→ 整轮中断。
            messages: sanitizeOutgoingMessages(this.messages),
            tools: toolSpecs,
          },
          (e) => {
            if (e.type === 'delta') cb.onDelta(e.text);
            // 注意：这里的 usage 事件只做展示，不再记账。
            // 原实现在流式回调与收尾处各 record 一次（厂商若每 chunk 带 usage 则 ×N），
            // 导致 costLimitCNY 在真实消耗一半时误熔断，usage 库数据翻倍。
          },
          signal
        );
      } catch (err) {
        if (this.aborted) {
          // 用户终止：不留错误卡，安静收尾
          cb.onDone('（已终止）');
          return;
        }
        const msg = `模型调用失败：${(err as Error).message}`;
        cb.onDone(msg);
        this.messages.push({ role: 'assistant', content: msg });
        return;
      }

      if (this.aborted) {
        cb.onDone('（已终止）');
        return;
      }

      // 记账
      this.budget.record(result.usage.promptTokens, result.usage.completionTokens);
      if (this.budget.checkBreaker()) {
        cb.onBudgetSuspended();
        break;
      }

      if (result.toolCalls.length === 0) {
        const finalMsg: ChatMessage = { role: 'assistant', content: result.content };
        this.messages.push(finalMsg);
        void this.persist(crew, finalMsg, result.usage);
        cb.onDone(result.content);
        return;
      }

      // 工具循环：assistant 带工具调用 → 逐个执行 → 结果回注
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      this.messages.push(assistantMsg);
      void this.persist(crew, assistantMsg, result.usage);

      for (const tc of result.toolCalls) {
        if (this.aborted) break;
        // arguments 解析：带常见坏形态自修复；仍失败时明确回注错误而非静默当空参数
        // （原实现 catch 后 params={}，模型只看到「缺参数」并原样重发同样的坏 JSON，
        //  陷入无终点循环 —— 这是弱模型场景下工具调用反复失败的直接原因之一）
        let params: unknown;
        let argsError: string | null = null;
        // 缺参/形状错误时携带的 ErrorCode（-32602），与 sidecar 侧保持同一口径，
        // 便于测试与上层按码分支，而不是只有一句自然语言。
        let argsErrorCode: number | undefined;
        try {
          params = parseToolArgs(tc.arguments || '');
        } catch (e) {
          params = undefined;
          argsError = (e as Error).message;
        }

        // 解析成功但缺必填字段：先用 schema 生成精确的可自纠提示。
        // 原实现只把它当普通执行失败回注，模型看到的是 sidecar 侧「缺少必填参数」
        // 却不带正确形状，于是原样重发同样的坏参数（截图里 write 连挂两次的直接原因）。
        const spec = toolSpecs.find((t) => t.name === tc.name);
        let coercedNote: string | null = null;
        if (!argsError && spec) {
          const c = coerceToolArgs(spec, params);
          if (c.params !== undefined) {
            // 兜底：write create=true 仅给 path —— 模型想建空文件，补一个空 edits
            if (c.params !== params) {
              params = c.params;
              coercedNote = c.note ?? null;
            }
          } else if (c.error) {
            argsError = c.error;
            argsErrorCode = c.code;
          }
        }

        const card: ToolCallCard = {
          id: `tc-${Date.now()}-${tc.id}`,
          type: 'tool-call',
          status: 'running',
          createdAt: Date.now(),
          tool: tc.name,
          paramsSummary: argsError
            ? `（arguments 不可用）${(tc.arguments || '').slice(0, 280)}`
            : `${coercedNote ? `（已自愈：${coercedNote}）` : ''}${JSON.stringify(params).slice(0, 300)}`,
        };
        cb.onCard(card);

        if (argsError) {
          cb.onCard({ ...card, status: 'failed', result: argsError.slice(0, 800), ok: false });
          const failMsg = toolErrorMsg(tc.id, argsError, argsErrorCode);
          this.messages.push(failMsg);
          void this.persist(crew, failMsg);
          continue;
        }

        // 可中断工具执行（含审批等待）：abort → undefined；真实失败 → 回注错误继续循环
        let r;
        try {
          r = await this.raceAbort(this.tools.execute(tc.name, params, mode, crew?.role));
        } catch (toolErr) {
          const errMsg = (toolErr as Error)?.message || String(toolErr);
          logger.warn('tool execution failed', { tool: tc.name, err: errMsg });
          cb.onCard({ ...card, status: 'failed', result: errMsg.slice(0, 800), ok: false });
          // 失败结果回注模型：由模型决定重试/换路/向用户说明，而不是终止会话
          const failMsg = toolErrorMsg(tc.id, errMsg);
          this.messages.push(failMsg);
          void this.persist(crew, failMsg);
          continue;
        }
        if (this.aborted || r === undefined) {
          cb.onCard({ ...card, status: 'failed', result: '已终止', ok: false });
          cb.onDone('（已终止）');
          return;
        }

        // diff 卡片：write 成功时产出
        if (tc.name === 'write' && r.ok) {
          // sidecar 返回 path；diff 从快照对比生成（M2 简化：写入成功即出卡）
          cb.onCard({
            id: `diff-${card.id}`,
            type: 'diff',
            status: 'approved',
            createdAt: Date.now(),
            path: String((params as { path?: { path?: string } } | { path?: string })?.['path'] ?? ''),
            hunks: `[patch applied] ${JSON.stringify(params).slice(0, 500)}`,
            additions: 0,
            deletions: 0,
            snapshotId: String((r.data as Record<string, unknown>)?.['snapshotId'] ?? ''),
          });
        }

        cb.onCard({
          ...card,
          status: r.ok ? 'done' : 'failed',
          result: summarizeResult(r),
          ok: r.ok,
          cacheRef: r.cacheRef,
        });

        // 工具结果回注模型（截断保护：工具输出最长 8000 字符）
        // 失败时把 error.message 提到顶层，模型更容易直接读到该做什么
        const payload: Record<string, unknown> = r.ok
          ? { ok: true, data: r.data, truncated: r.truncated, cacheRef: r.cacheRef }
          : { ok: false, error: r.error?.message ?? 'unknown error', code: r.error?.code };
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(payload).slice(0, 8000),
        };
        this.messages.push(toolMsg);
        void this.persist(crew, toolMsg);
      }
    }
  }

  /** 会话持久化：经 sidecar msg.append（roleId 绑定校验，隔离在 sidecar 强制） */
  private persist(crew: CrewRunContext | undefined, msg: ChatMessage, usage?: { promptTokens: number; completionTokens: number }): void {
    const sessionId = crew?.sessionId ?? this.mainSessionId;
    const roleId = crew?.role ?? 'main';
    if (!sessionId) return;
    const roleForDb = msg.role === 'system' ? 'system' : msg.role;
    void this.sidecar
      .call('msg.append', {
        sessionId,
        roleId,
        role: roleForDb,
        content: typeof msg.content === 'string' ? msg.content : msg.content == null ? '' : JSON.stringify(msg.content),
        toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : undefined,
        toolCallId: (msg as { tool_call_id?: string }).tool_call_id,
        usagePrompt: usage?.promptTokens ?? 0,
        usageCompletion: usage?.completionTokens ?? 0,
      })
      .catch(() => undefined);
  }

  /** 主对话会话（kind=main）：设置后主对话消息按 roleId=main 持久化 */
  attachMainSession(sessionId: string): void {
    // 首次绑定的会话视为「主对话」原点：后续 chatNew 换会话后，左栏仍可回切到它
    if (!this.originalSessionId) this.originalSessionId = sessionId;
    this.mainSessionId = sessionId;
  }

  /** 启动时创建的原始主对话会话 id（左栏「主对话」回切用） */
  getMainSessionId(): string | null {
    return this.originalSessionId;
  }

  /** 当前绑定的会话 id（chatNew/chatSwitch 会改变它；用于判断「删的是不是当前会话」） */
  getActiveSessionId(): string | null {
    return this.mainSessionId;
  }

  /**
   * 删除会话后的回退：解绑当前会话，并把活跃会话指回主对话原点。
   * 回退到原点后，后续消息会写回原点会话（而不是已删除的 sessionId）。
   */
  detachAndReturnToOrigin(deletedId: string): void {
    if (this.mainSessionId === deletedId) this.mainSessionId = null;
    if (this.originalSessionId === deletedId) {
      // 被删的恰好是原点会话：主对话失去落点，置空让上层重建/降级
      this.originalSessionId = null;
    } else if (this.originalSessionId) {
      this.mainSessionId = this.originalSessionId;
    }
  }

  private mainSessionId: string | null = null;
  private originalSessionId: string | null = null;
}

function summarizeResult(r: unknown): string {
  try {
    const s = JSON.stringify(r);
    return s.length > 800 ? s.slice(0, 800) + '…' : s;
  } catch {
    return '[result]';
  }
}

/**
 * 解析模型产出的 tool_call.arguments，带常见坏形态自修复：
 *  1. markdown 代码围栏包裹（```json ... ```）
 *  2. JSON 前混入说明文字（剥到第一个 { 或 [）
 *  3. 尾逗号（[1,2,] / {"a":1,}）
 *  4. **单引号包裹的 key/value**（弱模型最常见的非法 JSON 形态）
 *  5. **截断未闭合**（流式被截断 / 模型少写 `}`、`]`）——按括号栈补齐后缀
 * 全部失败时抛错（附原文摘要），由调用方回注模型自纠。
 */
export function parseToolArgs(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  const attempts: string[] = [s];
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced?.[1] && fenced[1].trim()) attempts.push(fenced[1].trim());
  const brace = s.search(/[{[]/);
  if (brace > 0) attempts.push(s.slice(brace));
  // 先做保守形态（尾逗号）与激进形态（单引号 / 截断补齐）分两轮，
  // 保证「本来合法、只是带尾逗号」的输入不会被单引号改写污染。
  for (const a of attempts) {
    const variants = [a, a.replace(/,(\s*[}\]])/g, '$1')];
    for (const v of variants) {
      try {
        return JSON.parse(v);
      } catch {
        /* 尝试下一种形态 */
      }
    }
  }
  // 第二轮：激进修复（仅在保守形态全失败后才尝试，降低误改合法数据风险）
  for (const a of attempts) {
    const relaxed = relaxJson(a);
    if (relaxed) {
      try {
        return JSON.parse(relaxed);
      } catch {
        /* 继续 */
      }
    }
  }
  throw new Error(
    `工具参数不是合法 JSON，无法解析（原文前 200 字：${raw.slice(0, 200)}）。` +
      '请检查 arguments 的 JSON 语法（键与字符串必须用双引号、逗号分隔、括号闭合）后重新调用本工具。'
  );
}

/**
 * 激进 JSON 放宽（仅在标准 parse 全失败时调用）：
 *  - 把作为**键**出现的单引号串改为双引号（'key': → "key":）
 *  - 补齐缺失的 `}` / `]`（按栈计数），并去掉尾部悬挂逗号
 * 修复后仍必须是「对象或数组」才返回，否则返回 null 放弃。
 */
function relaxJson(src: string): string | null {
  let out = src;
  // 把**不在双引号字符串内**的单引号串改为双引号串（键与值都覆盖）。
  // 逐字符扫描，避免误改双引号字符串里的合法单引号内容。
  out = convertSingleQuotedStrings(out);
  // 去掉尾部悬挂逗号
  out = out.replace(/,(\s*[}\]])\s*$/g, '$1');
  // 括号栈补齐
  const stack: string[] = [];
  let inStr: string | null = null;
  let esc = false;
  for (const ch of out) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"') inStr = '"';
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) out += '"';
  while (stack.length > 0) out += stack.pop();
  // 只接受对象/数组结果
  const t = out.trim();
  return t.startsWith('{') || t.startsWith('[') ? out : null;
}

/**
 * 把不在双引号字符串内的单引号串改写为双引号串（弱模型最常见的非法 JSON 形态）。
 * 逐字符状态机：进入 `'...'` 后把内部的双引号转义为 `\"`，整体换成双引号包裹。
 */
function convertSingleQuotedStrings(src: string): string {
  let out = '';
  let i = 0;
  let inDouble = false;
  let inSingle = false;
  let esc = false;
  while (i < src.length) {
    const ch = src[i] as string;
    if (esc) {
      out += ch;
      esc = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        out += '"';
        inSingle = false;
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
    } else if (ch === "'") {
      inSingle = true;
      out += '"';
    } else {
      out += ch;
    }
    i++;
  }
  // 未闭合的单引号串：补一个收尾双引号
  if (inSingle) out += '"';
  return out;
}

/**
 * 校验工具参数是否满足 schema 的 required 字段。
 *  - 满足 → 原样返回 `{ params }`；
 *  - 可用「安全兜底」修复 → 返回修复后的 `{ params, note }`；
 *  - 无法安全修复 → 返回 `{ error }`，文案带「缺什么 + 正确形状」，让模型一次改对。
 *
 * 唯一兜底：`write` 且 `create===true`、只给了 `path`（无 edits）—— 模型意图明确是
 * 「新建（空）文件」，补一个空 edits 即可。**绝不**在 create!==true 时补，避免覆盖已有文件。
 */
export function coerceToolArgs(
  spec: ToolSpec,
  params: unknown,
): { params?: unknown; note?: string; error?: string; code?: number } {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { error: `工具「${spec.name}」的参数必须是 JSON 对象。${schemaHint(spec)}`, code: -32602 };
  }
  const obj = params as Record<string, unknown>;
  const required = Array.isArray((spec.parameters as { required?: unknown }).required)
    ? ((spec.parameters as { required: string[] }).required as string[])
    : [];
  const missing = required.filter((k) => obj[k] === undefined);

  if (missing.length === 0) return { params };

  // write 专项兜底：新建空文件
  if (spec.name === 'write' && missing.length === 1 && missing[0] === 'edits' && obj['create'] === true) {
    return {
      params: { ...obj, edits: [{ newText: '' }] },
      note: '你只给了 path+create 未给 edits，已按「新建空文件」处理。如需写入内容请带 edits 重写。',
    };
  }

  return {
    error: `工具「${spec.name}」缺少必填参数：[${missing.join(', ')}]。${schemaHint(spec)}`,
    code: -32602,
  };
}

/** 依据 schema 生成「必填项 + 字段说明 + 最小示例」的简短自纠提示 */
function schemaHint(spec: ToolSpec): string {
  const schema = spec.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string; description?: string }>;
  };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties ?? {};
  const lines = required.map((k) => {
    const p = props[k] ?? {};
    return `  - ${k} (${p.type ?? 'any'})${p.description ? `：${p.description}` : ''}`;
  });
  const example: Record<string, unknown> = {};
  for (const k of required) {
    const t = props[k]?.type;
    example[k] = t === 'array' ? [] : t === 'boolean' ? true : t === 'number' ? 0 : '';
  }
  return (
    `必填：[\n${lines.join('\n')}\n]。` +
    `正确形状示例：${spec.name}(${JSON.stringify(example)})。禁止原样重发，请补齐后重新调用。`
  );
}

/**
 * 发送前的历史清洗：把 assistant.tool_calls[].arguments 里非法的 JSON 重写为合法值。
 *
 * 为什么必须在发送前做：只要有一轮模型产出的 arguments 是坏 JSON，它就会被
 * push 进 this.messages 并长期驻留；此后**每一轮**请求都会带上它，OpenAI 兼容接口
 * 直接返回 400（"Assistant tool call arguments must be valid JSON"），整轮对话中断。
 *
 * 处理原则：
 *  - 返回**浅拷贝**的消息数组，不改 this.messages 本体（保留原文供排查）；
 *  - 坏参数替换为合法占位 `{"__invalid_arguments__":"<原文前 200 字>"}`，
 *    而不是删掉整条 tool_call —— 否则会留下没有前置 tool_calls 的孤立 role='tool'
 *    消息，触发另一种 400；
 *  - assistant 带 tool_calls 时 content 必须为 null（OpenAI 兼容要求）。
 */
export function sanitizeOutgoingMessages(messages: ChatMessage[]): ChatMessage[] {
  let fixed = 0;
  const out = messages.map((m) => {
    const tcs = (m as { tool_calls?: Array<{ function?: { arguments?: string } }> }).tool_calls;
    if (m.role !== 'assistant' || !Array.isArray(tcs) || tcs.length === 0) return m;
    const cleanCalls = tcs.map((tc) => {
      const raw = tc.function?.arguments;
      if (typeof raw === 'string' && !isParseableObject(raw)) {
        fixed++;
        return {
          ...tc,
          function: {
            ...(tc.function ?? {}),
            arguments: JSON.stringify({ __invalid_arguments__: raw.slice(0, 200) }),
          },
        };
      }
      return tc;
    });
    // content：带 tool_calls 时置 null（空串也会被严格接口拒绝）
    const content = m.content === '' ? null : m.content;
    return { ...m, content, tool_calls: cleanCalls } as ChatMessage;
  });
  if (fixed > 0) logger.warn('sanitized invalid tool_calls arguments', { count: fixed });
  return out;
}

/** 判断字符串能否 parse 成 JSON 对象/数组（工具参数必须是这两种之一） */
function isParseableObject(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  try {
    const v = JSON.parse(s) as unknown;
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

/**
 * 构造「工具执行失败」回注消息。
 *
 * 统一错误信封形状：{ ok:false, error:"<可读说明>", code? }。
 * 此前三条失败路径形状不一致（解析失败/工具抛错走 error.message 嵌套，
 * 工具返回业务错误走扁平 error），模型时而读到字符串、时而读到对象，
 * 削弱了自纠能力。这里收敛为单一形状，便于模型稳定解析。
 */
function toolErrorMsg(toolCallId: string, message: string, code?: number): ChatMessage {
  const payload: Record<string, unknown> = { ok: false, error: message };
  if (code !== undefined) payload.code = code;
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(payload).slice(0, 8000),
  };
}

function buildSystemPrompt(mode: TaskMode, toolNames: string[]): string {
  const base = `你是 Codara 极简长编码模式的执行 Agent。

运行环境（据此自主选定 shell，无需询问用户）：
- 目标平台：Windows 7 SP1+ x64（终端由 sidecar 托管，按你标注的 shell 启动对应解释器）
- 可用 shell：CMD（cmd.exe，系统自带，最稳）、Windows PowerShell（powershell.exe，Win7 自带 2.0+）、Bash（若环境存在 git-bash/WSL；不存在时会执行失败，注意回退）
- 选择建议：文件/目录操作与 .bat 用 CMD；需要对象管道、正则、JSON 处理用 PowerShell；跨平台脚本或已有 .sh 用 Bash
- 工作区根目录由系统注入，所有相对路径都相对它解析

铁律：
4. Shell 自由选择：命令内容不受任何限制或改写——不设违禁词、不禁链式（&& / || / ;）、不要求特定前缀。由你自主决定用哪种 shell（CMD / Bash / PowerShell），并在命令开头用括号标注所选 shell，例如 \`(PowerShell) Get-ChildItem -Force\`、\`(CMD) dir /b\`、\`(Bash) ls -la\`。标注纯属声明，便于审查卡展示，不会被改写或校验。
5. 人工审查是唯一防线：**所有命令与写操作都会弹审批卡**，由用户决定是否执行。高危命令（删除、格式化、注册表、提权、关机等）会以高风险样式标出，但同样走普通审查卡、不额外拦截。请在发起工具调用前用一句话说明你要做什么、为什么；被拒绝时不要重试同一条命令，改成询问用户或换方案。
6. 工具极简：只拥有 ${toolNames.join(' / ')}。不存在的工具视为不可用，禁止用 shell 模拟其他能力。
7. 先搜后读，先读后写：定位用 search，内容用 read（指定行范围），改动用 write（补丁），验证用 terminal。禁止盲读大文件、禁止无搜索直接改。
8. 最小编辑：只改任务要求的最小范围。禁止顺手重构、格式化、补注释、改无关代码。
9. Token 纪律：思考只包含"目标→行动→参数"。回复只包含"结论+证据+下一步"。
10. 失败纪律：同一命令连续失败 2 次，停止重试，输出根因分析，请求人类裁决。
11. 预算纪律：单任务有轮次与 token 上限，超限自动挂起。
12. 证据纪律：一切结论以退出码、文件:行号、真实输出为准。禁止编造工具输出。
13. 长会话纪律：不重复读取已读内容；重复读返回缓存引用。

工具返回统一信封 {ok, data, error, truncated, cacheRef}。write 为唯一写通道：**path 与 edits 都是必填**，缺任一即失败。编辑用 oldText/newText 精确替换；新建文件必须 create=true（此时只用 newText 拼接内容，不要给 oldText）；修改已有文件必须 create=false 并传入 read 得到的 baselineHash。

工具参数纪律（违反会直接失败，且系统会原样返回你的参数键名）：
- 调用前自查必填参数：write 必须同时给 **path** 与 **edits**；terminal 必须给 command；read/search 必须给 path/pattern。
- write 正确示例：{"path":"snake.html","create":true,"edits":[{"newText":"<!DOCTYPE html>..."}]}
- write 错误示例：{"create":true,"edits":[...]}  ← 缺 path，会被拒绝
- 收到 INVALID_PARAMS 或「缺少必填参数」时，**禁止原样重发**：补齐缺失字段后再调用。
- 工具失败不会终止会话，错误信封会回注给你；据此修正参数重试，或换一条路径，或如实向用户说明卡点。`;

  if (mode === 'ask') {
    return (
      base +
      '\n\n当前任务模式：Ask（极简直干）。少工具集（read / search / write / terminal）：直接读码、搜码、改码、跑命令验证，一气呵成，无需先出计划；写文件与每条终端命令都会弹审批卡，批准即执行，不会被二次拦截。'
    );
  }
  if (mode === 'plan') {
    return base + '\n\n当前任务模式：Plan。先探查定位，改动前输出分步计划（每步含验证方式），获得批准后执行。';
  }
  return base + '\n\n当前任务模式：Goal。给定目标后挂机自驱直到达成或卡点；每个关键动作仍走审批卡，高危动作无论是否预授权都必人工点批准。';
}
