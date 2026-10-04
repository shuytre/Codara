// 会话运行时注册表：按 sessionId 隔离 AgentLoop / 预算 / 审批等待表。
//
// 背景（第 6 轮修复）：此前主对话只有**一个** AgentLoop 全局单例，
// messages / aborted / runAbort / abortWaiters / approvalWaiters 全部共享。
// 于是 chatNew / chatSwitch / chatDelete 三个 handler 只能无条件
// loop.abort() + loop.reset() —— 用户在主任务执行中点「+ 新建对话」或
// 切到别的会话，主任务会被当场掐断（用户反馈：主任务「突然转到你那个其他
// 的会话，然后快速停止」），右栏工具流水也被一起清空。
//
// 隔离方案照搬 crew/scheduler.ts 里「每个专家团实例一个独立 AgentLoop」的
// 既有先例：一个会话一个 AgentLoop + 一份 BudgetLedger + 一份审批等待表。
// 这样切换会话只是切换「当前渲染哪个分区」，不再触碰其它会话的运行态。
//
// 生命周期：runtime 按 sessionId 懒创建；删除会话时 drop（连带 abort 该会话，
// 释放其审批等待），其余会话不受影响。已完成的 runtime 一并回收，避免
// 长时间运行后 Map 无界增长。

import { AgentLoop } from './agentLoop';
import { BudgetLedger } from '../budget/ledger';
import { ModelClient } from '../model/client';
import { SidecarManager } from '../sidecar/manager';
import { SettingsStore } from '../config/settingsStore';
import { ToolRuntime } from '../tools/runtime';
import { ApprovalGateway } from '../tools/gateway';

export interface SessionRuntimeDeps {
  model: ModelClient;
  sidecar: SidecarManager;
  settings: SettingsStore;
  scheduler: ConstructorParameters<typeof ToolRuntime>[4];
  gateway: ApprovalGateway;
}

export interface SessionRuntime {
  readonly sessionId: string;
  readonly loop: AgentLoop;
  readonly budget: BudgetLedger;
  /** 本会话挂起的审批等待（token -> resolve）。仅 abort 本会话时结算。 */
  readonly approvals: Map<string, (approved: boolean) => void>;
  /** 最近一次活动时间（ms），用于回收空闲 runtime。 */
  lastUsedAt: number;
}

export class SessionRegistry {
  private readonly map = new Map<string, SessionRuntime>();
  private readonly deps: SessionRuntimeDeps;
  /**
   * 启动时创建的主对话原点会话。左栏「主对话」回切、以及 payload 缺省
   * sessionId 时的回落目标都指向它。
   */
  private originId: string | null = null;

  constructor(deps: SessionRuntimeDeps) {
    this.deps = deps;
  }

  /** 记录启动原点会话（main.ts 创建主对话后调用一次）。 */
  setOrigin(sessionId: string): void {
    this.originId = sessionId;
    this.acquire(sessionId);
  }

  /** 启动原点会话 id（可能为 null：sidecar 启动失败降级模式）。 */
  origin(): string | null {
    return this.originId;
  }

  /** 取（不存在则创建）指定会话的 runtime。 */
  acquire(sessionId: string): SessionRuntime {
    const existing = this.map.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const budget = new BudgetLedger(this.deps.sidecar, this.deps.settings);
    // 每个会话一份 ToolRuntime：ToolRuntime 构造时按 budget 引用注入，
    // 而 budget 决定 tickTurn 记到哪个会话的账 —— 必须一_session_一实例。
    // 第 6 轮：sessionId 一并注入 —— 审批卡要按会话投递到渲染层对应分区，
    // 若靠外部可变全局变量传递，两个会话并发时会被后启动者覆盖导致审批串台。
    const tools = new ToolRuntime(
      this.deps.sidecar,
      budget,
      this.deps.gateway,
      this.deps.settings,
      this.deps.scheduler,
      sessionId
    );
    const loop = new AgentLoop(this.deps.model, this.deps.sidecar, this.deps.settings, budget, tools);
    loop.attachMainSession(sessionId);
    const rt: SessionRuntime = {
      sessionId,
      loop,
      budget,
      approvals: new Map(),
      lastUsedAt: Date.now(),
    };
    this.map.set(sessionId, rt);
    return rt;
  }

  peek(sessionId: string): SessionRuntime | undefined {
    return this.map.get(sessionId);
  }

  /** 该会话是否正在跑任务（渲染层左栏标「运行中」圆点）。 */
  isRunning(sessionId: string): boolean {
    return this.map.get(sessionId)?.loop.isRunning() ?? false;
  }

  /** 当前已知的全部会话 id（供渲染层左栏标注「正在运行」）。 */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /**
   * 汇总所有会话的预算快照（设置页/顶栏展示用）。
   * 单会话时代等价于原全局 ledger；多会话并行后必须相加，否则用户看到
   * 「跑了两条任务，消耗却只有一条」。
   */
  totalUsage(): {
    task: { promptTokens: number; completionTokens: number; costCNY: number };
    turns: number;
    suspended: boolean;
  } {
    let promptTokens = 0;
    let completionTokens = 0;
    let costCNY = 0;
    let turns = 0;
    let suspended = false;
    for (const rt of this.map.values()) {
      const s = rt.budget.snapshot();
      promptTokens += s.task.promptTokens;
      completionTokens += s.task.completionTokens;
      costCNY += s.task.costCNY;
      turns += s.turns;
      suspended = suspended || s.suspended;
    }
    return { task: { promptTokens, completionTokens, costCNY }, turns, suspended };
  }

  /**
   * 删除会话：只终止**该**会话的运行，释放其审批等待，其余会话照常跑。
   * 返回是否确实存在并已终止。
   */
  drop(sessionId: string): boolean {
    const rt = this.map.get(sessionId);
    if (!rt) return false;
    try {
      rt.loop.abort();
    } catch {
      // loop 已结束：忽略，清理照常进行
    }
    for (const [token, resolve] of rt.approvals) {
      rt.approvals.delete(token);
      try {
        resolve(false);
      } catch {
        // 等待点可能已随 abort 结算，重复结算无害
      }
    }
    this.map.delete(sessionId);
    // 原点会话被删：置空让上层重建/降级（与旧 detachAndReturnToOrigin 语义一致）
    if (this.originId === sessionId) this.originId = null;
    return true;
  }

  /** 仅 abort 指定会话（用户点「停」），不动其它会话。 */
  abort(sessionId: string): boolean {
    const rt = this.map.get(sessionId);
    if (!rt) return false;
    rt.loop.abort();
    for (const [token, resolve] of rt.approvals) {
      rt.approvals.delete(token);
      try {
        resolve(false);
      } catch {
        // 同上
      }
    }
    return true;
  }

  /** 回收闲置超过 ttlMs 的 runtime（已完成、短期不会再切回的会话）。 */
  gc(ttlMs = 10 * 60_000): number {
    const now = Date.now();
    let n = 0;
    for (const [id, rt] of [...this.map]) {
      // 正在挂起审批的会话绝不回收：用户可能随时回来批准
      if (rt.approvals.size > 0) continue;
      if (now - rt.lastUsedAt > ttlMs) {
        this.drop(id);
        n += 1;
      }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }
}
