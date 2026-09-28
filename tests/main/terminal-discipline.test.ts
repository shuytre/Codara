// terminal 命令处理与退出码语义回归测试
//
// ============================ 口径反转（2026-09-28，最终定稿） ============================
// 本文件此前记录的是「白名单减摩擦层」思路。该思路已被推翻，原因是它连续造成三轮线上
// 事故 —— 每一轮都是「拦写法不拦危险性」，且拒绝都发生在**审批通过之后**，使审批卡沦为
// 无效交互（用户点了「批准」，工具流里却是 ✗）：
//  - 只读管道被误杀：`Get-ChildItem -Force | Select-Object Name` 因 select-object 在黑名单里；
//  - 长度门槛误杀：222 字符的 Invoke-WebRequest + try/catch 探测被拒；
//  - 链式/分号/前缀禁令与提示词互相矛盾，模型照提示词写必被拒。
//
// 新口径：**命令内容不做任何限制或改写**。
//  - sidecar `validate_command` 只保留两条工程保护：空命令、长度上限（防 RPC 帧撑爆）；
//  - Electron `precheckTerminalCommand` 同样只保留长度上限；
//  - 安全职责全部交给**强制保留的人工审查中间层**（tools/gateway.ts）：
//    高危命令 + 读写类命令一律弹审批卡，危险命令不额外拦截、同普通卡处理；
//  - 模型自主选定 shell 并用括号标注（如 `(PowerShell) ...`），标注不改写、不校验。
//
// 保留下来的这批用例，除「内容过滤已移除」外，还覆盖一个仍然成立的关键修复：
//  - C4 失败被当成成功：sidecar 遵循规格 3.3.4「退出码优先」，命令执行失败
//      （exitCode≠0 / 超时 124）仍返回 `ok=true`，失败信息只在 data.exitCode/stderr。
//      主进程只认 `env.ok` 时会把**失败的命令标成「完成」**，模型据此以为跑通了并继续
//      推理，产出「已验证」式幻觉。`promoteTerminalExit` 把它如实转为 ok=false。
//      这是「如实上报」，不是内容过滤，因此保留。
// =========================================================================================
import { describe, expect, it } from 'vitest';

import {
  ToolRuntime,
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

  it('超过 TERM_CMD_LIMIT 只给帧保护提示（不涉及内容审查）', () => {
    const msg = precheckTerminalCommand({ command: 'x'.repeat(TERM_CMD_LIMIT + 1) });
    expect(msg).not.toBeNull();
    expect(msg).toContain(String(TERM_CMD_LIMIT));
  });

  it('恰好在阈值上的命令放行（边界不误杀）', () => {
    expect(precheckTerminalCommand({ command: 'x'.repeat(TERM_CMD_LIMIT) })).toBeNull();
  });

  // 口径反转（2026-09-28）：命令内容不做任何限制或改写。
  // 链式、分号、shell 前缀此前都会被这一层拒掉，导致审批卡沦为无效交互
  // （用户点了「批准」，命令仍被拒）。现在全部放行，交由人工审查。
  it('&& / || 链式命令放行（不再拦截）', () => {
    expect(precheckTerminalCommand({ command: 'cd a && dir' })).toBeNull();
    expect(precheckTerminalCommand({ command: 'a || b' })).toBeNull();
  });

  it('引号外分号链式放行（不再拦截）', () => {
    expect(precheckTerminalCommand({ command: 'cd /d C:\\x; dir' })).toBeNull();
  });

  it('引号内的分号同样放行', () => {
    expect(precheckTerminalCommand({ command: `powershell -NoProfile -Command "a; b"` })).toBeNull();
  });

  it('PowerShell 不带 -NoProfile 放行（不再强制前缀）', () => {
    expect(precheckTerminalCommand({ command: 'powershell -Command "dir"' })).toBeNull();
  });

  it('任意命令内容都放行：违禁词、Format-*、Invoke-Expression、破坏性命令', () => {
    for (const cmd of [
      'Get-ChildItem | Format-Table',
      'Set-ExecutionPolicy Bypass',
      'Invoke-Expression $c',
      'echo $env:PATH',
      'rm -rf /tmp/x',
      'format C: /q',
      'del /f /s /q D:\\data',
      'Get-ChildItem -Force | Select-Object Name',
    ]) {
      expect(precheckTerminalCommand({ command: cmd })).toBeNull();
    }
  });

  it('非字符串 command 返回 null（交由参数校验兜底，避免重复报错）', () => {
    expect(precheckTerminalCommand({ command: 123 })).toBeNull();
    expect(precheckTerminalCommand(null)).toBeNull();
  });
});

