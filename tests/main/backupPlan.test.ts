// M6: backupPlan 单测（备份计划 / 回滚清单 / 卸载保留）
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_ITEMS,
  buildRollbackEntries,
  executeBackup,
  planBackup,
  planRollback,
  uninstallCleanup,
} from '../../installer/lib/backupPlan';

let base: string;
let appData: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'codara-bak-'));
  appData = path.join(base, 'Codara');
  fs.mkdirSync(appData);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('planBackup', () => {
  it('target 为同级 .bak-<ver>，覆盖四类数据项', () => {
    const plan = planBackup(appData, '1.2.0');
    expect(plan.target).toBe(`${appData}.bak-1.2.0`);
    expect(plan.items).toEqual([...BACKUP_ITEMS]);
    expect(plan.manifest).toBe(path.join(plan.target, 'rollback-manifest.json'));
  });

  it('同名备份目录已存在（磁盘检测）→ 追加时间戳避让', () => {
    fs.mkdirSync(`${appData}.bak-1.2.0`);
    const plan = planBackup(appData, '1.2.0');
    expect(plan.target).toMatch(/\.bak-1\.2\.0-\d+$/);
  });

  it('调用方传入已有目录清单时同样避让', () => {
    const plan = planBackup(appData, '1.2.0', [`${appData}.bak-1.2.0`]);
    expect(plan.target).toMatch(/-\d+$/);
  });
});

describe('buildRollbackEntries', () => {
  it('存在的项进清单（含字节量），缺失项跳过', () => {
    fs.writeFileSync(path.join(appData, 'settings.json'), '{}');
    fs.mkdirSync(path.join(appData, 'db'));
    fs.writeFileSync(path.join(appData, 'db', 'tasks.sqlite'), 'x');
    const plan = planBackup(appData, '1.2.0');
    const entries = buildRollbackEntries(plan);
    const items = entries.map((e) => e.item).sort();
    expect(items).toEqual(['db', 'settings.json']);
    const settings = entries.find((e) => e.item === 'settings.json')!;
    expect(settings.bytes).toBe(2);
    expect(settings.dst.startsWith(plan.target)).toBe(true);
  });
});

describe('executeBackup', () => {
  it('复制内容到备份目录并落盘回滚清单', () => {
    fs.writeFileSync(path.join(appData, 'settings.json'), '{"a":1}');
    fs.mkdirSync(path.join(appData, 'credentials'));
    fs.writeFileSync(path.join(appData, 'credentials', 'key.bin'), 'k');
    const plan = planBackup(appData, '2.0.0');
    const entries = executeBackup(plan);
    expect(entries.length).toBe(2);
    expect(fs.readFileSync(path.join(plan.target, 'settings.json'), 'utf-8')).toBe('{"a":1}');
    expect(fs.existsSync(path.join(plan.target, 'credentials', 'key.bin'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(plan.manifest, 'utf-8')) as {
      version: string;
      entries: Array<{ item: string }>;
    };
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.entries).toHaveLength(2);
  });
});

describe('planRollback', () => {
  it('回滚方向：备份 → 数据目录', () => {
    const plan = planBackup(appData, '2.0.0');
    const rb = planRollback(plan);
    expect(rb.from).toBe(plan.target);
    expect(rb.to).toBe(appData);
    expect(rb.items).toEqual([...BACKUP_ITEMS]);
  });
});

describe('uninstallCleanup', () => {
  it('keepData=true：保留数据目录不删', () => {
    expect(uninstallCleanup(appData, true)).toEqual({ remove: [], keep: [appData] });
  });
  it('keepData=false：全清', () => {
    expect(uninstallCleanup(appData, false)).toEqual({ remove: [appData], keep: [] });
  });
});
