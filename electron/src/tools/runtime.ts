// 工具运行时管道：schema 校验 → 角色矩阵 → 权限网关 → sidecar RPC → 审计 → 预算 tick
import {
  CrewRole,
  Envelope,
  ErrorCode,
  GitParams,
  ReadParams,
  SearchParams,
  ToolSpec,
  TerminalParams,
  WriteParams,
} from '@codara/contract';

import { ROLE_DEFS } from '../crew/roles';

import { SidecarManager } from '../sidecar/manager';
import { BudgetLedger } from '../budget/ledger';
import { SettingsStore } from '../config/settingsStore';
import { ApprovalGateway } from './gateway';

export interface ToolResult extends Envelope {
  tool: string;
  params: unknown;
  durationMs: number;
}

/** 调度器注入接口（避免循环依赖；由 CrewScheduler 实现） */
export interface CrewSchedulerLike {
  spawnInstance(input: {
    taskId: string; role: CrewRole; goal: string;
    acceptanceCriteria?: string[]; fileScope?: string[];
    upstreamArtifacts?: string[];
    effort?: 'low' | 'medium' | 'high'; maxTurns?: number;
  }): Promise<{ instanceId: string }>;
  handoff(input: { instanceId: string; toRole: CrewRole; goal: string; note?: string }): Promise<{ instanceId: string }>;
  taskStatus(input: { taskId?: string }): Promise<unknown>;
  writeArtifact(input: { taskId: string; type: string; body: string; refs?: string[] }): Promise<unknown>;
}

const CREW_TOOL_NAMES = ['task.spawn', 'task.handoff', 'task.status', 'artifact.write'];

export class ToolRuntime {
  constructor(
    private readonly sidecar: SidecarManager,
    private readonly budget: BudgetLedger,
    private readonly gateway: ApprovalGateway,
    private readonly settings: SettingsStore,
    private readonly scheduler?: CrewSchedulerLike,
    /**
     * 归属会话 id（第 6 轮并行隔离）：随审批请求一起送到渲染层，
     * 使两个会话各自有待审批卡片时互不串台。专家团实例传 'crew'。
     */
    private readonly sessionId: string = 'main'
  ) {}

