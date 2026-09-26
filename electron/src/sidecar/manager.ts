// sidecar 托管：spawn 子进程、行分隔帧读写、请求-响应关联、事件通知分发、崩溃自动重启
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { Envelope, MAX_FRAME_BYTES, RpcRequest } from '@codara/contract';

import { logger } from '../util/logger';

type PendingEntry = {
  resolve: (e: Envelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class SidecarManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private readonly binaryCandidates: string[];
  private appDataDir: string;
  private restarting = false;
  /** 最近一次 initialize 的工作区根；崩溃重启后必须用它重新 initialize，
   *  否则新进程 workspace_root 为空，所有工具调用都会返回 INVALID_REQUEST。 */
  private workspaceRoot?: string;

  constructor(userDataDir: string) {
    super();
    this.appDataDir = userDataDir;
    this.binaryCandidates = [
      // 打包后：resources/bin/<triple>/codara-sidecar(.exe)
      path.join(process.resourcesPath || '', 'bin', platformTriple(), binName()),
      // 开发：仓库构建产物
      path.join(__dirname, '../../sidecar/target/release/codara-sidecar'),
      path.join(__dirname, '../../../sidecar/target/release/codara-sidecar'),
    ];
  }

  async start(): Promise<void> {
    const bin = this.binaryCandidates.find((p) => p && fs.existsSync(p));
    if (!bin) {
      throw new Error(`sidecar binary not found; candidates: ${this.binaryCandidates.join(', ')}`);
    }
    this.proc = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.on('exit', (code) => {
      logger.warn('sidecar exited', { code });
      this.rejectAllPending(new Error(`sidecar exited with ${code}`));
      if (!this.restarting && !this.stopped) {
        // 崩溃自动重启（一次）。必须 await 并 catch：
        // 原实现 .then() 无 catch，start() 失败会变成 unhandled rejection 且
        // restarting 永久为 true，此后任何崩溃都不再重启。
        // 重启后还要重新 initialize，否则新进程没有 workspaceRoot，工具全线报废。
        this.restarting = true;
        setTimeout(() => {
          void (async () => {
            try {
              await this.start();
              await this.initialize(this.workspaceRoot);
              logger.info('sidecar restarted and re-initialized');
            } catch (err) {
              logger.error('sidecar restart failed', err);
            } finally {
              this.restarting = false;
            }
          })();
        }, 500);
      }
    });
    const rl = readline.createInterface(this.proc.stdout!);
    rl.on('line', (line) => this.onFrame(line));
    this.proc.stderr!.on('data', (d) => logger.warn('sidecar stderr', { chunk: String(d).slice(0, 500) }));
  }

  private stopped = false;

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  private onFrame(line: string): void {
    if (line.length > MAX_FRAME_BYTES) {
      logger.warn('sidecar frame too large, dropped', { len: line.length });
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn('sidecar non-JSON frame', { head: line.slice(0, 200) });
      return;
    }
    if (msg.method === 'event') {
      this.emit('event', msg.params);
      return;
    }
    const id = msg.id as number;
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(msg.result as Envelope);
    }
  }

  /** initialize：工作区 + appDataDir 传递给 sidecar */
  async initialize(workspaceRoot?: string): Promise<Envelope> {
    if (workspaceRoot) this.workspaceRoot = workspaceRoot;
    return this.call('initialize', {
      workspaceRoot: workspaceRoot || undefined,
      appDataDir: path.join(this.appDataDir, 'workspace-meta'),
      gitPath: process.env.CODARA_GIT_PATH || 'git',
    });
  }

  async setWorkspace(workspaceRoot: string): Promise<Envelope> {
    return this.initialize(workspaceRoot);
  }

  call(method: string, params: unknown, timeoutMs = 300000): Promise<Envelope> {
    if (!this.proc || !this.proc.stdin) {
      return Promise.reject(new Error('sidecar not running'));
    }
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params: params as Record<string, string> };
    const frame = JSON.stringify(req);
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(new Error(`request frame exceeds ${MAX_FRAME_BYTES}`));
    }
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar call timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(frame + '\n');
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

function platformTriple(): string {
  switch (process.platform) {
    case 'win32':
      return 'x86_64-pc-windows-msvc';
    case 'darwin':
      return 'x86_64-apple-darwin';
    default:
      return 'x86_64-unknown-linux-gnu';
  }
}

function binName(): string {
  return process.platform === 'win32' ? 'codara-sidecar.exe' : 'codara-sidecar';
}
