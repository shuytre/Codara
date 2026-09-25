// 工具运行时管道：schema 校验 → 角色矩阵 → 权限网关 → sidecar RPC → 审计 → 预算 tick
import {
  CrewRole,
  Envelope,
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
    private readonly scheduler?: CrewSchedulerLike
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
        description: '补丁式写入（唯一写通道）。edits 数组：oldText/newText 精确替换或 insertAfter/insertBefore 锚点插入。新建文件必须 create=true。写入前基线哈希校验。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  oldText: { type: 'string' },
                  newText: { type: 'string' },
                  insertAfter: { type: 'string' },
                  insertBefore: { type: 'string' },
                },
              },
            },
            create: { type: 'boolean', description: '新建文件必须 true' },
            baselineHash: { type: 'string', description: '最近一次 read 返回的 baselineHash' },
          },
          required: ['path', 'edits'],
        },
      },
      {
        name: 'terminal',
        description: '终端执行（持久会话）。单条命令；禁止 && / ; 长链；管道仅限简单 findstr。默认 cmd.exe。超时默认 30s 上限 300s。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
            timeoutMs: { type: 'number' },
            input: { type: 'string' },
            sessionId: { type: 'string' },
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

  /** 执行工具调用（完整管道）。role 存在时强制角色工具矩阵（越权 4002） */
  async execute(tool: string, params: unknown, mode: 'ask' | 'plan' | 'goal' = 'plan', role?: CrewRole): Promise<ToolResult> {
    const started = Date.now();

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

    // Ask 模式禁用写类工具
    if (mode === 'ask' && (tool === 'write' || tool === 'terminal' || (tool === 'git' && isWriteOp(params)))) {
      return {
        ok: false,
        error: { code: 4002, message: `tool ${tool} is not allowed in Ask mode` },
        tool,
        params,
        durationMs: 0,
      };
    }

    // 权限网关：ask 级操作先审批
    const gate = await this.gateway.check(tool, params, mode);
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
        const p = params as WriteParams;
        // 写前预快照（fs.patch 成功后 sidecar 不自动快照，主进程编排）
        const target = (p as { path?: string }).path;
        if (target) {
          await this.sidecar.call('snap.create', { paths: [target], label: 'pre-patch', taskId: 'adhoc' }).catch(() => undefined);
        }
        env = await this.sidecar.call('fs.patch', p);
        break;
      }
      case 'terminal': {
        const p = params as TerminalParams;
        env = await this.sidecar.call('term.exec', p);
        break;
      }
      case 'git': {
        const p = params as GitParams;
        env = await this.sidecar.call('git.exec', p);
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

function isWriteOp(params: unknown): boolean {
  const op = (params as GitParams)?.op;
  return ['commit', 'branch-create', 'worktree-create', 'worktree-remove', 'revert'].includes(op || '');
}

/** 角色工具矩阵（M3）：唯一来源 crew/roles.ts ROLE_DEFS */
function roleTools(role: CrewRole): Set<string> {
  return new Set(ROLE_DEFS[role]?.tools ?? []);
}

/** 参数摘要（审计与卡片展示用，截断长文本） */
export function summarize(params: unknown): unknown {
  const s = JSON.stringify(params);
  if (s && s.length > 500) {
    return JSON.parse(s.slice(0, 500) + '"…"');
  }
  return params;
}
