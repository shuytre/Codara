// 记忆加载（规格 7.6 / 4.5）：全局 + 项目两层；文件级 8KB 上限；任何读取失败静默降级为空。
// 记忆缺失不得阻塞主流程（与设置写入同级的容错口径）。
import { globalMemoryPath, projectMemoryPath } from './paths';
import { readCapped } from './parse';

export interface MemoryBundle {
  /** 全局记忆正文；'' 表示无 */
  global: string;
  /** 项目记忆正文；'' 表示无 */
  project: string;
}

/** 加载两层记忆。workspaceRoot 为空时只加载全局层。 */
export function loadMemory(workspaceRoot?: string): MemoryBundle {
  const global = readCapped(globalMemoryPath()) ?? '';
  let project = '';
  if (workspaceRoot) {
    project = readCapped(projectMemoryPath(workspaceRoot)) ?? '';
  }
  return { global, project };
}