  /** 工具定义（模型可见契约）。includeCrew=true 时附加 task.* 调度工具（Coordinator 专属） */
  toolSpecs(includeCrew = false): ToolSpec[] {
    const base: ToolSpec[] = [
      {
        name: 'read',
        description: '读取文件。按行返回带行号；offset 起始行（1 起），limit 默认 200 最大 2000；二进制只返回元信息；重复读返回缓存引用。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对路径或相对工作区路径' },
            offset: { type: 'number', description: '起始行号，默认 1' },
            limit: { type: 'number', description: '最大行数，默认 200' },
            encoding: { type: 'string', enum: ['auto', 'utf-8', 'gbk', 'gb18030'], description: '编码，默认 auto' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write',
        description:
          '补丁式写入（唯一写通道）。必须同时给出 path 与 edits 数组：edits 每项用 oldText/newText 精确替换，或用 insertAfter/insertBefore 锚点插入。新建文件必须 create=true（此时 edits 的 newText 按顺序拼成完整文件内容，不得含 oldText）。修改已有文件必须 create=false 且先用 read 拿到 baselineHash 传入。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '必填。目标文件路径，相对工作区根（如 index.html）或绝对路径。缺失将直接报错。只能写工作区内文件，越界写入会被拒绝（错误码 1001）。',
            },
            edits: {
              type: 'array',
              description: '必填。编辑项数组，至少一项。',
              items: {
                type: 'object',
                properties: {
                  oldText: { type: 'string', description: '被替换的原文（必须与文件内容逐字一致）' },
                  newText: { type: 'string', description: '替换后的新文本；新建文件时此字段按顺序拼接' },
                  insertAfter: { type: 'string', description: '在此锚点文本之后插入 newText' },
                  insertBefore: { type: 'string', description: '在此锚点文本之前插入 newText' },
                },
              },
            },
            create: { type: 'boolean', description: '新建文件必须 true；修改已有文件必须 false 或省略' },
            baselineHash: { type: 'string', description: '最近一次 read 返回的 baselineHash（修改已有文件时必填）' },
          },
          required: ['path', 'edits'],
        },
      },
      {
        name: 'terminal',
        description: '终端执行（持久会话）。必须给出 command；命令内容不受限制或改写——链式（&& / || / ;）、管道、多行写法均可，由你自主选择 shell（CMD / Bash / PowerShell）并在命令开头用括号标注。每条命令都会弹人工审批卡。超时默认 30s 上限 300s。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '必填。单条命令行，如 dir 或 npm test。' },
            cwd: { type: 'string', description: '工作目录（相对工作区根），默认工作区根' },
            timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，上限 300000' },
            input: { type: 'string', description: '标准输入内容（交互式命令用）' },
            sessionId: { type: 'string', description: '复用终端会话 id；省略则自动建立' },
          },
          required: ['command'],
        },
      },
      {
        name: 'git',
        description: '版本控制。只读 op（status/diff/log/show/branch/worktree-list）自动执行；写 op（commit/branch-create/worktree-create/worktree-remove/revert）默认需批准。',
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['status', 'diff', 'log', 'show', 'branch', 'worktree-list', 'commit', 'branch-create', 'worktree-create', 'worktree-remove', 'revert'],
            },
            args: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['op'],
        },
      },
      {
        name: 'search',
        description: '搜索（定位优先）。rg=内容搜索；files=文件列举；symbols=符号/定义查询（委托代码索引，未建库时自动文件名快路径）；结果按文件分组 路径:行号:内容。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['rg', 'files', 'symbols'] },
            caseSensitive: { type: 'boolean' },
            context: { type: 'number', description: '默认 0，最大 3' },
            maxResults: { type: 'number', description: '默认 100' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'index.symbols',
        description: '代码索引符号查询（M5）。按名称查定义/大纲（函数/类/结构体/接口），带容器与行号；支持模糊与 kind 过滤。只读。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '符号名（支持子串/前缀）' },
            kind: { type: 'string', description: '类型过滤：function/class/struct/trait/interface/method 等' },
            exact: { type: 'boolean', description: '精确匹配，默认 false' },
            limit: { type: 'number', description: '默认 50，最大 500' },
          },
          required: ['name'],
        },
      },
      {
        name: 'index.semantic',
        description: '代码索引语义检索（M5，默认关闭）。BM25F 全文 + 符号名/路径加权 + 模糊匹配，返回相关文件排序。未开启时返回 8002，提示用户在设置中开启。只读。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言或关键词查询' },
            limit: { type: 'number', description: '默认 20，最大 100' },
          },
          required: ['query'],
        },
      },
    ];

    if (includeCrew && this.scheduler) {
      base.push(
        {
          name: 'task.spawn',
          description: '派发专家团角色实例。role=角色；goal=任务包目标；acceptanceCriteria=验收标准；fileScope=文件范围白名单（Developer 必填）。',
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              role: { type: 'string', enum: ['architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher'] },
              goal: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
              fileScope: { type: 'array', items: { type: 'string' } },
              effort: { type: 'string', enum: ['low', 'medium', 'high'] },
              maxTurns: { type: 'number' },
            },
            required: ['taskId', 'role', 'goal'],
          },
        },
        {
          name: 'task.handoff',
          description: '交接：为角色新开实例，只携带交接物与目标（不携带旧对话历史）。',
          parameters: {
            type: 'object',
            properties: {
              instanceId: { type: 'string', description: '来源实例 ID' },
              toRole: { type: 'string', enum: ['architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher'] },
              goal: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['instanceId', 'toRole', 'goal'],
          },
        },
        {
          name: 'task.status',
          description: '查询任务与实例状态（双层状态机）。',
          parameters: {
            type: 'object',
            properties: { taskId: { type: 'string' } },
          },
        },
        {
          name: 'artifact.write',
          description: '登记交接物（plan/patch-set/review/acceptance/build-report/research），落盘任务工作区并入库。',
          parameters: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              type: { type: 'string', enum: ['plan', 'patch-set', 'review', 'acceptance', 'build-report', 'research'] },
              body: { type: 'string' },
              refs: { type: 'array', items: { type: 'string' } },
            },
            required: ['taskId', 'type', 'body'],
          },
        }
      );
    }
    return base;
  }

  /** 角色工具矩阵（单一来源：crew/roles ROLE_DEFS） */
  private roleTools(role: CrewRole): Set<string> {
    return new Set(ROLE_DEFS[role].tools);
  }

  /** 工具是否在注册表内（含调度工具；未注入 scheduler 时不暴露） */
  private isKnownTool(tool: string): boolean {
    const known = new Set(this.toolSpecs(!!this.scheduler).map((s) => s.name));
    return known.has(tool);
  }

  /** 执行工具调用（完整管道）。role 存在时强制角色工具矩阵（越权 4002） */
  async execute(tool: string, params: unknown, mode: 'ask' | 'plan' | 'goal' = 'plan', role?: CrewRole): Promise<ToolResult> {
    const started = Date.now();

    // 调度工具在非专家团上下文（未注入 scheduler）属「已知但当前不可用」，
    // 必须先于未知工具判定给出精确原因，否则会被误报成「未知工具」。
    if (!this.scheduler && CREW_TOOL_NAMES.includes(tool)) {
      return {
        ok: false,
        error: { code: 4002, message: `tool ${tool} requires crew preset (coordinator)` },
        tool,
        params,
        durationMs: 0,
      };
    }

    // 工具注册表校验（B4）：未知工具名必须给出「这不是有效工具」的明确错误，
    // 而不是落入网关 deny 兜底的 "operation denied by policy"——后者会让模型
    // 以为是权限问题而反复重试同一个不存在的工具，形成无终点失败循环。
    if (!this.isKnownTool(tool)) {
      const available = this.toolSpecs(!!this.scheduler).map((s) => s.name);
      return {
        ok: false,
        error: {
          code: ErrorCode.METHOD_NOT_FOUND,
          message:
            `未知工具「${tool}」：该工具不存在，请勿重试。` +
            `当前可用工具：[${available.join(', ')}]。` +
            '请改用上述工具，或用 search/read 确认目标后再继续。',
        },
        tool,
        params: summarize(params),
        durationMs: Date.now() - started,
      };
    }

    // 角色工具矩阵：越权拒绝（隔离是架构约束，不是提示词约定）
    if (role) {
      const allowed = this.roleTools(role);
      if (!allowed.has(tool)) {
        return {
          ok: false,
          error: { code: 4002, message: `tool ${tool} is not allowed for role ${role}` },
          tool,
          params,
          durationMs: 0,
        };
      }
    } else if (CREW_TOOL_NAMES.includes(tool)) {
      // 极简模式主对话不可用调度工具
      return {
        ok: false,
        error: { code: 4002, message: `tool ${tool} requires crew preset (coordinator)` },
        tool,
        params,
        durationMs: 0,
      };
    }

    // Ask 模式（极简少工具集）：git 不在集内，防御性拒绝；write/terminal 放行（走网关审批卡），index.* 只读放行
    if (mode === 'ask' && (tool === 'git' || tool.startsWith('artifact.'))) {
      return {
        ok: false,
        error: { code: 4002, message: `tool ${tool} is not allowed in Ask mode` },
        tool,
        params,
        durationMs: 0,
      };
    }

    // 工作区守卫：fs/终端/搜索/索引类工具以工作区为根，未打开时给出可行动的错误（回注模型转告用户）
    const needsWorkspace = ['read', 'write', 'terminal', 'git', 'search', 'index.symbols', 'index.semantic'].includes(tool);
    if (needsWorkspace && !this.settings.get('workspacePath')) {
      return {
        ok: false,
        error: {
          code: 4003,
          message: '未打开工作区：请用户先点击输入框下方工具行的「未打开工作区」按钮选择项目文件夹后再执行本工具。',
        },
        tool,
        params,
        durationMs: 0,
      };
    }

    // 参数静态校验（B3）：在网关/子进程之前拦下缺参、类型错误、非法枚举。
    // 原实现把模型参数原样透传给 sidecar，由 sidecar 事后报 "path is required"——
    // 模型明明传了 path:123，却收到「缺少 path」，无法自纠只能重试。
    // 这里返回精确到「工具 + 参数名 + 期望类型 + 实际类型」的错误，模型可直接修正。
    const paramErr = validateToolParams(tool, params);
    if (paramErr) {
      return {
        ok: false,
        error: { code: ErrorCode.INVALID_PARAMS, message: paramErr },
        tool,
        params: summarize(params),
        durationMs: Date.now() - started,
      };
    }

    // terminal 命令纪律预检（前置到审批之前）。
    // 此前校验只在 sidecar 的 term.exec 里做，而它发生在**审批卡弹出之后**——用户点了
    // 「批准」，命令仍会被同一条规则拒绝，审批卡变成一次无效交互（截图现象：卡上写着
    // 「已批准」，工具流水里却是 ✗）。这里把同一套规则前移到主进程：非法命令根本不弹卡，
    // 直接把「命中哪条规则、怎么改」回注给模型自纠，同时省掉一次无意义的用户打扰。
    // 规则本体仍保留在 sidecar（它是最终防线，不放宽），这里只是提前告知。
    if (tool === 'terminal') {
      const cmdErr = precheckTerminalCommand(params);
      if (cmdErr) {
        return {
          ok: false,
          error: { code: ErrorCode.CMD_REJECTED, message: cmdErr },
          tool,
          params: summarize(params),
          durationMs: Date.now() - started,
        };
      }
    }

    // 权限网关：ask 级操作先审批（带 sessionId，供渲染层投递到对应会话分区）
    const gate = await this.gateway.check(tool, params, mode, this.sessionId);
    if (!gate.allowed) {
      return {
        ok: false,
        error: { code: 4002, message: gate.reason || 'approval rejected' },
        tool,
        params,
        durationMs: Date.now() - started,
      };
    }

    let env: Envelope;
    switch (tool) {
      case 'read': {
        const p = params as ReadParams;
        env = await this.sidecar.call('fs.read', p);
        break;
      }
      case 'write': {
        // 参数归一化：吸收各厂商异构 edits 形态（字符串化 JSON、行区间等）→ sidecar 契约
        const norm = normalizeWriteParams(params);
        if (!norm) {
          // 注意：走到这里说明上游 validateToolParams 未拦下（例如 edits 形态归一化后仍为空）。
          // 错误信息必须区分「缺 path」与「edits 无法解析」，不能笼统报「缺少 path 或 edits」，
          // 否则模型明明传了 path 也会去补 path，永远修不好（B5）。
          const obj = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
          const hasPath = typeof obj.path === 'string' && obj.path.trim() !== '';
          const reason = !hasPath
            ? '缺少 path（目标文件路径）'
            : Array.isArray(obj.edits)
              ? 'edits 数组为空或不含任何可识别编辑项'
              : typeof obj.edits === 'string'
                ? 'edits 是字符串但既不是合法 JSON 数组，也非文件内容'
                : 'edits 缺失或类型不正确（应为数组）';
          return {
            ok: false,
            error: {
              code: ErrorCode.INVALID_PARAMS,
              message:
                `write 参数无法解析：${reason}。你提供的参数键：[${Object.keys(obj).join(', ') || '（空）'}]。` +
                '请重新调用 write：新建 {"path":"a.html","create":true,"edits":[{"newText":"...文件全文..."}]}；' +
                '改动 {"path":"a.ts","create":false,"baselineHash":"...","edits":[{"oldText":"...","newText":"..."}]}。',
            },
            tool,
            params: summarize(params),
            durationMs: Date.now() - started,
          };
        }
        // 写前预快照（fs.patch 成功后 sidecar 不自动快照，主进程编排）
        await this.sidecar.call('snap.create', { paths: [norm.path], label: 'pre-patch', taskId: 'adhoc' }).catch(() => undefined);
        env = await this.sidecar.call('fs.patch', norm);
        // 自愈：模型常带过期 baselineHash。
        // 仅对 1002（基线哈希冲突）自愈，且必须 fs.read 重读拿到最新 hash 后重放；
        // 不能「丢掉 hash 重试」——sidecar 在缺 hash 时完全不做冲突检查，
        // 那等于绕过并发写保护，会静默拍平其他实例/用户的并发改动。
        // 1001 越界、1005 锚点未命中等错误一律不重试（重试只会得到同样结果）。
        if (!env.ok && norm.baselineHash && env.error?.code === ErrorCode.BASELINE_MISMATCH) {
          const fresh = await this.sidecar.call('fs.read', { path: norm.path });
          const freshHash = (fresh.data as { baselineHash?: string } | null | undefined)?.baselineHash;
          if (fresh.ok && typeof freshHash === 'string' && freshHash.length > 0) {
            env = await this.sidecar.call('fs.patch', { ...norm, baselineHash: freshHash });
          }
        }
        break;
      }
      case 'terminal': {
        const p = params as TerminalParams;
        // 把网关的审批令牌透传给 sidecar：高危命令（rm -rf / format / reg add ...）
        // 在 sidecar 侧必须有放行凭据才执行，否则网关批准不等于实际放行。
        env = await this.sidecar.call('term.exec', {
          ...(p as unknown as Record<string, unknown>),
          ...(gate.approvalToken ? { approvalToken: gate.approvalToken } : {}),
        });
        // 退出码优先（规格 3.3.4）：sidecar 对命令执行失败（exitCode≠0 / 超时 124）
        // 仍返回 ok=true，失败信息只落在 data.exitCode/stderr 里。主进程此前只看 env.ok，
        // 于是**命令彻底失败也被标成「完成」**——模型据此以为跑通了，基于错误前提继续，
        // 产出「验证通过」式幻觉；用户看到的则是 terminal 时好时坏、状态不可信。
        // 这里把退出码提升为工具层的业务失败：ok=false + 保留 data（stdout/stderr 仍在），
        // 错误码复用 2002 TERM_TIMEOUT（超时）/ 3001 CMD_REJECTED（非零退出），
        // 让卡片、审计、回注模型三处一致地看到「这条命令失败了」。
        env = promoteTerminalExit(env);
        break;
      }
      case 'git': {
        const p = params as GitParams;
        // 写 op（commit/branch-create/worktree-*/revert）在 sidecar 侧硬门禁要求
        // 放行凭据。此前只透传 terminal 的令牌，git 写操作即使审批通过也会被
        // sidecar 以 4001 APPROVAL_REQUIRED 拒绝 —— 批准的 git 操作永远失败（B2）。
        env = await this.sidecar.call('git.exec', {
          ...(p as unknown as Record<string, unknown>),
          ...(gate.approvalToken ? { approvalToken: gate.approvalToken } : {}),
        });
        break;
      }
      case 'search': {
        const p = params as SearchParams;
        env = await this.sidecar.call('search.run', p);
        break;
      }
      case 'index.symbols':
      case 'index.semantic': {
        // M5：代码索引只读查询，直通 sidecar 对应方法
        env = await this.sidecar.call(tool, params);
        break;
      }
      case 'task.spawn': {
        const p = params as { taskId: string; role: CrewRole; goal: string; acceptanceCriteria?: string[]; fileScope?: string[]; effort?: 'low' | 'medium' | 'high'; maxTurns?: number };
        const r = await this.scheduler!.spawnInstance(p);
        env = { ok: true, data: r };
        break;
      }
      case 'task.handoff': {
        const p = params as { instanceId: string; toRole: CrewRole; goal: string; note?: string };
        const r = await this.scheduler!.handoff(p);
        env = { ok: true, data: r };
        break;
      }
      case 'task.status': {
        const p = params as { taskId?: string };
        const r = await this.scheduler!.taskStatus(p);
        env = { ok: true, data: r as Record<string, unknown> };
        break;
      }
      case 'artifact.write': {
        const p = params as { taskId: string; type: string; body: string; refs?: string[] };
        const r = await this.scheduler!.writeArtifact(p);
        env = { ok: true, data: r as Record<string, unknown> };
        break;
      }
      default:
        env = { ok: false, error: { code: -32601, message: `unknown tool: ${tool}` } };
    }

    // 审计（脱敏在 sidecar 侧完成）
    void this.sidecar
      .call('audit.note', {
        event: 'tool.call',
        tool,
        ok: env.ok,
        durationMs: Date.now() - started,
        params: env.ok ? summarize(params) : params,
      })
      .catch(() => undefined);

    // 预算轮次 tick
    this.budget.tickTurn();

    return { ...env, tool, params: summarize(params), durationMs: Date.now() - started };
  }
}

