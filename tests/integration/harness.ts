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
  private waiters: Array<(msg: any) => void> = [];

  async start(workspaceRoot: string): Promise<void> {
    // 优先 release 构建，其次 debug
    const candidates = [
      path.join(__dirname, '../../sidecar/target/release/codara-sidecar'),
      path.join(__dirname, '../../sidecar/target/debug/codara-sidecar'),
    ];
    const bin = candidates.find((p) => fs.existsSync(p));
    if (!bin) throw new Error('sidecar binary not found; run cargo build first');
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
          const w = this.waiters.shift();
          if (w) w(msg);
        } catch {
          // 坏帧跳过
        }
      }
    });
    await this.call('initialize', { workspaceRoot, appDataDir: path.join(workspaceRoot, '.codara'), gitPath: 'git' });
  }

  call(method: string, params: unknown, timeoutMs = 15000): Promise<CallResult> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sidecar call timeout: ${method}`)), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg as CallResult);
      });
      this.proc.stdin!.write(frame + '\n');
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
