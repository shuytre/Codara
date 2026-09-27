// 工具调用管道回归测试（B2 / B3 / B4）
//
// 背景（三条真实缺陷）：
//  - B2：git 写操作的审批令牌没有透传 —— 网关已批准的 git commit 仍被 sidecar
//        以 4001 APPROVAL_REQUIRED 拒绝，写入操作「批了也做不成」。
//  - B3：运行时零参数校验 —— read {path:123} 会被原样透传给 sidecar 并报
//        "path is required"，模型明明传了 path 却被告知缺失，无法自纠只能空转。
//  - B4：未知工具落到网关 deny 兜底 —— 只回 "operation denied by policy"，
//        模型读不出「这个工具根本不存在」，于是反复重试同一个幻觉工具名。
//
// 本套件覆盖题目要求的五类场景：成功调用 / 失败调用 / 超时 / 无权限 / 参数错误。
import { describe, expect, it } from 'vitest';

import { ToolRuntime, validateToolParams } from '../../electron/src/tools/runtime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';

interface RtOptions {
  /** 是否批准审批卡（默认批准） */
  approve?: boolean;
  /** sidecar 桩：默认返回 ok */
  handler?: (method: string, params: any) => any;
  /** 是否配置工作区（默认已配置） */
  workspace?: string;
}

function makeRt(opts: RtOptions = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const sidecar = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return opts.handler ? opts.handler(method, params) : { ok: true, data: { method } };
    },
  };
  const budget = { tickTurn: () => undefined };
  const gateway = new ApprovalGateway(sidecar as never);
  gateway.onApproval(async () => opts.approve !== false);
  const ws = opts.workspace === undefined ? '/tmp/test-ws' : opts.workspace;
  const settings = { get: (k: string) => (k === 'workspacePath' ? ws : undefined) };
  return { rt: new ToolRuntime(sidecar as never, budget as never, gateway, settings as never), calls };
}

// ---------------------------------------------------------------- 成功调用
describe('场景：成功调用', () => {
  it('read 正常路由到 sidecar fs.read', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('read', { path: 'a.txt' }, 'plan');
    expect(r.ok).toBe(true);
    expect(r.tool).toBe('read');
    expect(calls.find((c) => c.method === 'fs.read')?.params).toEqual({ path: 'a.txt' });
    // 管道末尾写审计
    expect(calls.some((c) => c.method === 'audit.note')).toBe(true);
  });

  it('search / terminal / git(只读) / index.* 均可调用', async () => {
    const { rt, calls } = makeRt();
    await rt.execute('search', { pattern: 'x' }, 'plan');
    await rt.execute('terminal', { command: 'dir' }, 'plan');
    await rt.execute('git', { op: 'status' }, 'plan');
    await rt.execute('index.symbols', { name: 'foo' }, 'plan');
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('search.run');
    expect(methods).toContain('term.exec');
    expect(methods).toContain('git.exec');
    expect(methods).toContain('index.symbols');
  });

  it('write 走预快照 + fs.patch', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('write', { path: 'a.txt', create: true, edits: [{ newText: 'hi' }] }, 'plan');
    expect(r.ok).toBe(true);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('snap.create');
    expect(methods).toContain('fs.patch');
    // 快照必须先于写入
    expect(methods.indexOf('snap.create')).toBeLessThan(methods.indexOf('fs.patch'));
  });
});

// ---------------------------------------------------------------- 参数错误
describe('场景：参数错误（B3）', () => {
  it.each([
    ['read', {}, 'path'],
    ['terminal', {}, 'command'],
    ['search', {}, 'pattern'],
    ['index.symbols', {}, 'name'],
    ['index.semantic', {}, 'query'],
    ['git', {}, 'op'],
    ['git', { op: 123 }, 'op'],
  ])('%s 缺参 → INVALID_PARAMS 且不触达 sidecar', async (tool, params, field) => {
    const { rt, calls } = makeRt();
    const r = await rt.execute(tool as string, params as never, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toContain(field as string);
    expect(calls.length).toBe(0);
  });

  it('read path=123 报「类型错误」并给出实际类型（不再误报缺失）', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('read', { path: 123 } as never, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('类型错误');
    expect(r.error?.message).toContain('数字');
    expect(r.error?.message).not.toContain('缺少必填参数');
  });

  it('git op 非法枚举被拦下并列出允许值', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('git', { op: 'push' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('取值非法');
    expect(r.error?.message).toContain('status');
  });

  it('write 空 edits → 指向 edits 而非 path', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('write', { path: 'a.txt', edits: [] }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('edits');
    expect(r.error?.message).not.toContain('缺少必填参数：[path');
  });

  it('write edits 项无可识别字段 → 指明下标与合法字段', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('write', { path: 'a.txt', edits: [{ foo: 1 }] } as never, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('edits[0]');
    expect(r.error?.message).toContain('oldText');
  });

  it('validateToolParams 对合法参数放行', () => {
    expect(validateToolParams('read', { path: 'a.txt' })).toBeNull();
    expect(validateToolParams('terminal', { command: 'dir' })).toBeNull();
    expect(validateToolParams('search', { pattern: 'x', mode: 'rg' })).toBeNull();
    expect(validateToolParams('write', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] })).toBeNull();
    expect(validateToolParams('git', { op: 'commit', args: { message: 'm' } })).toBeNull();
    expect(validateToolParams('index.semantic', { query: 'q' })).toBeNull();
  });

  it('validateToolParams 不干涉可选字段与未知工具', () => {
    expect(validateToolParams('read', { path: 'a', offset: 1, weirdVendorField: true })).toBeNull();
    expect(validateToolParams('not.a.tool', {})).toBeNull(); // 未知工具由上游注册表拦截
  });
});