/**
 * 工具参数静态校验（B3）：返回 null 表示通过，返回字符串表示可直接回注模型的错误说明。
 *
 * 设计原则：
 *  - 只做「结构性」校验（必填是否存在、类型是否匹配、枚举是否合法），不做业务校验；
 *  - 错误信息必须包含 工具名 / 参数名 / 期望类型 / 实际类型，让模型一次就能修正；
 *  - 刻意宽容可选字段的额外键（厂商会带 vendor 字段），避免误拒合法调用。
 *
 * 与 sidecar 的关系：sidecar 的校验是最终防线（不删），这里是「让错误可读」的前置层。
 */
export function validateToolParams(tool: string, params: unknown): string | null {
  const spec = TOOL_PARAM_SPECS[tool];
  if (!spec) return null; // 未知工具已在上游拒绝

  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return (
      `工具「${tool}」的参数必须是 JSON 对象，实际收到 ${describeType(params)}。` +
      `请以 {\"必填参数\":\"值\"} 形式重新调用。`
    );
  }
  const p = params as Record<string, unknown>;

  // 必填检查
  const missing: string[] = [];
  for (const key of spec.required) {
    const v = p[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) missing.push(key);
  }
  if (missing.length > 0) {
    return (
      `工具「${tool}」缺少必填参数：[${missing.join(', ')}]。` +
      `你提供的参数键：[${Object.keys(p).join(', ') || '（空）'}]。` +
      `${spec.hint ? '正确形态：' + spec.hint + '。' : ''}` +
      '禁止原样重发，请补齐后重新调用。'
    );
  }

  // 类型检查（只校验已提供的字段）
  for (const [key, expected] of Object.entries(spec.types)) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    if (!typeMatches(v, expected)) {
      return (
        `工具「${tool}」的参数「${key}」类型错误：期望 ${expected}，实际 ${describeType(v)}` +
        `（值：${safePreview(v)}）。请修正类型后重新调用。`
      );
    }
  }

  // 枚举检查
  for (const [key, allowed] of Object.entries(spec.enums ?? {})) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !allowed.includes(v)) {
      return `工具「${tool}」的参数「${key}」取值非法：「${v}」。允许值：[${allowed.join(', ')}]。`;
    }
  }

  // write 专项：edits 必须是非空数组，且每项必须含可识别的编辑字段。
  // 原实现把「path 存在但 edits 形态非法」也报成「缺少 path 或 edits」，误导模型（B5）。
  if (tool === 'write') {
    const edits = p.edits;
    if (Array.isArray(edits)) {
      if (edits.length === 0) {
        return `工具「write」的 edits 不能为空数组。新建文件请给 [{"newText":"文件全文"}]；修改已有文件请给 [{"oldText":"原文","newText":"新文"}]。`;
      }
      const bad = edits.findIndex(
        (e) =>
          !e ||
          typeof e !== 'object' ||
          (typeof e !== 'string' &&
            (e as Record<string, unknown>).oldText === undefined &&
            (e as Record<string, unknown>).newText === undefined &&
            (e as Record<string, unknown>).insertAfter === undefined &&
            (e as Record<string, unknown>).insertBefore === undefined)
      );
      if (bad >= 0) {
        return `工具「write」的 edits[${bad}] 缺少可识别的编辑字段。每项必须含 oldText/newText（精确替换）或 insertAfter/insertBefore + newText（锚点插入）。`;
      }
    }
  }

  return null;
}

