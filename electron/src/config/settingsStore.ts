// 设置存储：JSON 文件持久化 + schema 默认值 + 迁移
import * as fs from 'fs';
import * as path from 'path';

export interface SettingsShape {
  configured: boolean;
  provider: {
    templateId?: string;
    endpoint: string;
    model: string;
    /** 候选模型列表（向导/设置页在线拉取后勾选，可切换） */
    models?: string[];
    effort: 'fast' | 'balanced' | 'max';
    contextLength: number;
    timeoutMs: number;
    maxRetries: number;
    stripUnknown?: boolean;
    pricing: { promptPerM: number; completionPerM: number };
  };
  budget: {
    turnsLimit: number;
    tokenLimit?: number;
    costLimitCNY?: number;
    concurrency: number;
  };
  ui: { minimalMode: boolean; rightPaneVisible: boolean };
  workspacePath?: string;
  wizardCompleted: boolean;
  /** M5：兼容导入一次性向导已完成标记（规格 7.6） */
  memoryImported?: boolean;
}

const DEFAULTS: SettingsShape = {
  configured: false,
  provider: {
    endpoint: '',
    model: '',
    effort: 'balanced',
    contextLength: 128000,
    timeoutMs: 300000,
    maxRetries: 3,
    stripUnknown: false,
    pricing: { promptPerM: 2, completionPerM: 8 },
  },
  budget: {
    turnsLimit: 200, // 规格 #12：单任务 200 轮
    tokenLimit: undefined,
    costLimitCNY: undefined,
    concurrency: 2, // 规格 4.5：默认并发 2
  },
  ui: { minimalMode: false, rightPaneVisible: true },
  wizardCompleted: false,
};

export class SettingsStore {
  private data: SettingsShape;
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = this.load();
  }

  private load(): SettingsShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const merged: SettingsShape = {
        ...DEFAULTS,
        ...raw,
        provider: { ...DEFAULTS.provider, ...(raw.provider || {}) },
        budget: { ...DEFAULTS.budget, ...(raw.budget || {}) },
        ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
      };
      // 迁移：早期版本 120s 超时对慢速厂商（Agnes 长文生成）不足，统一抬到 300s
      if (merged.provider.timeoutMs === 120000) {
        merged.provider.timeoutMs = 300000;
      }
      return merged;
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  get<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
    return this.data[key];
  }

  getAll(): SettingsShape {
    return JSON.parse(JSON.stringify(this.data));
  }

  patch(partial: Partial<SettingsShape>): SettingsShape {
    if (partial.provider) {
      this.data.provider = { ...this.data.provider, ...partial.provider };
    }
    if (partial.budget) {
      this.data.budget = { ...this.data.budget, ...partial.budget };
    }
    if (partial.ui) {
      this.data.ui = { ...this.data.ui, ...partial.ui };
    }
    if (partial.configured !== undefined) this.data.configured = partial.configured;
    if (partial.workspacePath !== undefined) this.data.workspacePath = partial.workspacePath;
    if (partial.wizardCompleted !== undefined) this.data.wizardCompleted = partial.wizardCompleted;
    if (partial.memoryImported !== undefined) this.data.memoryImported = partial.memoryImported;
    this.save();
    return this.getAll();
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      // 静默失败：设置写入失败不阻塞主流程
    }
  }

  /** 恢复初始配置（清空全部设置，含向导完成标记；凭据由 handlers 层另行清除） */
  resetToDefaults(): void {
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this.save();
  }
}
