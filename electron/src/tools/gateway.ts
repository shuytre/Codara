// 权限网关：auto/ask/deny 策略 + 高危命令识别（无条件升级审批）
// 白名单只是减摩擦层，不是安全边界（ADR-06）：
// 真正的安全边界 = 高危操作人工审批 + 快照回滚 + 全量审计。
import { ApprovalCard } from '@codara/contract';
import * as crypto from 'crypto';

import { SidecarManager } from '../sidecar/manager';

export interface GatewayDecision {
  allowed: boolean;
  reason?: string;
  approvalToken?: string;
}

const HIGH_RISK_TERMINAL: RegExp[] = [
  /\brd\b/i, /\brmdir\b/i, /\bdel\b/i, /\berase\b/i, /\bformat\b/i, /\bdiskpart\b/i,
  /\bshutdown\b/i, /\breg\s+(add|delete)\b/i, /\bregedit\b/i, /\bnet\s+user\b/i,
  /\bnetwork\s+localgroup\b/i, /\bicacls\b/i, /\btakeown\b/i, /\bbcdedit\b/i,
  /\bvssadmin\b/i, /\bschtasks\s+\/create\b/i, /\bsc\s+delete\b/i, /\btaskkill\s+\/f\b/i,
  /\brm\s+-rf\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, /\bchmod\s+777\b/i,
];

export class ApprovalGateway {
  private listeners: Array<(card: ApprovalCard) => Promise<boolean>> = [];
  private goalPreAuthorized = false;

  constructor(private readonly sidecar: SidecarManager) {}

  /** 注册审批处理器（IPC 层把审批卡推给渲染层并等待用户响应） */
  onApproval(handler: (card: ApprovalCard) => Promise<boolean>): void {
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

  async check(tool: string, params: unknown, mode: 'ask' | 'plan' | 'goal'): Promise<GatewayDecision> {
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
      approved = (await l(card)) || approved;
    }
    void this.sidecar
      .call('audit.note', { event: 'approval.result', tool, approved, approvalToken: token })
      .catch(() => undefined);
    return approved
      ? { allowed: true, approvalToken: token }
      : { allowed: false, reason: 'user rejected', approvalToken: token };
  }

  private policyFor(tool: string, params: unknown): 'auto' | 'ask' | 'deny' {
    switch (tool) {
      case 'read':
      case 'search':
        return 'auto';
      case 'index.symbols':
      case 'index.semantic':
        return 'auto'; // M5：代码索引只读查询（sidecar 侧无写通道）
      case 'write':
        return 'ask'; // 补丁写入默认 ask（规格 6.1）
      case 'git': {
        const op = (params as { op?: string })?.op;
        const readonly = ['status', 'diff', 'log', 'show', 'branch', 'worktree-list'];
        return readonly.includes(op || '') ? 'auto' : 'ask';
      }
      case 'terminal': {
        const cmd = (params as { command?: string })?.command || '';
        if (HIGH_RISK_TERMINAL.some((re) => re.test(cmd))) {
          return 'ask'; // 高危必审批
        }
        return 'ask'; // terminal 默认 ask（只读白名单 auto 在 M4 沙箱细化）
      }
      default:
        return 'deny';
    }
  }

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
