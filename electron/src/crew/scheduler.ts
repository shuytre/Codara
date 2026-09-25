// 专家团调度器（M3）：任务/实例双层状态机、并发信号量（默认 2 可配）、
// 全局排队、实例驱动循环（复用 AgentLoop）、交接物落盘与登记、事件广播。
import * as fs from 'fs';
import * as path from 'path';

import {
  canTransitionInstance,
  CrewArtifact,
  CrewInstanceView,
  CrewRole,
  CrewTaskView,
  InstanceStatus,
  TaskPacket,
  TaskStatus,
} from '@codara/contract';

import { ModelClient } from '../model/client';
import { SidecarManager } from '../sidecar/manager';
import { SettingsStore } from '../config/settingsStore';
import { BudgetLedger } from '../budget/ledger';
import { AgentLoop } from '../loop/agentLoop';
import { ToolRuntime, CrewSchedulerLike } from '../tools/runtime';
import { Semaphore } from '../util/semaphore';
import { logger } from '../util/logger';
import { ROLE_DEFS, normalizePacket } from './roles';
import { TaskWorkspace } from './state';

interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
}

interface InstanceRecord {
  id: string;
  taskId: string;
  role: CrewRole;
  status: InstanceStatus;
  packet: TaskPacket;
  sessionId?: string;
  turns?: number;
  promptTokens?: number;
  completionTokens?: number;
  startedAt?: number;
  endedAt?: number;
  currentAction?: string;
}

/** 角色完成 → 任务级状态迁移（标准流转，规格 4.6） */
const ROLE_TASK_EXIT: Partial<Record<CrewRole, TaskStatus>> = {
  architect: 'PLANNED',
  developer: 'REVIEW',
  tester: 'DONE',
};

