// M4: Goal 预授权网关单测（规格 4.7）
// 预授权 = 用户三项勾选后的减摩擦层；高危操作无条件升级人工审批；「停」即关闭。
// sidecar 以桩替换（网关仅调用 audit.note 做审计，失败静默）。
import { describe, expect, it } from 'vitest';

import { ApprovalGateway } from '../../electron/src/tools/gateway';

interface Recorded {
  tool: string;
  risk: string;
}

function makeGateway(approved: boolean): { gw: ApprovalGateway; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const gw = new ApprovalGateway({
    call: async () => ({ ok: true, data: {} }),
  } as never);
  gw.onApproval(async (card) => {
    requests.push({ tool: String((card as { payload?: { tool?: string } }).payload ?? ''), risk: card.risk });
    return approved;
  });
  return { gw, requests };
}

describe('M4: Goal 预授权网关', () => {
  it('未预授权时 write 走审批卡', async () => {
    const { gw, requests } = makeGateway(true);
    const r = await gw.check('write', { path: 'a.txt' }, 'goal');
    expect(requests.length).toBe(1);
    expect(r.allowed).toBe(true);
    expect(r.approvalToken).toBeTruthy();
  });

  it('预授权开启：goal 模式下非高危（write/普通命令）自动放行', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);
    expect(gw.isGoalPreAuthorized()).toBe(true);

    const w = await gw.check('write', { path: 'src/a.txt' }, 'goal');
    expect(w.allowed).toBe(true);
    expect(requests.length).toBe(0); // 无审批卡

    const t = await gw.check('terminal', { command: 'node -v' }, 'goal');
    expect(t.allowed).toBe(true);
    expect(requests.length).toBe(0);
  });

  it('预授权开启：高危命令仍必人工审批（rm -rf / reg / revert）', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);

    const rmrf = await gw.check('terminal', { command: 'rm -rf /tmp/x' }, 'goal');
    expect(requests.length).toBe(1); // 弹卡而非放行
    expect(rmrf.allowed).toBe(true); // 用户批准后放行
    expect(rmrf.approvalToken).toBeTruthy();

    const reg = await gw.check('terminal', { command: 'reg add HKLM\\Software /v x' }, 'goal');
    expect(requests.length).toBe(2);

    const revert = await gw.check('git', { op: 'revert' }, 'goal');
    expect(requests.length).toBe(3);
    expect(revert.allowed).toBe(true);
  });

  it('预授权仅作用于 goal 模式：plan 模式照常弹卡', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);
    const r = await gw.check('write', { path: 'a.txt' }, 'plan');
    expect(requests.length).toBe(1);
    expect(r.allowed).toBe(true);
  });

  it('用户拒绝时预授权不放行（allowed=false）', async () => {
    const { gw, requests } = makeGateway(false);
    const r = await gw.check('terminal', { command: 'rm -rf /tmp/x' }, 'goal');
    expect(requests.length).toBe(1);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('user rejected');
  });

  it('deny 策略（未知工具）不受预授权影响', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);
    const r = await gw.check('web.fetch', { url: 'https://x' }, 'goal');
    expect(r.allowed).toBe(false);
    expect(requests.length).toBe(0);
  });

  it('「停」语义：setGoalPreAuthorized(false) 后回到逐次审批', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);
    await gw.check('write', { path: 'a.txt' }, 'goal');
    expect(requests.length).toBe(0);

    gw.setGoalPreAuthorized(false);
    await gw.check('write', { path: 'b.txt' }, 'goal');
    expect(requests.length).toBe(1);
  });
});
