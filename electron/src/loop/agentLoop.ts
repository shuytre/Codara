// 单 Agent 主循环（M2：极简模式直连驱动；M3：同一循环驱动专家团角色实例）
// 流程：用户消息 → chatStream → tool_calls? → 工具管道 → 结果回注 → 循环；预算熔断检查
import {
  Card,
  ChatMessage,
  CrewRole,
  PlanCard,
  ToolCallCard,
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
    // 系统提示词：专家团角色用角色提示词；极简模式用三模式变体
    const systemPrompt = crew
      ? ROLE_DEFS[crew.role].systemPrompt
      : buildSystemPrompt(mode, this.tools.toolSpecs(false).map((t) => t.name));
    // M5 记忆注入（规格 4.5/4.8）：全局/项目记忆统一注入所有角色；
    // 沙箱临时技术会话跳过项目记忆正文（4.8），角色会话历史隔离不变
    const mem = loadMemory(this.settings.get('workspacePath') || undefined);
    const fullSystemPrompt = withMemory(systemPrompt, mem, { sandbox: crew?.sandbox });
    const toolSpecs = crew
      ? toolSpecsForRole(this.tools.toolSpecs(true), crew.role)
      : this.tools.toolSpecs(false);
    if (this.messages.length === 0) {
      const sysMsg: ChatMessage = { role: 'system', content: fullSystemPrompt };
      this.messages.push(sysMsg);
      void this.persist(crew, sysMsg);
    }
    const userMsg: ChatMessage = { role: 'user', content: userText };
    this.messages.push(userMsg);
    void this.persist(crew, userMsg);

    let iterations = 0;
    // 轮次上限：角色实例用角色矩阵；主对话按模式
    const maxIter = crew ? ROLE_DEFS[crew.role].maxTurns : mode === 'goal' ? 40 : 12;

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
            messages: this.messages,
            tools: mode === 'ask' ? undefined : toolSpecs,
          },
          (e) => {
            if (e.type === 'delta') cb.onDelta(e.text);
            if (e.type === 'usage') {
              const tripped = this.budget.record(e.promptTokens, e.completionTokens);
              if (tripped) {
                logger.warn('budget breaker tripped');
              }
            }
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
        let params: unknown = {};
        try {
          params = JSON.parse(tc.arguments || '{}');
        } catch {
          params = {};
        }

        // 计划卡拦截：Plan 模式下首次产出计划时请求批准（M2 行为）
        const card: ToolCallCard = {
          id: `tc-${Date.now()}-${tc.id}`,
          type: 'tool-call',
          status: 'running',
          createdAt: Date.now(),
          tool: tc.name,
          paramsSummary: JSON.stringify(params).slice(0, 300),
        };
        cb.onCard(card);

        // 可中断工具执行（含审批等待）：abort → undefined；真实失败 → 回注错误继续循环
        let r;
        try {
          r = await this.raceAbort(this.tools.execute(tc.name, params, mode, crew?.role));
        } catch (toolErr) {
          const errMsg = (toolErr as Error)?.message || String(toolErr);
          logger.warn('tool execution failed', { tool: tc.name, err: errMsg });
          cb.onCard({ ...card, status: 'failed', result: errMsg.slice(0, 800), ok: false });
          // 失败结果回注模型：由模型决定重试/换路/向用户说明，而不是终止会话
          const failMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: { message: errMsg } }).slice(0, 8000),
          };
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

function buildSystemPrompt(mode: TaskMode, toolNames: string[]): string {
  const base = `你是 Codara 极简长编码模式的执行 Agent。

铁律：
1. 工具极简：只拥有 ${toolNames.join(' / ')}。不存在的工具视为不可用，禁止用 shell 模拟其他能力。
2. 先搜后读，先读后写：定位用 search，内容用 read（指定行范围），改动用 write（补丁），验证用 terminal。禁止盲读大文件、禁止无搜索直接改。
3. 最小编辑：只改任务要求的最小范围。禁止顺手重构、格式化、补注释、改无关代码。
4. Shell 纪律：默认 cmd.exe（Windows）。禁止 && / ; 长链；管道仅限简单 findstr。
5. Token 纪律：思考只包含"目标→行动→参数"。回复只包含"结论+证据+下一步"。
6. 失败纪律：同一命令连续失败 2 次，停止重试，输出根因分析，请求人类裁决。
7. 破坏性操作：删除文件、git push、安装软件、写工作区外路径，必须先申请批准（系统会弹出审批卡）。
8. 预算纪律：单任务有轮次与 token 上限，超限自动挂起。
9. 证据纪律：一切结论以退出码、文件:行号、真实输出为准。禁止编造工具输出。
10. 长会话纪律：不重复读取已读内容；重复读返回缓存引用。

工具返回统一信封 {ok, data, error, truncated, cacheRef}。write 为唯一写通道：**path 与 edits 都是必填**，缺任一即失败。编辑用 oldText/newText 精确替换；新建文件必须 create=true（此时只用 newText 拼接内容，不要给 oldText）；修改已有文件必须 create=false 并传入 read 得到的 baselineHash。

工具参数纪律（违反会直接失败，且系统会原样返回你的参数键名）：
- 调用前自查必填参数：write 必须同时给 **path** 与 **edits**；terminal 必须给 command；read/search 必须给 path/pattern。
- write 正确示例：{"path":"snake.html","create":true,"edits":[{"newText":"<!DOCTYPE html>..."}]}
- write 错误示例：{"create":true,"edits":[...]}  ← 缺 path，会被拒绝
- 收到 INVALID_PARAMS 或「缺少必填参数」时，**禁止原样重发**：补齐缺失字段后再调用。
- 工具失败不会终止会话，错误信封会回注给你；据此修正参数重试，或换一条路径，或如实向用户说明卡点。`;

  if (mode === 'ask') {
    return base + '\n\n当前任务模式：Ask。只回答问题，不要调用写类工具。';
  }
  if (mode === 'plan') {
    return base + '\n\n当前任务模式：Plan。先探查定位，改动前输出分步计划（每步含验证方式），获得批准后执行。';
  }
  return base + '\n\n当前任务模式：Goal。给定目标后挂机自驱直到达成或卡点；每个关键动作仍走审批卡。';
}