export class CrewScheduler implements CrewSchedulerLike {
  private tasks = new Map<string, TaskRecord>();
  private instances = new Map<string, InstanceRecord>();
  private queue: string[] = [];
  private readonly sem: Semaphore;
  private seq = 1;
  private workspace: TaskWorkspace | null = null;

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly model: ModelClient,
    private readonly budget: BudgetLedger,
    private readonly settings: SettingsStore,
    private readonly emit: (channel: string, payload: unknown) => void
  ) {
    this.sem = new Semaphore(this.maxConcurrent());
  }

  /** 打破构造循环依赖：ToolRuntime 构造需要本调度器，构造完成后反向注入 */
  private toolsRef: ToolRuntime | null = null;
  attachTools(tools: ToolRuntime): void {
    this.toolsRef = tools;
  }

  private get tools(): ToolRuntime {
    if (!this.toolsRef) throw new Error('CrewScheduler: tools not attached');
    return this.toolsRef;
  }

  private maxConcurrent(): number {
    // 规格 4.5：并发默认 2 可配 1-4，配置挂在 budget.concurrency
    const c = this.settings.get('budget').concurrency;
    return Math.max(1, Math.min(4, c ?? 2));
  }

  private ws(): TaskWorkspace {
    const root = this.settings.get('workspacePath');
    if (!root) throw new Error('workspace not configured');
    if (!this.workspace || this.workspace.root !== root) {
      this.workspace = new TaskWorkspace(root);
    }
    return this.workspace;
  }

  // ---- 任务层 ----

  async startTask(title: string): Promise<CrewTaskView> {
    const id = `task-${Date.now()}-${this.seq++}`;
    this.ws().createTask(id, title);
    const rec: TaskRecord = { id, title, status: 'NEW', createdAt: Date.now() };
    this.tasks.set(id, rec);
    this.emitTask(rec);
    return this.taskView(id);
  }

  taskView(taskId: string): CrewTaskView {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
      instances: [...this.instances.values()].filter((i) => i.taskId === taskId).map((i) => this.instanceView(i)),
    };
  }

  taskStatus(input: { taskId?: string }): Promise<unknown> {
    if (input.taskId) {
      return Promise.resolve(this.taskView(input.taskId));
    }
    return Promise.resolve({
      tasks: [...this.tasks.values()].map((t) => ({ taskId: t.id, title: t.title, status: t.status })),
      concurrency: { max: this.maxConcurrent(), pending: this.sem.pending },
    });
  }

  private setTaskStatus(taskId: string, to: TaskStatus): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    try {
      this.ws().writeTaskStatus(taskId, to);
      t.status = to;
      this.emitTask(t);
    } catch (e) {
      logger.warn('task transition rejected', { taskId, to, err: (e as Error).message });
    }
  }

  // ---- 实例层 ----

  async spawnInstance(input: {
    taskId: string; role: CrewRole; goal: string;
    acceptanceCriteria?: string[]; fileScope?: string[];
    upstreamArtifacts?: string[];
    effort?: 'low' | 'medium' | 'high'; maxTurns?: number;
  }): Promise<{ instanceId: string }> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    if (input.role === 'coordinator') throw new Error('cannot spawn coordinator instance');
    if (task.status === 'DONE' || task.status === 'ROLLED_BACK') {
      throw new Error(`task ${task.id} is terminal (${task.status})`);
    }
    // 首个实例派发：NEW → IN_PROGRESS（架构师先行也视为任务开工）
    if (task.status === 'NEW' || task.status === 'PLANNED' || task.status === 'APPROVED') {
      this.setTaskStatus(input.taskId, 'IN_PROGRESS');
    }

    const packet = normalizePacket({
      role: input.role,
      goal: input.goal,
      acceptanceCriteria: input.acceptanceCriteria,
      fileScope: input.fileScope,
      upstreamArtifacts: input.upstreamArtifacts,
      effort: input.effort,
      maxTurns: input.maxTurns,
    });
    const inst: InstanceRecord = {
      id: `inst-${Date.now()}-${this.seq++}`,
      taskId: input.taskId,
      role: input.role,
      status: 'QUEUED',
      packet,
    };
    this.instances.set(inst.id, inst);
    this.queue.push(inst.id);
    this.emitInstance(inst);
    void this.pump();
    return { instanceId: inst.id };
  }

  async handoff(input: { instanceId: string; toRole: CrewRole; goal: string; note?: string }): Promise<{ instanceId: string }> {
    const from = this.instances.get(input.instanceId);
    if (!from) throw new Error(`instance not found: ${input.instanceId}`);
    // 交接只带交接物与目标（最小上下文），不回放旧对话历史
    const upstream = this.listArtifactIds(from.taskId);
    return this.spawnInstance({
      taskId: from.taskId,
      role: input.toRole,
      goal: input.note ? `${input.goal}\n\n交接说明：${input.note}` : input.goal,
      upstreamArtifacts: upstream,
    });
  }

  async writeArtifact(input: { taskId: string; type: CrewArtifact['type']; body: string; refs?: string[] }): Promise<unknown> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    const version = this.listArtifacts(task.id).filter((f) => f.startsWith(input.type)).length + 1;
    const artifact: CrewArtifact = {
      id: `art-${Date.now()}-${this.seq++}`,
      taskId: task.id,
      type: input.type,
      authorRole: 'coordinator',
      version,
      status: 'submitted',
      body: input.body,
      refs: input.refs,
    };
    const file = this.ws().saveArtifact(task.id, artifact);
    await this.sidecar
      .call('db.exec', {
        sql: 'INSERT INTO artifacts (id, task_id, type, author_role, version, status, body, refs, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
        args: [artifact.id, task.id, artifact.type, artifact.authorRole, artifact.version, artifact.status, artifact.body, JSON.stringify(artifact.refs ?? []), String(Date.now())],
      })
      .catch(() => undefined);
    return { artifactId: artifact.id, file };
  }

  // ---- 驱动循环 ----

  private async pump(): Promise<void> {
    while (this.sem.available > 0 && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const release = await this.sem.acquire();
      void this.drive(id)
        .catch((e) => {
          logger.error('instance drive failed', { id, err: (e as Error).message });
          this.setInstanceStatus(id, 'FAILED');
        })
        .finally(() => {
          release();
          void this.pump();
        });
    }
  }

  private async drive(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.setInstanceStatus(instanceId, 'RUNNING');
    inst.startedAt = Date.now();

    // 会话创建（crew 会话绑定 role/task，隔离在 sidecar 强制）
    const sess = await this.sidecar.call('session.create', {
      kind: 'crew',
      role: inst.role,
      taskId: inst.taskId,
      title: `${ROLE_DEFS[inst.role].title} · ${inst.packet.goal.slice(0, 40)}`,
    });
    const sessData = sess.data as { sessionId?: string } | undefined;
    if (!sess.ok || !sessData?.sessionId) {
      throw new Error(`session.create failed: ${sess.error?.message ?? 'no sessionId'}`);
    }
    inst.sessionId = String(sessData.sessionId);

    // 上游交接物注入（最小上下文：只带正文摘要）
    const upstream = (inst.packet.upstreamArtifacts ?? [])
      .map((aid) => this.readArtifactBody(inst.taskId, aid))
      .filter(Boolean)
      .map((body) => `--- 交接物 ---\n${body}`)
      .join('\n\n');

    const goalText = [
      `【任务包】`,
      `目标：${inst.packet.goal}`,
      inst.packet.acceptanceCriteria?.length ? `验收标准：\n${inst.packet.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : '',
      inst.packet.fileScope?.length ? `文件范围白名单：${inst.packet.fileScope.join(', ')}` : '',
      `轮次上限：${inst.packet.maxTurns}；effort：${inst.packet.effort}`,
      upstream,
    ]
      .filter(Boolean)
      .join('\n\n');

    const loop = new AgentLoop(this.model, this.sidecar, this.settings, this.budget, this.tools);
    let finalText = '';
    let suspended = false;

    await loop.run(goalText, 'goal', {
      onDelta: () => {
        /* 实例输出不进主对话流；左栏树显示状态 */
        inst.currentAction = 'thinking';
        this.emitInstance(inst);
      },
      onCard: (card) => {
        this.emit('crew:card', { instanceId: inst.id, role: inst.role, card });
      },
      onDone: (text) => {
        finalText = text;
        inst.currentAction = 'done';
      },
      onBudgetSuspended: () => {
        suspended = true;
      },
    }, { role: inst.role, instanceId: inst.id, sessionId: inst.sessionId });

    if (suspended) {
      // 规格禁止静默续杯：置 WAITING_BUDGET 并广播，由用户决定续/终止（M4 接恢复流程）
      this.setInstanceStatus(instanceId, 'WAITING_BUDGET');
      return;
    }

    // 交接物落盘 + 登记（模型自述不作为验收通过依据；acceptance 以 Tester 退出码为准）
    const body = finalText || '(no output)';
    await this.writeArtifactAs(inst, body);
    this.setInstanceStatus(instanceId, 'SUBMITTED');
    inst.endedAt = Date.now();
    this.setInstanceStatus(instanceId, 'CLOSED');

    // 任务级状态迁移（标准流转）
    const exit = ROLE_TASK_EXIT[inst.role];
    if (exit) {
      this.setTaskStatus(inst.taskId, exit);
    }
  }

  private async writeArtifactAs(inst: InstanceRecord, body: string): Promise<void> {
    const def = ROLE_DEFS[inst.role];
    const version = this.listArtifacts(inst.taskId).filter((f) => f.startsWith(def.artifact.type)).length + 1;
    const artifact: CrewArtifact = {
      id: `art-${Date.now()}-${this.seq++}`,
      taskId: inst.taskId,
      instanceId: inst.id,
      type: def.artifact.type,
      authorRole: inst.role,
      version,
      status: 'submitted',
      body,
    };
    const file = this.ws().saveArtifact(inst.taskId, artifact);
    await this.sidecar
      .call('db.exec', {
        sql: 'INSERT INTO artifacts (id, task_id, instance_id, type, author_role, version, status, body, refs, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
        args: [artifact.id, inst.taskId, inst.id, artifact.type, artifact.authorRole, artifact.version, artifact.status, artifact.body, '[]', String(Date.now())],
      })
      .catch(() => undefined);
    this.emit('crew:artifact', { taskId: inst.taskId, instanceId: inst.id, artifactId: artifact.id, file, type: artifact.type });
  }

  // ---- 辅助 ----

  private listArtifacts(taskId: string): string[] {
    try {
      return this.ws().listArtifacts(taskId);
    } catch {
      return [];
    }
  }

  private listArtifactIds(taskId: string): string[] {
    // artifact ID 不直接映射文件名；交接以文件内容注入。保留 ID 列表用于 task.packet 记录
    return this.listArtifacts(taskId);
  }

  private readArtifactBody(taskId: string, artifactRef: string): string | null {
    try {
      const dir = path.join(this.ws().taskDir(taskId), 'artifacts');
      if (fs.existsSync(path.join(dir, artifactRef))) {
        return fs.readFileSync(path.join(dir, artifactRef), 'utf-8');
      }
      // 按前缀匹配
      const match = this.listArtifacts(taskId).find((f) => f.startsWith(artifactRef));
      if (match) {
        return fs.readFileSync(path.join(dir, match), 'utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  private setInstanceStatus(instanceId: string, to: InstanceStatus): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    if (inst.status !== to && !canTransitionInstance(inst.status, to)) {
      logger.warn('instance transition rejected', { instanceId, from: inst.status, to });
      return;
    }
    inst.status = to;
    this.emitInstance(inst);
  }

  private instanceView(i: InstanceRecord): CrewInstanceView {
    return {
      instanceId: i.id,
      taskId: i.taskId,
      role: i.role,
      status: i.status,
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      turns: i.turns,
      promptTokens: i.promptTokens,
      completionTokens: i.completionTokens,
      currentAction: i.currentAction,
    };
  }

  private emitInstance(i: InstanceRecord): void {
    this.emit('crew:instance', this.instanceView(i));
  }

  private emitTask(t: TaskRecord): void {
    this.emit('crew:task', { taskId: t.id, title: t.title, status: t.status });
  }
}
