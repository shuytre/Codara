// 记忆注入（规格 4.5 / 4.8）：
// - 全局/项目记忆统一拼接进 systemPrompt，注入所有角色（会话历史仍隔离）。
// - 沙箱"自动审查"临时技术会话（sandbox=true）跳过项目记忆正文（规格 4.8），全局记忆保留。
// 注入块使用独立分隔，提示词主体（roles.ts 7 角色 + 极简三变体）不做任何改动。
import type { MemoryBundle } from './load';

export interface InjectOptions {
  /** 沙箱临时会话：跳过项目记忆正文 */
  sandbox?: boolean;
}

export function withMemory(
  systemPrompt: string,
  mem: MemoryBundle | null | undefined,
  opts: InjectOptions = {}
): string {
  if (!mem) return systemPrompt;
  const g = mem.global.trim();
  const p = opts.sandbox ? '' : mem.project.trim();
  const parts: string[] = [];
  if (g) parts.push(`### 全局记忆\n\n${g}`);
  if (p) parts.push(`### 项目记忆\n\n${p}`);
  if (parts.length === 0) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n---\n\n# 记忆（自动注入，请遵循）\n\n${parts.join('\n\n')}`;
}
