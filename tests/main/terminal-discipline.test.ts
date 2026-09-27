// terminal 命令纪律与退出码语义回归测试（C1 / C2 / C3）
//
// 背景（三条真实缺陷，全部来自线上截图复现）：
//  - C1 规则自相矛盾：提示词第 4 条教模型「链式命令用分号分隔」，而 sidecar 的
//       `validate_command` 恰恰**拒绝**引号外分号；模型照提示词写，命令必被拒。
//  - C2 长度门槛误杀正确命令：`>200 字符且不含 .ps1 → 拒绝` 是**长度**规则而非
//      危险性规则。222 字符的 Invoke-WebRequest + try/catch 探测（真实常见写法）
//      被全量误杀；201 字符被拒而 199 字符放行。表现为 terminal「时好时坏」。
//  - C3 审批后仍失败：上述校验发生在**审批卡弹出之后**，用户点了「批准」，
//      命令照样被同一条规则拒绝 —— 审批卡变成无效交互（截图：卡上「已批准」，
//      工具流里却 ✗）。
//  - C4 失败被当成成功：sidecar 遵循规格 3.3.4「退出码优先」，命令执行失败
//      （exitCode≠0 / 超时 124）仍返回 `ok=true`，失败信息只在 data.exitCode/stderr。
//      主进程此前只看 `env.ok`，于是**失败的命令被标成「完成」**，模型据此以为
//      跑通了并继续推理，产出「已验证」式幻觉。
//
// 修复策略（对应用户拍板的方案）：
//  - 放宽长度门槛 + 消解矛盾：删掉 >200 的 PS 一行式规则（长度上限统一由
//    sidecar 的 2000 字符 CMD_OVERFLOW_BLOCKED 承担）；提示词改为禁 `;` 链式。
//  - 校验前置到审批前：主进程 `precheckTerminalCommand` 与 sidecar 同规则、
//    同语义，非法命令**不弹卡**，直接把可自纠的说明回注模型。
//  - 退出码提升为业务失败：`promoteTerminalExit` 把 exitCode≠0 / 124 转成
//    ok=false（3001 CMD_REJECTED / 2002 TERM_TIMEOUT），并**保留 data**。
import { describe, expect, it } from 'vitest';

import {
  ToolRuntime,
  hasUnquotedSemicolon,
  precheckTerminalCommand,
  promoteTerminalExit,
  TERM_CMD_LIMIT,
} from '../../electron/src/tools/runtime';
import { ApprovalGateway } from '../../electron/src/tools/gateway';

// ---------------------------------------------------------------- 单元：预检规则

describe('C1/C2: precheckTerminalCommand 命令纪律预检', () => {
  it('合法短命令放行（null 表示无问题）', () => {
    expect(precheckTerminalCommand({ command: 'dir' })).toBeNull();
    expect(precheckTerminalCommand({ command: 'Get-ChildItem -Recurse' })).toBeNull();
  });

  it('超过 200 字符的 Invoke-WebRequest 一行式放行（C2 关键回归）', () => {
    // 这条命令正是截图中被审批通过、随后又被拒的真实写法；同时含引号内分号。
    // 旧规则（>200 字符且不含 .ps1 → 拒绝）会把它误杀。
    const cmd =
      `powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing ` +
      `-Uri 'https://www.google.com/search?q=best+agent+model' -TimeoutSec 20; 'g'; ` +
      `$r.StatusCode } catch { $_.Exception.Message }"`;
    expect(cmd.length).toBeGreaterThan(200); // 确认样本确实越过旧门槛
    expect(cmd.includes('.ps1')).toBe(false);
    expect(precheckTerminalCommand({ command: cmd })).toBeNull();
  });

  it('超过 TERM_CMD_LIMIT 的命令给出「落成 .ps1」建议', () => {
    const msg = precheckTerminalCommand({ command: 'x'.repeat(TERM_CMD_LIMIT + 1) });
    expect(msg).not.toBeNull();
    expect(msg).toContain('.ps1');
    expect(msg).toContain(String(TERM_CMD_LIMIT));
  });

  it('恰好在阈值上的命令放行（边界不误杀）', () => {
    expect(precheckTerminalCommand({ command: 'x'.repeat(TERM_CMD_LIMIT) })).toBeNull();
  });

  it('&& / || 链式被拒并提示拆分或脚本化', () => {
    expect(precheckTerminalCommand({ command: 'cd a && dir' })).toMatch(/&&|\|\||\.ps1/);
    expect(precheckTerminalCommand({ command: 'a || b' })).toMatch(/&&|\|\||\.ps1/);
  });

  it('引号外分号链式被拒（C1 矛盾消解：提示词与规则一致）', () => {
    const msg = precheckTerminalCommand({ command: 'cd /d C:\\x; dir' });
    expect(msg).not.toBeNull();
    expect(msg).toContain('.ps1');
  });

  it('引号内的分号是内容而非链式，放行', () => {
    expect(precheckTerminalCommand({ command: `powershell -NoProfile -Command "a; b"` })).toBeNull();
  });

  it('显式 powershell 调用缺 -NoProfile 被拒', () => {
    const msg = precheckTerminalCommand({ command: 'powershell -Command "dir"' });
    expect(msg).not.toBeNull();
    expect(msg).toContain('-NoProfile');
  });

  it('非字符串 command 返回 null（交由参数校验兜底，避免重复报错）', () => {
    expect(precheckTerminalCommand({ command: 123 })).toBeNull();
    expect(precheckTerminalCommand(null)).toBeNull();
  });
});