/** 工具参数规格表（仅覆盖需要前置校验的字段；未列字段一律放行） */
const TOOL_PARAM_SPECS: Record<
  string,
  { required: string[]; types: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>; enums?: Record<string, string[]>; hint?: string }
> = {
  read: {
    required: ['path'],
    types: { path: 'string', offset: 'number', limit: 'number', encoding: 'string' },
    enums: { encoding: ['auto', 'utf-8', 'gbk', 'gb18030'] },
    hint: '{"path":"src/index.ts","offset":1,"limit":200}',
  },
  write: {
    required: ['path', 'edits'],
    types: { path: 'string', edits: 'array', create: 'boolean', baselineHash: 'string' },
    hint: '新建：{"path":"a.html","create":true,"edits":[{"newText":"..."}]}；改动：{"path":"a.ts","create":false,"baselineHash":"...","edits":[{"oldText":"...","newText":"..."}]}',
  },
  terminal: {
    required: ['command'],
    types: {
      command: 'string',
      cwd: 'string',
      timeoutMs: 'number',
      input: 'string',
      sessionId: 'string',
    },
    hint: '{"command":"dir"}',
  },
  git: {
    required: ['op'],
    types: { op: 'string', args: 'object' },
    enums: {
      op: ['status', 'diff', 'log', 'show', 'branch', 'worktree-list', 'commit', 'branch-create', 'worktree-create', 'worktree-remove', 'revert'],
    },
    hint: '{"op":"status"}，提交需 {"op":"commit","args":{"message":"[TASK-1] 说明"}}',
  },
  search: {
    required: ['pattern'],
    types: {
      pattern: 'string',
      path: 'string',
      glob: 'array',
      mode: 'string',
      caseSensitive: 'boolean',
      context: 'number',
      maxResults: 'number',
    },
    enums: { mode: ['rg', 'files', 'symbols'] },
    hint: '{"pattern":"createServer","path":"src"}',
  },
  'index.symbols': {
    required: ['name'],
    types: { name: 'string', kind: 'string', exact: 'boolean', limit: 'number' },
    hint: '{"name":"parseFile","kind":"function"}',
  },
  'index.semantic': {
    required: ['query'],
    types: { query: 'string', limit: 'number' },
    hint: '{"query":"支付网关","limit":20}',
  },
  'task.spawn': {
    required: ['taskId', 'role', 'goal'],
    types: { taskId: 'string', role: 'string', goal: 'string', acceptanceCriteria: 'array', fileScope: 'array', effort: 'string', maxTurns: 'number' },
    enums: { role: ['architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher'], effort: ['low', 'medium', 'high'] },
  },
  'task.handoff': {
    required: ['instanceId', 'toRole', 'goal'],
    types: { instanceId: 'string', toRole: 'string', goal: 'string', note: 'string' },
    enums: { toRole: ['architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher'] },
  },
  'task.status': { required: [], types: { taskId: 'string' } },
  'artifact.write': {
    required: ['taskId', 'type', 'body'],
    types: { taskId: 'string', type: 'string', body: 'string', refs: 'array' },
    enums: { type: ['plan', 'patch-set', 'review', 'acceptance', 'build-report', 'research'] },
  },
};

