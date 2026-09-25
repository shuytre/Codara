// 兼容导入（规格 7.6）：.codex/AGENTS.md、.workbuddy/memory/MEMORY.md → 项目 AGENTS.md。
// 一次性向导：导入标记 memoryImported 存 settingsStore；即使标记丢失，同名章节幂等跳过防重复灌入。
import * as fs from 'fs';
import * as path from 'path';

import { appendSection, readCapped, MEMORY_FILE_LIMIT_BYTES } from './parse';
import { projectMemoryPath } from './paths';

export interface ImportSource {
  /** 相对项目根的源文件路径 */
  file: string;
  /** 来源标识（写入章节标题与导入说明） */
  label: string;
}

export const IMPORT_SOURCES: ImportSource[] = [
  { file: path.join('.codex', 'AGENTS.md'), label: 'Codex' },
  { file: path.join('.workbuddy', 'memory', 'MEMORY.md'), label: 'WorkBuddy' },
];

/** 检测可导入的源文件（存在且非空的才返回）。 */
export function detectImportable(root: string): ImportSource[] {
  return IMPORT_SOURCES.filter((src) => {
    const full = path.join(root, src.file);
    return readCapped(full) != null && readCapped(full)!.trim() !== '';
  });
}

export interface ImportResult {
  imported: string[];
  target: string;
  skipped: string[];
}

/**
 * 执行导入：每个源文件内容作为独立章节（`## 来自 <label> 的记忆`）追加到项目 AGENTS.md。
 * 目标文件不存在时创建（带头部说明）。同名章节已存在则跳过（幂等）。
 */
export function importMemory(root: string): ImportResult {
  const target = projectMemoryPath(root);
  let current = readCapped(target) ?? '';
  if (!current.trim()) {
    current = '# 项目记忆\n\n由 Codara 记忆体系维护；可手工编辑，`## ` 标题作为章节。\n';
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const src of detectImportable(root)) {
    const body = readCapped(path.join(root, src.file), MEMORY_FILE_LIMIT_BYTES)?.trim() ?? '';
    if (!body) continue;
    const before = current;
    current = appendSection(current, `来自 ${src.label} 的记忆`, body);
    if (current === before) {
      skipped.push(src.file);
    } else {
      imported.push(src.file);
    }
  }
  if (imported.length > 0) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, current, 'utf-8');
  }
  return { imported, skipped, target };
}
