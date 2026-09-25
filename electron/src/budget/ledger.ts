// 预算账本：分桶（today/task/system）、费用估算、熔断判定、API Key 读取（sidecar 解密）
import { SettingsShape, SettingsStore } from '../config/settingsStore';
import { SidecarManager } from '../sidecar/manager';

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
}

export class BudgetLedger {
  private taskId: string | null = null;
  private taskUsage: UsageTotals = { promptTokens: 0, completionTokens: 0, costCNY: 0 };
  private turns = 0;
  private suspended = false;

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly settings: SettingsStore
  ) {}

  async getApiKey(): Promise<string> {
    const r = await this.sidecar.call('secret.get', {
      name: 'model-api-key',
      appDataDir: this.appDataDir(),
    });
    if (r.ok && r.data && typeof r.data === 'object') {
      return String((r.data as Record<string, unknown>).value ?? '');
    }
    return '';
  }

  async saveApiKey(key: string): Promise<boolean> {
    const r = await this.sidecar.call('secret.set', {
      name: 'model-api-key',
      value: key,
      appDataDir: this.appDataDir(),
    });
    return r.ok;
  }

  async deleteApiKey(): Promise<boolean> {
    const r = await this.sidecar.call('secret.delete', {
      name: 'model-api-key',
      appDataDir: this.appDataDir(),
    });
    return r.ok;
  }

  private appDataDir(): string {
    // sidecar 侧 secrets 目录挂在 appDataDir 下
    return process.env.CODARA_APP_DATA || require('path').join(process.env.APPDATA || process.env.HOME || '', 'Codara');
  }

  startTask(taskId: string): void {
    this.taskId = taskId;
    this.taskUsage = { promptTokens: 0, completionTokens: 0, costCNY: 0 };
    this.turns = 0;
    this.suspended = false;
  }

  /** 每次模型响应后记账；返回是否触发熔断 */
  record(promptTokens: number, completionTokens: number): boolean {
    const p = this.settings.get('provider').pricing;
    const cost = (promptTokens / 1e6) * p.promptPerM + (completionTokens / 1e6) * p.completionPerM;
    this.taskUsage.promptTokens += promptTokens;
    this.taskUsage.completionTokens += completionTokens;
    this.taskUsage.costCNY += cost;
    // 持久化
    void this.sidecar.call('db.exec', {
      sql: 'INSERT INTO usage_ledger (bucket, task_id, prompt_tokens, completion_tokens, cost_cny, day, created_at) VALUES (?,?,?,?,?,?,?)',
      args: [
        JSON.stringify(this.taskId ? ['task', 'today'] : ['today']),
        this.taskId || '',
        promptTokens,
        completionTokens,
        cost,
        new Date().toISOString().slice(0, 10),
        Date.now(),
      ],
    }).catch(() => undefined);
    return this.checkBreaker();
  }

  tickTurn(): void {
    this.turns++;
  }

  checkBreaker(): boolean {
    const b = this.settings.get('budget');
    if (this.turns >= b.turnsLimit) {
      this.suspended = true;
      return true;
    }
    if (b.tokenLimit && this.taskUsage.promptTokens + this.taskUsage.completionTokens >= b.tokenLimit) {
      this.suspended = true;
      return true;
    }
    if (b.costLimitCNY && this.taskUsage.costCNY >= b.costLimitCNY) {
      this.suspended = true;
      return true;
    }
    return false;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  extend(newTokenLimit?: number, newCostLimitCNY?: number): void {
    const b = this.settings.get('budget');
    this.settings.patch({
      budget: {
        ...b,
        tokenLimit: newTokenLimit,
        costLimitCNY: newCostLimitCNY,
      },
    });
    this.suspended = false;
  }

  snapshot(): {
    task: UsageTotals;
    turns: number;
    budget: SettingsShape['budget'];
    suspended: boolean;
  } {
    return {
      task: { ...this.taskUsage },
      turns: this.turns,
      budget: this.settings.get('budget'),
      suspended: this.suspended,
    };
  }
}