function typeMatches(v: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  if (typeof v === 'string') return '字符串';
  if (typeof v === 'number') return '数字';
  if (typeof v === 'boolean') return '布尔';
  if (typeof v === 'object') return '对象';
  return typeof v;
}

function safePreview(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 80 ? s.slice(0, 80) + '…' : (s ?? String(v));
  } catch {
    return String(v);
  }
}

/** 单条命令长度上限（工程约束，与 sidecar `CMD_MAX_LEN` 一致）。
 *  这不是内容审查，只是防止超长命令撑爆 stdio 行分隔 RPC 帧。 */
export const TERM_CMD_LIMIT = 2000;

/**
 * terminal 命令预检。
 *
 * ## 口径（2026-09-28 定稿）
 *
 * **不做任何命令内容过滤或改写**：不禁链式、不做 shell 子集约束、不做违禁词过滤、
 * 不做高危语义识别、不给等价写法建议。模型输出什么就执行什么。
 * 安全职责全部交给 `gateway.check()` 的人工审查：高危命令与读写类命令一律弹审批卡，
 * 用户批准即放行（审查环节强制保留，见 `tools/gateway.ts`）。
 *
 * 此前这里堆过 4 条「纪律规则」（链式拦截、分号拦截、PowerShell 子集、长度门槛），
 * 造成审批卡沦为无效交互：用户点了「批准」，命令仍被这层拒掉。那些规则已全部移除。
 *
 * 仅剩第 5 行的**长度上限** —— 它是传输层保护，不是内容审查：超过 2000 字符的
 * 单行命令会撑爆 sidecar 的 stdio 行分隔帧。
 *
 * @returns 命中工程约束时返回可回注模型的说明；否则返回 null（交给审批与执行）
 */