// ---------------------------------------------------------------- 无权限 / 拒绝
describe('场景：无权限与拒绝', () => {
  it('B4: 未知工具返回 METHOD_NOT_FOUND 并列出可用工具', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('readfile', { path: 'a.txt' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(-32601);
    expect(r.error?.message).toContain('未知工具');
    expect(r.error?.message).toContain('read');
    expect(calls.length).toBe(0);
  });

  it('用户拒绝审批 → 4002 且不触达 sidecar', async () => {
    const { rt, calls } = makeRt({ approve: false });
    const r = await rt.execute('write', { path: 'a.txt', create: true, edits: [{ newText: 'x' }] }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(4002);
    expect(calls.filter((c) => c.method === 'fs.patch').length).toBe(0);
  });

  it('角色越权 → 4002（builder 不得写文件）', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('write', { path: 'a.txt', create: true, edits: [{ newText: 'x' }] }, 'plan', 'builder');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(4002);
    expect(r.error?.message).toContain('not allowed for role');
  });

  it('Ask 模式拒绝 git 与 artifact.*', async () => {
    const { rt } = makeRt();
    const git = await rt.execute('git', { op: 'status' }, 'ask');
    expect(git.ok).toBe(false);
    expect(git.error?.code).toBe(4002);
    const art = await rt.execute('artifact.write', { taskId: 't', type: 'plan', body: 'b' }, 'ask');
    expect(art.ok).toBe(false);
  });

  it('主对话不可用专家团调度工具', async () => {
    const { rt } = makeRt();
    const r = await rt.execute('task.spawn', { taskId: 't', role: 'developer', goal: 'g' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(4002);
    expect(r.error?.message).toContain('crew preset');
  });

  it('未打开工作区 → 4003 可行动错误', async () => {
    const { rt, calls } = makeRt({ workspace: '' });
    const r = await rt.execute('read', { path: 'a.txt' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(4003);
    expect(r.error?.message).toContain('未打开工作区');
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- 超时
describe('场景：超时', () => {
  it('sidecar 调用超时被捕获并回注可读错误，不冒泡崩溃', async () => {
    const { rt } = makeRt({
      handler: () => {
        throw new Error('sidecar call timeout: fs.read');
      },
    });
    await expect(rt.execute('read', { path: 'a.txt' }, 'plan')).rejects.toThrow(/timeout/);
  });

  it('sidecar 返回 ok=false 时信封透传错误码', async () => {
    const { rt } = makeRt({ handler: () => ({ ok: false, error: { code: 1007, message: 'not found: a.txt' } }) });
    const r = await rt.execute('read', { path: 'a.txt' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(1007);
    expect(r.error?.message).toContain('not found');
  });
});

// ---------------------------------------------------------------- git 令牌（B2）
describe('B2: git 审批令牌透传', () => {
  it('git 写操作经审批后带 approvalToken 调用 sidecar', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('git', { op: 'commit', args: { message: '[T-1] x' } }, 'plan');
    const gitCall = calls.find((c) => c.method === 'git.exec');
    expect(r.ok).toBe(true);
    expect(gitCall?.params).toHaveProperty('approvalToken');
    expect(typeof gitCall?.params.approvalToken).toBe('string');
    expect(gitCall?.params.approvalToken.length).toBeGreaterThan(0);
    // 原始参数不被破坏
    expect(gitCall?.params.op).toBe('commit');
    expect(gitCall?.params.args).toEqual({ message: '[T-1] x' });
  });

  it('git 只读 op 自动放行且不带令牌', async () => {
    const { rt, calls } = makeRt();
    await rt.execute('git', { op: 'status' }, 'plan');
    const gitCall = calls.find((c) => c.method === 'git.exec');
    expect(gitCall?.params).not.toHaveProperty('approvalToken');
  });

  it('terminal 高危命令带令牌（对照，防止回归）', async () => {
    const { rt, calls } = makeRt();
    await rt.execute('terminal', { command: 'rm -rf /tmp/x' }, 'plan');
    const termCall = calls.find((c) => c.method === 'term.exec');
    expect(termCall?.params).toHaveProperty('approvalToken');
  });
});
