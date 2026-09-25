// 简单日志：stdout（开发）+ 文件（数据目录 logs）
import * as fs from 'fs';
import * as path from 'path';

let logDir: string | null = null;

export function setLogDir(dir: string): void {
  logDir = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function write(level: string, msg: string, data?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data !== undefined ? ' ' + safeJson(data) : ''}`;
  if (process.env.CODARA_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (logDir) {
    try {
      fs.appendFileSync(path.join(logDir, 'codara-main.log'), line + '\n');
    } catch {
      /* ignore */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return '[unserializable]';
  }
}

export const logger = {
  info: (msg: string, data?: unknown) => write('INFO', msg, data),
  warn: (msg: string, data?: unknown) => write('WARN', msg, data),
  error: (msg: string, data?: unknown) => write('ERROR', msg, data),
};