describe('hasUnquotedSemicolon 引号感知', () => {
  it('识别引号外分号', () => {
    expect(hasUnquotedSemicolon('a; b')).toBe(true);
    expect(hasUnquotedSemicolon('a;b;c')).toBe(true);
  });

  it('忽略成对引号内的分号', () => {
    expect(hasUnquotedSemicolon(`"a; b"`)).toBe(false);
    expect(hasUnquotedSemicolon(`'a; b'`)).toBe(false);
    expect(hasUnquotedSemicolon(`cmd "x; y" z`)).toBe(false);
  });

  it('引号闭合后的分号仍算链式', () => {
    expect(hasUnquotedSemicolon(`echo "x"; dir`)).toBe(true);
  });
});

// ---------------------------------------------------------------- 单元：退出码提升

describe('C4: promoteTerminalExit 退出码优先', () => {
  it('exitCode=0 原样透传（成功不误伤）', () => {
    const env = { ok: true as const, data: { exitCode: 0, stdout: 'done' } };
    expect(promoteTerminalExit(env)).toBe(env);
  });

  it('非零退出 → ok:false + 3001，且保留 data', () => {
    const env = { ok: true as const, data: { exitCode: 127, stderr: 'command not found' } };
    const out = promoteTerminalExit(env);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe(3001);
    expect(out.error?.message).toContain('127');
    // stdout/stderr 必须原样保留，卡片「结果」区与模型回注都依赖它
    expect((out.data as any).exitCode).toBe(127);
    expect((out.data as any).stderr).toBe('command not found');
  });

  it('超时 124 → ok:false + 2002 TERM_TIMEOUT', () => {
    const out = promoteTerminalExit({ ok: true, data: { exitCode: 124, stderr: 'timed out' } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe(2002);
    expect(out.error?.message).toMatch(/超时|timeout/i);
  });

  it('上游已 ok=false 时原样透传，不覆盖更精确的错误', () => {
    const env = { ok: false as const, error: { code: 3001, message: 'rejected by rule' } };
    expect(promoteTerminalExit(env)).toBe(env);
  });

  it('没有 exitCode 字段的返回不改写（如非命令类结果）', () => {
    const env = { ok: true as const, data: { rows: [] } };
    expect(promoteTerminalExit(env)).toBe(env);
  });

  it('错误信息附带输出尾部，便于自纠', () => {
    const out = promoteTerminalExit({
      ok: true,
      data: { exitCode: 1, stderr: 'Access is denied.' },
    });
    expect(out.error?.message).toContain('Access is denied.');
  });
});

// ---------------------------------------------------------------- 集成：管道顺序

interface RtOptions {
  approve?: boolean;
  handler?: (method: string, params: any) => any;
}

function makeRt(opts: RtOptions = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const approvals: string[] = [];
  const sidecar = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return opts.handler ? opts.handler(method, params) : { ok: true, data: { exitCode: 0 } };
    },
  };
  const budget = { tickTurn: () => undefined };
  const gateway = new ApprovalGateway(sidecar as never);
  gateway.onApproval(async (req: any) => {
    approvals.push(req?.tool ?? req?.method ?? '?');
    return opts.approve !== false;
  });
  const settings = { get: (k: string) => (k === 'workspacePath' ? '/tmp/test-ws' : undefined) };
  return {
    rt: new ToolRuntime(sidecar as never, budget as never, gateway, settings as never),
    calls,
    approvals,
  };
}

describe('C2/C3: 校验前置到审批前（审批卡不再无效）', () => {
  it('非法命令不弹审批卡、不调用 sidecar，直接回注可自纠错误', async () => {
    const { rt, calls, approvals } = makeRt();
    const r = await rt.execute('terminal', { command: 'cd /d C:\\x; dir' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(3001);
    expect(r.error?.message).toContain('.ps1');
    expect(approvals.length).toBe(0); // 关键：没有打扰用户
    expect(calls.length).toBe(0); // 关键：没有打到 sidecar
  });

  it('超长命令同样被前置拦截', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('terminal', { command: 'x'.repeat(TERM_CMD_LIMIT + 5) }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(3001);
    expect(calls.length).toBe(0);
  });

  it('合法命令正常走审批 + sidecar', async () => {
    const { rt, calls } = makeRt();
    const r = await rt.execute('terminal', { command: 'dir' }, 'plan');
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === 'term.exec')).toBeTruthy();
  });
});

describe('C4 集成: 失败命令不再渲染为成功', () => {
  it('sidecar 返回 ok=true 但 exitCode≠0 → 工具层 ok=false', async () => {
    const { rt } = makeRt({ handler: () => ({ ok: true, data: { exitCode: 2, stderr: 'bad flag' } }) });
    const r = await rt.execute('terminal', { command: 'dir /zzz' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(3001);
    expect((r.data as any).exitCode).toBe(2);
  });

  it('超时命令 → 2002，模型能区分「失败」与「卡住」', async () => {
    const { rt } = makeRt({ handler: () => ({ ok: true, data: { exitCode: 124 } }) });
    const r = await rt.execute('terminal', { command: 'ping -t 1.1.1.1' }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(2002);
  });

  it('exitCode=0 的成功命令维持 ok=true（不误报失败）', async () => {
    const { rt } = makeRt({ handler: () => ({ ok: true, data: { exitCode: 0, stdout: 'ok' } }) });
    const r = await rt.execute('terminal', { command: 'dir' }, 'plan');
    expect(r.ok).toBe(true);
  });
});
