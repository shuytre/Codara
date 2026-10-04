// 权限网关：人工审查中间层（强制保留）。
//
// ## 口径（2026-09-28 定稿）
//
// sidecar 已不再对命令内容做任何过滤/改写（见 `sidecar/src/governance/cmd_rules.rs`），
// 因此**本网关是唯一的防线，且审查环节强制保留**：
//   - 高危命令（删除/格式化/注册表/提权/计划任务等）→ 必人工审查；
//   - 读写类命令（terminal 执行、write 落盘、git 写操作）→ 必人工审查；
//   - 只读类（read / search / 索引查询 / git 只读）→ 自动放行。
//
// 危险命令**不做额外拦截**：命中高危特征只是让卡片标注 risk=high，
// 仍走同一张普通审查卡、同一套批准流程。sidecar 也不会二次拒绝 —— 用户批准即执行。
//
// Goal 预授权（规格 4.7）只能跳过**非高危**的读写类审查；高危命令在任何模式下
// 都必须人工点批准（否则「挂机自驱」会退化成无人看守的破坏性执行）。
import { ApprovalCard } from '@codara/contract';
import * as crypto from 'crypto';

import { SidecarManager } from '../sidecar/manager';

export interface GatewayDecision {
  allowed: boolean;
  reason?: string;
  approvalToken?: string;
}

/** 高危命令特征：只用于给审查卡标注 risk=high，不改变「必须人工审查」这一结论。 */
const HIGH_RISK_TERMINAL: RegExp[] = [
  /\brd\b/i, /\brmdir\b/i, /\bdel\b/i, /\berase\b/i, /\bformat\b/i, /\bdiskpart\b/i,
  /\bshutdown\b/i, /\breg\s+(add|delete)\b/i, /\bregedit\b/i, /\bnet\s+user\b/i,
  /\bnet\s+localgroup\b/i, /\bicacls\b/i, /\btakeown\b/i, /\bbcdedit\b/i,
  /\bvssadmin\b/i, /\bschtasks\s+\/create\b/i, /\bsc\s+delete\b/i, /\btaskkill\s+\/f\b/i,
  /\brm\s+-rf\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, /\bchmod\s+777\b/i,
  /\bRemove-Item\b/i, /\bClear-Disk\b/i, /\bStop-Computer\b/i, /\bSet-ExecutionPolicy\b/i,
];

export class ApprovalGateway {
  // listener 带会话 id：审批卡要投递到对应会话的渲染分区（第 6 轮并行隔离）
  private listeners: Array<(card: ApprovalCard, sessionId: string) => Promise<boolean>> = [];
  private goalPreAuthorized = false;

  constructor(private readonly sidecar: SidecarManager) {}

  /** 注册审批处理器（IPC 层把审批卡推给渲染层并等待用户响应） */
  onApproval(handler: (card: ApprovalCard, sessionId: string) => Promise<boolean>): void {
    this.listeners.push(handler);
  }

  /** Goal 预授权（规格 4.7）：用户逐项勾选确认后开启；说「停」（abort）即关闭 */
  setGoalPreAuthorized(on: boolean): void {
    this.goalPreAuthorized = on;
    void this.sidecar
      .call('audit.note', { event: on ? 'goal.preauth.on' : 'goal.preauth.off' })
      .catch(() => undefined);
  }

  isGoalPreAuthorized(): boolean {
    return this.goalPreAuthorized;
  }

