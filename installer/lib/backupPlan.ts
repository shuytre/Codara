// 升级前数据备份与回滚计划（规格 7.8）：
// - 升级前备份 per-user 数据目录（任务库/配置/快照/凭据）→ 同级 .bak-<ver>
// - 回滚清单（rollback manifest）落盘，升级失败可回退
// - 卸载可选保留数据（NSIS 卸载页按 keepData 传参清理）

import * as fs from 'fs';
import * as path from 'path';

/** per-user 数据目录内必须备份的项（规格 7.8：任务库/配置/快照/凭据） */
export const BACKUP_ITEMS = ['db', 'settings.json', 'snapshots', 'credentials'] as const;

export interface BackupPlan {
  source: string;
  target: string;
  version: string;
  items: string[];
  manifest: string;
}

export interface RollbackEntry {
  item: string;
  src: string;
  dst: string;
  bytes: number;
}

/** 生成备份计划：target = <appData>.bak-<version>（已存在时追加时间戳） */
export function planBackup(appDataDir: string, newVersion: string, existingDirs?: string[]): BackupPlan {
  let target = `${appDataDir}.bak-${newVersion}`;
  const taken = new Set(existingDirs ?? []);
  if (taken.has(target) || fs.existsSync(target)) {
    target = `${target}-${Date.now()}`;
  }
  return {
    source: appDataDir,
    target,
    version: newVersion,
    items: [...BACKUP_ITEMS],
    manifest: path.join(target, 'rollback-manifest.json'),
  };
}

/** 生成回滚清单条目（复制源 → 目标的逐项映射；缺失项跳过） */
export function buildRollbackEntries(plan: BackupPlan): RollbackEntry[] {
  const entries: RollbackEntry[] = [];
  for (const item of plan.items) {
    const src = path.join(plan.source, item);
    const dst = path.join(plan.target, item);
    try {
      const st = fs.statSync(src);
      entries.push({ item, src, dst, bytes: st.size });
    } catch {
      // 源项不存在（首次安装未生成）：不进清单
    }
  }
  return entries;
}

/** 执行备份复制 + 落盘回滚清单；任一项失败即抛出（调用方中止升级） */
export function executeBackup(plan: BackupPlan): RollbackEntry[] {
  const entries = buildRollbackEntries(plan);
  fs.mkdirSync(plan.target, { recursive: true });
  for (const e of entries) {
    fs.cpSync(e.src, e.dst, { recursive: true });
  }
  fs.writeFileSync(plan.manifest, JSON.stringify({ version: plan.version, entries }, null, 2), 'utf-8');
  return entries;
}

/** 回滚计划：备份内容还原回数据目录（升级失败口径） */
export function planRollback(plan: BackupPlan): { from: string; to: string; items: string[] } {
  return { from: plan.target, to: plan.source, items: plan.items };
}

/** 卸载清理决策：keepData=true 时保留数据目录；否则全清（规格 7.8 卸载可选择保留） */
export function uninstallCleanup(appDataDir: string, keepData: boolean): { remove: string[]; keep: string[] } {
  if (keepData) {
    return { remove: [], keep: [appDataDir] };
  }
  return { remove: [appDataDir], keep: [] };
}
