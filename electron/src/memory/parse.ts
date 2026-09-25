// 记忆文件解析：按 `## 标题` 切章节；单文件 8KB 读取上限（token 膨胀防护）。
// 读取超限文件时截断到上限（而非拒绝），保证记忆始终可用。
import * as fs from 'fs';

/** 单个记忆文件读取上限（字节） */
export const MEMORY_FILE_LIMIT_BYTES = 8 * 1024;

export interface MemorySection {
  /** 章节标题（不含 `## ` 前缀）；文件开头的无标题前导内容 title 为 '' */
  title: string;
  body: string;
}

/**
 * 读取文件前 limit 字节（UTF-8）；文件不存在/不可读返回 null。
 * 用 open+read 而非 readFile，避免超大文件整体进内存。
 */
export function readCapped(file: string, limit: number = MEMORY_FILE_LIMIT_BYTES): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, limit);
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, read);
        if (n <= 0) break;
        read += n;
      }
      return buf.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 按 `## 标题` 切分章节；连续结构无损（renderSections 可还原）。 */
export function splitSections(text: string): MemorySection[] {
  const out: MemorySection[] = [];
  let cur: MemorySection | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (cur) out.push(cur);
      cur = { title: line.slice(3).trim(), body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    } else {
      cur = { title: '', body: line + '\n' };
    }
  }
  if (cur) out.push(cur);
  // 丢弃完全空白的章节
  return out.filter((s) => s.title !== '' || s.body.trim() !== '');
}

/** 章节列表还原为 Markdown 文本。 */
export function renderSections(sections: MemorySection[]): string {
  return sections
    .map((s) => (s.title ? `## ${s.title}\n${s.body.trimEnd()}` : s.body.trimEnd()))
    .join('\n\n')
    .trim();
}

/** 追加一个带标题的章节到文本（已存在同名标题则原样返回，幂等）。 */
export function appendSection(text: string, title: string, body: string): string {
  if (splitSections(text).some((s) => s.title === title)) return text;
  const block = `## ${title}\n${body.trim()}`;
  const base = text.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
