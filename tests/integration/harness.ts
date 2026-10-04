// 集成测试共享工具：spawn 真实 sidecar 子进程（stdio 行分隔 JSON-RPC）
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CallResult {
  id: number;
  result: {
    ok: boolean;
    data?: any;
    error?: { code: number; message: string; data?: any };
    truncated?: boolean;
    cacheRef?: string;
    cache?: string;
    message?: string;
  };
}

export class SidecarHarness {
  proc!: ChildProcess;
  private nextId = 1;
  private buffer = '';
  /**
   * 按 **id** 配对响应，而不是按到达顺序 shift 队列。
   *
   * 第 6 轮（sidecar 并行）：请求循环改为每请求一 worker，响应可以乱序到达
   * （JSON-RPC 本就靠 id 配对）。原实现 `this.waiters.shift()` 假设严格 FIFO，
   * 一旦乱序就把 A 的结果交给 B 的等待点 —— 表现为「测试随机失败」，
   * 且会掩盖真实的并发问题。这里必须按 id 索引。
   */
  private waiters = new Map<number, (msg: any) => void>();
  /**
   * 已到达但还没有等待者认领的响应。
   *
   * `send()` 先写帧、`await_()` 后注册等待点，中间存在一个窗口：worker 足够快时
   * 响应会在 `await_` 之前就到达 stdout，被解析后找不到等待者而丢弃 —— 表现为
   * 「并发测试偶发超时」。这里把无主响应暂存，`await_` 时补领。
   */
  private orphans = new Map<number, any>();

  /**
   * 显式选择 sidecar 二进制。
   *
   * 之前是「release 存在就用 release，否则用 debug」—— 静默偏向。代价很实在：
   * 改完 sidecar 只跑了 `cargo build`（debug），集成测试却仍加载**上次 release**
   * 的旧二进制，于是并发测试全红，而根因离测试十万八千里（是二进制过期，不是代码错）。
   * 现在把选择权交给环境变量，默认仍然优先 release（与 CI 的构建方式一致），
   * 但会把自己的选择打印出来 —— 排查时第一眼就能看见测的是哪个二进制。
   */
  static pickBinary(): string {
    const explicit = process.env.CODARA_SIDECAR_BIN;
    const candidates = explicit
      ? [explicit]
      : [
          path.join(__dirname, '../../sidecar/target/release/codara-sidecar'),
          path.join(__dirname, '../../sidecar/target/debug/codara-sidecar'),
        ];
    const bin = candidates.find((p) => fs.existsSync(p));
    if (!bin) throw new Error(`sidecar binary not found; run cargo build first (looked: ${candidates.join(', ')})`);
    // 每个用例都起一个 harness，只打第一次 —— 排查时要看到路径和 mtime，
    // 但重复 20 次会把真正的失败输出淹掉。
    if (!SidecarHarness.reported) {
      // eslint-disable-next-line no-console
      console.log(`[harness] sidecar binary: ${bin} (built ${fs.statSync(bin).mtime.toISOString()})`);
      SidecarHarness.reported = true;
    }
    return bin;
  }
  private static reported = false;

  async start(workspaceRoot: string): Promise<void> {
    const bin = SidecarHarness.pickBinary();
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const w = this.waiters.get(msg.id);
          if (w) {
            this.waiters.delete(msg.id);
            w(msg);
          } else {
            // 先到后等：暂存，避免并发测试偶发超时
            this.orphans.set(msg.id, msg);
          }
        } catch {
          // 坏帧跳过
        }
      }
    });
    await this.call('initialize', { workspaceRoot, appDataDir: path.join(workspaceRoot, '.codara'), gitPath: 'git' });
  }

  /** 按 id 索引等待点（响应乱序安全） */
  call(method: string, params: unknown, timeoutMs = 15000): Promise<CallResult> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`sidecar call timeout: ${method} (id=${id})`));
      }, timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as CallResult);
      });
      this.proc.stdin!.write(frame + '\n');
    });
  }

  /** 发出请求但不等待响应（并发测试用：先全部发出，再统一收集） */
  send(method: string, params: unknown): number {
    const id = this.nextId++;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  }

  /** 等待指定 id 的响应（响应已先到达也能补领） */
  await_(id: number, timeoutMs = 15000): Promise<CallResult> {
    const early = this.orphans.get(id);
    if (early) {
      this.orphans.delete(id);
      return Promise.resolve(early as CallResult);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`sidecar response timeout: id=${id}`));
      }, timeoutMs);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg as CallResult);
      });
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
    }
  }
}

export function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codara-test-'));
}