export function precheckTerminalCommand(params: unknown): string | null {
  const cmd = (params as { command?: unknown } | null | undefined)?.command;
  if (typeof cmd !== 'string') return null; // 缺参/类型错误已由 validateToolParams 拦截
  const trimmed = cmd.trim();
  if (!trimmed) return null; // 空命令由必填校验兜住

  if (trimmed.length > TERM_CMD_LIMIT) {
    return (
      `terminal 命令过长（${trimmed.length} 字符，上限 ${TERM_CMD_LIMIT}，属 RPC 帧保护）。` +
      '请拆成多次 terminal 调用，或写成脚本文件后执行。'
    );
  }
  // 其余一律放行：命令内容不做任何限制或改写，交由人工审批。
  return null;
}

/**
 * 把 terminal 的退出码提升为工具层业务失败（规格 3.3.4 的对偶处理）。
 *
 * sidecar 侧 `term.exec` 遵循「退出码优先」：非零退出不是 RPC 失败，信封保持
 * `ok=true`，失败信息放在 `data.exitCode` / `data.stderr`。这个约定对 RPC 层是对的
 * （调用成功、命令失败），但主进程若只看 `env.ok`，就会把**失败的命令判成成功**，
 * 从而：卡片显示「完成」、审计记为 ok、回注模型 `{ok:true,...}` → 模型认为命令跑通，
 * 基于错误前提继续推理，最终产出「已验证」的幻觉结论。
 *
 * 这里在不丢 data（stdout/stderr/exitCode 原样保留）的前提下，把非零退出与超时
 * 转成 `ok=false` + 可读错误，错误码沿用既有语义：
 *  - 124（超时，sidecar 的约定退出码） → 2002 TERM_TIMEOUT
 *  - 其余非零                          → 3001 CMD_REJECTED
 *
 * 兼容性：仅在「命令类」错误上改写；sidecar 已返回 ok=false 的情况原样透传，
 * 不覆盖更精确的上游错误（如 3001 命令纪律拒绝、4001 审批缺失）。
 */
