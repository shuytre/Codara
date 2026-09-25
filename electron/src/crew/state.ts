// 双层状态机 + 任务工作区（.codara/tasks/<id>/）持久化。
// task.json / artifacts 落盘由主进程编排（Node fs），快照/审计仍走 sidecar。
import * as fs from 'fs';
import * as path from 'path';

import {
  canTransitionInstance,
  canTransitionTask,
  CrewArtifact,
  InstanceStatus,
  TaskStatus,
} from '@codara/contract';

export class StateTransitionError extends Error {
  constructor(public readonly kind: 'task' | 'instance', public readonly from: string, public readonly to: string) {
    super(`invalid ${kind} transition: ${from} → ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== to && !canTransitionTask(from, to)) {
    throw new StateTransitionError('task', from, to);
  }
}

export function assertInstanceTransition(from: InstanceStatus, to: InstanceStatus): void {
  if (from !== to && !canTransitionInstance(from, to)) {
    throw new StateTransitionError('instance', from, to);
  }
}

export interface TaskJson {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

/** 任务工作区：.codara/tasks/<task-id>/{task.json, artifacts/, logs/} */
export class TaskWorkspace {
  constructor(public readonly root: string) {}

  taskDir(taskId: string): string {
    return path.join(this.root, '.codara', 'tasks', taskId);
  }

  createTask(taskId: string, title: string): TaskJson {
    const dir = this.taskDir(taskId);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const now = Date.now();
    const t: TaskJson = { id: taskId, title, status: 'NEW', createdAt: now, updatedAt: now };
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(t, null, 2));
    return t;
  }

  readTask(taskId: string): TaskJson | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.taskDir(taskId), 'task.json'), 'utf-8')) as TaskJson;
    } catch {
      return null;
    }
  }

  writeTaskStatus(taskId: string, to: TaskStatus): TaskJson {
    const t = this.readTask(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    assertTaskTransition(t.status, to);
    t.status = to;
    t.updatedAt = Date.now();
    fs.writeFileSync(path.join(this.taskDir(taskId), 'task.json'), JSON.stringify(t, null, 2));
    return t;
  }

  saveArtifact(taskId: string, artifact: CrewArtifact): string {
    const dir = this.taskDir(taskId);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    const file = path.join(dir, 'artifacts', `${artifact.type}-v${artifact.version}-${artifact.instanceId ?? 'adhoc'}.md`);
    fs.writeFileSync(file, artifact.body);
    // 同时登记到 db（artifacts 表）由调用方经 sidecar db.exec 完成；这里只落盘
    return file;
  }

  listArtifacts(taskId: string): string[] {
    try {
      return fs.readdirSync(path.join(this.taskDir(taskId), 'artifacts'));
    } catch {
      return [];
    }
  }
}