// 说明：hasUnquotedSemicolon 已随「分号链式拦截」一并移除 ——
// 分号不再被拦截，故引号感知逻辑也无存在意义。

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

describe('C2/C3: 审批卡不再无效交互', () => {
  it('过去被拒的合法命令现在正常弹卡 → 批准 → 执行', async () => {
    // 回归核心：`cd /d C:\\x; dir` 以前弹了卡、用户批准后仍被拒（无效交互）。
    // 新口径下内容不再被审查，批准即执行。
    const { rt, calls, approvals } = makeRt();
    const r = await rt.execute('terminal', { command: 'cd /d C:\\x; dir' }, 'plan');
    expect(r.ok).toBe(true);
    expect(approvals.length).toBeGreaterThan(0); // 走了人工审查
    expect(calls.find((c) => c.method === 'term.exec')).toBeTruthy(); // 真的执行了
  });

  it('超长命令仍被前置拦截（唯一的工程性约束）', async () => {
    const { rt, calls, approvals } = makeRt();
    const r = await rt.execute('terminal', { command: 'x'.repeat(TERM_CMD_LIMIT + 5) }, 'plan');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(3001);
    expect(approvals.length).toBe(0); // 超长命令不打扰用户
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

// ---------------------------------------------------------------- C5：只读管道误杀（本轮）
//
// 事故现象（第三轮截图）：`Get-ChildItem -Force | Select-Object Name` 执行后 ✗。
// 根因：sidecar `check_ps_forbidden` 的禁用词表把只读、无副作用的管道 cmdlet
// （select-object / where-object / sort-object / foreach-object / gci / cat / % / ?）
// 一并列为禁用，导致**最常用的目录浏览写法**被判「最小子集违规」。
// 这是「拦写法不拦危险性」的第二次踩坑（第一次是 >200 字符长度规则）。
//
// 修复：禁用词表只保留有副作用/语义模糊的写法（Format-* / Set-ExecutionPolicy /
// Invoke-Expression / $env: / echo $ …），且每条都附带等价写法建议，使其可自纠。
describe('C5: PowerShell 只读管道放行', () => {
  const ALLOWED = [
    'Get-ChildItem -Force | Select-Object Name',
    'Get-ChildItem -Recurse | Where-Object { $PSItem.Length -gt 0 }',
    'Get-Process | Sort-Object CPU -Descending',
    'gci -Recurse *.rs | Select-Object -First 20',
    'Get-Content src/main.rs | Select-String todo',
    'powershell -NoProfile -Command "Get-ChildItem | Select-Object Name"',
  ];

  for (const cmd of ALLOWED) {
    it(`放行只读管道：${cmd.slice(0, 44)}`, () => {
      expect(precheckTerminalCommand({ command: cmd })).toBeNull();
    });
  }

  it('select-object 不再出现在拒绝理由里（精确回归）', () => {
    const msg = precheckTerminalCommand({
      command: 'powershell -NoProfile -Command "Get-ChildItem | Select-Object Name"',
    });
    expect(msg).toBeNull();
  });

  it('有副作用的写法同样放行（不再有内容审查）', () => {
    // 旧实现会拦 Format-* / Set-ExecutionPolicy / Invoke-Expression；
    // 新口径下 sidecar 不做内容审查，这一层也不拦，全部交由人工审查。
    for (const cmd of [
      'powershell -NoProfile -Command "Get-ChildItem | Format-Table"',
      'powershell -NoProfile -Command "Set-ExecutionPolicy Bypass"',
      'powershell -NoProfile -Command "Invoke-Expression $c"',
    ]) {
      expect(precheckTerminalCommand({ command: cmd })).toBeNull();
    }
  });

  it('所有终端命令都进入人工审查（不再有预检放行）', async () => {
    // 关键行为变更：以前只读管道能"跳过审批直接执行"，现在**每条命令都过审查卡**。
    // 这是「人工审查中间层强制保留」的直接体现。
    const { rt, calls } = makeRt();
    const r = await rt.execute('terminal', { command: 'Get-ChildItem -Force | Select-Object Name' }, 'plan');
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.method === 'term.exec')).toBeTruthy();
  });
});
