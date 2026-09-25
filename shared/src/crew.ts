/**
 * M3 专家团契约：角色枚举、双层状态机、Task Packet / Artifact schema。
 * 单一来源：sidecar（db 表）、主进程（调度器）、渲染层（角色树）共用。
 */

export type CrewRole =
  | 'coordinator'
  | 'architect'
  | 'developer'
  | 'reviewer'
  | 'tester'
  | 'builder'
  | 'researcher';

export const CREW_ROLES: CrewRole[] = [
  'coordinator', 'architect', 'developer', 'reviewer', 'tester', 'builder', 'researcher',
];

/** 任务级状态机（规格 4.4） */
export type TaskStatus =
  | 'NEW' | 'PLANNED' | 'APPROVED' | 'IN_PROGRESS'
  | 'REVIEW' | 'TESTING' | 'DONE' | 'BLOCKED' | 'ROLLED_BACK';

/** 角色实例级状态机（规格 4.4） */
export type InstanceStatus =
  | 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_BUDGET'
  | 'SUBMITTED' | 'CLOSED' | 'FAILED';

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  NEW: ['PLANNED', 'BLOCKED'],
  PLANNED: ['APPROVED', 'BLOCKED'],
  APPROVED: ['IN_PROGRESS', 'BLOCKED'],
  IN_PROGRESS: ['REVIEW', 'TESTING', 'BLOCKED'],
  REVIEW: ['IN_PROGRESS', 'TESTING', 'BLOCKED'],
  TESTING: ['DONE', 'REVIEW', 'BLOCKED'],
  DONE: ['ROLLED_BACK'],
  BLOCKED: ['IN_PROGRESS', 'PLANNED', 'ROLLED_BACK'],
  ROLLED_BACK: [],
};

export const INSTANCE_TRANSITIONS: Record<InstanceStatus, InstanceStatus[]> = {
  QUEUED: ['RUNNING', 'CLOSED'],
  RUNNING: ['WAITING_APPROVAL', 'WAITING_BUDGET', 'SUBMITTED', 'FAILED', 'CLOSED'],
  WAITING_APPROVAL: ['RUNNING', 'FAILED', 'CLOSED'],
  WAITING_BUDGET: ['RUNNING', 'FAILED', 'CLOSED'],
  SUBMITTED: ['CLOSED'],
  CLOSED: [],
  FAILED: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionInstance(from: InstanceStatus, to: InstanceStatus): boolean {
  return INSTANCE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Task Packet schema（规格 4.3） */
export interface TaskPacket {
  role: CrewRole;
  goal: string;
  acceptanceCriteria?: string[];
  /** 文件范围白名单（相对路径 glob） */
  fileScope?: string[];
  /** 上游交接物 ID 列表（最小上下文原则） */
  upstreamArtifacts?: string[];
  contextBudgetTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  maxTurns?: number;
}

/** 交接物 schema（规格 4.3） */
export interface CrewArtifact {
  id: string;
  taskId: string;
  instanceId?: string;
  type: 'plan' | 'patch-set' | 'review' | 'acceptance' | 'build-report' | 'research';
  authorRole: CrewRole;
  version: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  body: string;
  refs?: string[];
}

/** 渲染层角色会话树节点（左栏，监督可见性） */
export interface CrewInstanceView {
  instanceId: string;
  taskId: string;
  taskTitle?: string;
  role: CrewRole;
  status: InstanceStatus;
  startedAt?: number;
  endedAt?: number;
  turns?: number;
  promptTokens?: number;
  completionTokens?: number;
  currentAction?: string;
}

/** 任务概要 */
export interface CrewTaskView {
  taskId: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  instances: CrewInstanceView[];
}
