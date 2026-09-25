// 记忆路径解析（规格 7.6）：全局 ~/.codara/AGENTS.md；项目根 AGENTS.md 与 .codara/
// Win7 对应 %USERPROFILE%\.codara\AGENTS.md（os.homedir() 在 Windows 上即 USERPROFILE）。
import * as os from 'os';
import * as path from 'path';

/** 全局记忆文件：%USERPROFILE%\.codara\AGENTS.md */
export function globalMemoryPath(): string {
  return path.join(os.homedir(), '.codara', 'AGENTS.md');
}

/** 项目记忆文件：<root>\AGENTS.md */
export function projectMemoryPath(root: string): string {
  return path.join(root, 'AGENTS.md');
}

/** 项目记忆目录：<root>\.codara（config、命令策略、角色定义等，M5 仅保证目录约定） */
export function projectMemoryDir(root: string): string {
  return path.join(root, '.codara');
}
