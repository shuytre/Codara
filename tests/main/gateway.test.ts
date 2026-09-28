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

// ---------------------------------------------------------------- 人工审查中间层（2026-09-28 口径）
//
// sidecar 已不再对命令内容做任何过滤/改写（cmd_rules 只保留空命令与长度上限两条
// 工程保护）。安全职责全部由本网关承担，且**审查环节强制保留**：
//   - 高危命令、读写类命令 → 一律人工审查；
//   - 危险命令不做额外拦截，同普通审查卡处理（仅标注 risk=high）；
//   - 只读类（read/search/索引/git 只读）→ 自动放行，不打扰用户。
describe('人工审查中间层：高危与读写类命令强制审查', () => {
  it('terminal 一律审查（含只读命令，不再有内容白名单）', async () => {
    for (const cmd of [
      'dir',
      'Get-ChildItem -Force | Select-Object Name',
      'echo hi',
      'rm -rf /tmp/x',
      'format C: /q',
    ]) {
      const { gw, requests } = makeGateway(true);
      const r = await gw.check('terminal', { command: cmd }, 'plan');
      expect(requests.length, `\`${cmd}\` 必须进入人工审查`).toBe(1);
      expect(r.allowed).toBe(true);
    }
  });

  it('高危命令不额外拦截：同一张普通审查卡，仅标注 risk=high', async () => {
    const { gw, requests } = makeGateway(true);
    const r = await gw.check('terminal', { command: 'format C: /q' }, 'plan');
    expect(requests.length).toBe(1); // 有卡
    expect(requests[0]!.risk).toBe('high'); // 标注高危
    expect(r.allowed).toBe(true); // 批准即放行，不被二次拒绝
  });

  it('读写类命令全部审查：write / git 写操作', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['write', { path: 'a.txt' }],
      ['git', { op: 'commit' }],
      ['git', { op: 'push' }],
      ['git', { op: 'checkout' }],
    ];
    for (const [tool, params] of cases) {
      const { gw, requests } = makeGateway(true);
      await gw.check(tool, params, 'plan');
      expect(requests.length, `${tool} ${JSON.stringify(params)} 必须审查`).toBe(1);
    }
  });

  it('只读类自动放行：read / search / 索引 / git 只读', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['read', { path: 'a.txt' }],
      ['search', { pattern: 'x' }],
      ['index.symbols', { query: 'x' }],
      ['index.semantic', { query: 'x' }],
      ['git', { op: 'status' }],
      ['git', { op: 'diff' }],
      ['git', { op: 'log' }],
    ];
    for (const [tool, params] of cases) {
      const { gw, requests } = makeGateway(true);
      const r = await gw.check(tool, params, 'plan');
      expect(r.allowed, `${tool} 应放行`).toBe(true);
      expect(requests.length, `${tool} 不应打扰用户`).toBe(0);
    }
  });

  it('Goal 模式下高危命令也不例外：预授权不能跳过人工审查', async () => {
    const { gw, requests } = makeGateway(true);
    gw.setGoalPreAuthorized(true);
    const r = await gw.check('terminal', { command: 'Remove-Item -Recurse -Force C:\\temp' }, 'goal');
    expect(requests.length).toBe(1); // 高危：即使预授权也必弹卡
    expect(requests[0]!.risk).toBe('high');
    expect(r.allowed).toBe(true);
  });
});