export function promoteTerminalExit(env: Envelope): Envelope {
  if (!env.ok) return env;
  const data = env.data as { exitCode?: unknown; stderr?: unknown; stdout?: unknown } | null | undefined;
  if (!data || typeof data !== 'object') return env;
  const code = data.exitCode;
  if (typeof code !== 'number' || code === 0) return env;

  const stderr = typeof data.stderr === 'string' ? data.stderr.trim() : '';
  const stdout = typeof data.stdout === 'string' ? data.stdout.trim() : '';
  // 只取未超长的尾部片段，避免把整段输出塞进错误信息
  const detail = (stderr || stdout).slice(-600);
  const isTimeout = code === 124;
  return {
    ...env,
    ok: false,
    // data 原样保留：stdout/stderr/spillPath 等仍然可用（卡片「结果」区、模型回注都需要）
    data: env.data,
    error: {
      code: isTimeout ? ErrorCode.TERM_TIMEOUT : ErrorCode.CMD_REJECTED,
      message:
        (isTimeout
          ? `terminal 命令超时（超过 timeoutMs，已强制终止，exitCode=124）。`
          : `terminal 命令以非零退出码结束（exitCode=${code}）。`) +
        (detail ? `输出尾部：${detail}` : '（无输出）') +
        '请修正命令或换一种方式后重试；不要假设该命令已成功。',
    },
  };
}

/**
 * write 参数归一化：不同厂商模型会产出异构 edits 结构，统一收敛到 sidecar 契约
 * （{path, create, baselineHash, edits:[{oldText,newText}|{insertAfter,newText}|{insertBefore,newText}]}）。
 * 已知异构形态：
 *  - edits 被序列化成 JSON 字符串（Agnes 等）
 *  - edits 项用 startLine/endLine/contentLines（Agnes 行区间形态）
 *  - edits 项用 lines/line/content（其他形态）
 *  - 文本字段嵌在 edit.text / edit.content
 * 归一化失败时返回 null，由调用方给出可自纠的错误信息。
 */