  async check(
    tool: string,
    params: unknown,
    mode: 'ask' | 'plan' | 'goal',
    /**
     * 发起本次检查的会话 id（第 6 轮并行隔离）。
     * 由 ToolRuntime 在构造时注入 —— 每个会话一份 ToolRuntime，
     * 因此这里能拿到**正确**的会话，不依赖任何全局可变状态
     * （早先用单个 gatewaySessionId 变量在两个会话并发时会被后者覆盖）。
     */
    sessionId = 'main'
  ): Promise<GatewayDecision> {
    const policy = this.policyFor(tool, params);
    if (policy === 'auto') {
      return { allowed: true };
    }
    if (policy === 'deny') {
      return { allowed: false, reason: 'operation denied by policy' };
    }
    // ask：Goal 预授权范围内（非高危）自动放行；高危仍必人工审批（规格 4.7）
    if (mode === 'goal' && this.goalPreAuthorized && this.riskFor(tool, params) !== 'high') {
      void this.sidecar
        .call('audit.note', { event: 'goal.preauth.pass', tool, risk: this.riskFor(tool, params) })
        .catch(() => undefined);
      // 带上放行标记：sidecar 侧用它在执行前复核审批状态，避免「网关批准 ≠ 执行放行」
      return { allowed: true, approvalToken: 'goal-preauth' };
    }
    const token = crypto.randomUUID();
    const card: ApprovalCard = {
      id: `approval-${token.slice(0, 8)}`,
      type: 'approval',
      status: 'pending',
      createdAt: Date.now(),
      title: `批准 ${tool} 操作`,
      reason: describe(tool, params),
      risk: this.riskFor(tool, params),
      payload: params,
      approvalToken: token,
    };
    // 发审批事件给渲染层（经 sidecar 审计）
    void this.sidecar.call('audit.note', { event: 'approval.request', tool, risk: card.risk }).catch(() => undefined);
    let approved = false;
    for (const l of this.listeners) {
      approved = (await l(card, sessionId)) || approved;
    }
    void this.sidecar
      .call('audit.note', { event: 'approval.result', tool, approved, approvalToken: token })
      .catch(() => undefined);
    return approved
      ? { allowed: true, approvalToken: token }
      : { allowed: false, reason: 'user rejected', approvalToken: token };
  }

  /** 审查策略：auto = 只读自动放行；ask = 强制人工审查；deny = 无此工具。
   *  注意「高危」不产生第三种策略 —— 它也走 ask，与普通审查卡同一条路径。 */
  private policyFor(tool: string, params: unknown): 'auto' | 'ask' | 'deny' {
    switch (tool) {
      case 'read':
      case 'search':
        return 'auto'; // 纯只读
      case 'index.symbols':
      case 'index.semantic':
        return 'auto'; // M5：代码索引只读查询（sidecar 侧无写通道）
      case 'write':
        return 'ask'; // 写文件：读写类 → 强制人工审查（规格 6.1）
      case 'git': {
        const op = (params as { op?: string })?.op;
        const readonly = ['status', 'diff', 'log', 'show', 'branch', 'worktree-list'];
        return readonly.includes(op || '') ? 'auto' : 'ask'; // git 写操作 → 强制人工审查
      }
      case 'terminal':
        // 一律人工审查：sidecar 不再过滤命令内容，终端是唯一系统操作面，
        // 每条命令（含读类命令）都必须过审查卡。高危与否只影响卡片标注。
        return 'ask';
      default:
        return 'deny';
    }
  }

  /** 风险标注：仅用于审查卡醒目提示，不影响是否审查（都审）。 */
  private riskFor(tool: string, params: unknown): 'low' | 'medium' | 'high' {
    if (tool === 'terminal') {
      const cmd = (params as { command?: string })?.command || '';
      if (HIGH_RISK_TERMINAL.some((re) => re.test(cmd))) return 'high';
      return 'medium';
    }
    if (tool === 'write') return 'medium';
    if (tool === 'git') {
      const op = (params as { op?: string })?.op;
      return op === 'revert' ? 'high' : 'medium';
    }
    return 'low';
  }
}

function describe(tool: string, params: unknown): string {
  if (tool === 'terminal') return `执行命令：${(params as { command?: string })?.command || ''}`;
  if (tool === 'write') return `写入文件：${(params as { path?: string })?.path || ''}`;
  if (tool === 'git') return `git ${(params as { op?: string })?.op || ''}`;
  return JSON.stringify(params).slice(0, 200);
}