export function normalizeWriteParams(raw: unknown): WriteParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;

  // path 必填（缺失直接判定失败，避免产出 "undefined" 路径）
  const path = typeof p.path === 'string' ? p.path.trim() : '';
  if (!path) return null;

  let editsRaw: unknown = p.edits;
  if (typeof editsRaw === 'string') {
    try {
      editsRaw = JSON.parse(editsRaw);
    } catch {
      // 字符串但不是 JSON：当作单条 newText 整文件内容
      editsRaw = [{ newText: editsRaw }];
    }
  }
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) return null;

  const edits: Array<Record<string, string>> = [];
  for (const item of editsRaw) {
    if (typeof item === 'string') {
      if (item.length > 0) edits.push({ newText: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;

    const oldText = firstString(e, ['oldText', 'old_text', 'old', 'search', 'find']);
    // newText 允许空串（新建空文件）；但只有**显式给了 newText 键**才算识别到编辑项，
    // 避免把 {"foo":"bar"} 这种未知形态误当空文件写入。
    const hasNewKey = ['newText', 'new_text', 'new', 'replace', 'content', 'text'].some((k) => typeof e[k] === 'string');
    const newText = hasNewKey
      ? firstStringAllowEmpty(e, ['newText', 'new_text', 'new', 'replace', 'content', 'text'])
      : undefined;
    const insertAfter = firstString(e, ['insertAfter', 'insert_after', 'after']);
    const insertBefore = firstString(e, ['insertBefore', 'insert_before', 'before']);

    // 锚点插入优先（无 oldText 时）
    if (!oldText && insertAfter) {
      edits.push({ insertAfter, newText: newText ?? '' });
      continue;
    }
    if (!oldText && insertBefore) {
      edits.push({ insertBefore, newText: newText ?? '' });
      continue;
    }
    if (oldText) {
      // 有 oldText：精确替换（sidecar 依赖此分支定位）
      edits.push({ oldText, newText: newText ?? '' });
      continue;
    }
    if (newText !== undefined) {
      // 只有 newText：新建文件内容（走 create 拼接分支）
      edits.push({ newText });
      continue;
    }

    // 行区间形态：startLine/endLine + contentLines（或 lines 数组）
    const lines = toStringArray(e['contentLines']) ?? toStringArray(e['lines']);
    if (lines) {
      const oldLines = toStringArray(e['oldLines']);
      if (oldLines) {
        edits.push({ oldText: oldLines.join('\n'), newText: lines.join('\n') });
        continue;
      }
      // 无 oldLines：无法定位锚点。**不得在此臆造 create 语义** ——
      // 旧实现给该项打 __append 标记并强制 create=true，导致对「已存在文件」使用
      // 行区间参数时，patch.rs 判定 overwrite_existing 走整文件覆盖分支：
      // 文件被替换为仅含目标行的内容（其余内容静默丢失），且 create 路径不做
      // baselineHash 校验，并发写保护被一并绕过（严重数据丢失，已 PoC 复现）。
      // 改为打普通 __append 标记，由下方按 create 真值分流处理。
      edits.push({ __append: '1', newText: lines.join('\n') });
    }
  }

  if (edits.length === 0) return null;

  // create 真值三态：
  //   true  → 调用方显式声明「新建或整体覆盖」，__append 可安全拼接为整文件内容；
  //   false → 调用方显式声明「编辑已有文件」，行区间无原文无法定位 → 拒绝，
  //           回注可自纠的错误（禁止静默覆盖，避免数据丢失）；
  //   undefined → 未声明：若存在 __append（全文件内容语义）视为新建意图（create=true），
  //           否则不注入 create（让 sidecar 按编辑模式处理，其缺 hash 检查语义不变）。
  const requestedCreate = typeof p.create === 'boolean' ? p.create : undefined;
  const hasAppend = edits.some((e) => e['__append'] === '1');

  let finalEdits: Array<Record<string, string>> = edits;
  let create: boolean | undefined = requestedCreate;

  if (hasAppend) {
    if (requestedCreate === false) {
      // 显式编辑语义 + 行区间无原文 → 无法确定替换范围，拒绝（不猜、不覆盖）
      return null;
    }
    // 新建 / 未声明 / 声明覆盖：拼接为完整文件内容
    finalEdits = [{ newText: edits.map((e) => e.newText ?? '').join('\n') }];
    create = true;
  }

  const baselineHash = firstString(p, ['baselineHash', 'baseline_hash']);

  return {
    path,
    edits: finalEdits as unknown as WriteParams['edits'],
    create,
    baselineHash,
  } as WriteParams;
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * 与 firstString 相同，但允许空字符串。
 * 仅用于 `newText`：「新建空文件」是合法意图（edits:[{newText:""}]），
 * 若按 firstString 过滤掉空串，会被误判为「无可识别编辑项」而拒绝。
 */
function firstStringAllowEmpty(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/** 角色工具矩阵（M3）：唯一来源 crew/roles.ts ROLE_DEFS */
function roleTools(role: CrewRole): Set<string> {
  return new Set(ROLE_DEFS[role]?.tools ?? []);
}

/** 参数摘要（审计与卡片展示用，截断长文本）
 * 注意：在任意字符位置切断 JSON 后拼接引号几乎必然不是合法 JSON，
 * 曾导致 JSON.parse 抛错 → 工具结果被误判为失败（文件其实已写成功）。
 * 因此必须 try/catch 兜底，失败时退化为带 __summary 的纯文本摘要。
 */
export function summarize(params: unknown): unknown {
  const s = JSON.stringify(params);
  if (s && s.length > 500) {
    try {
      return JSON.parse(s.slice(0, 500) + '"…"');
    } catch {
      return { __summary: s.slice(0, 500) + '…' };
    }
  }
  return params;
}
