// 设置页（主对话内弹出）：endpoint/Key/模型/档位/超时/重试/代理/并发 + 清除凭据 + 记忆（M5）
import { createSignal, onMount, Show } from 'solid-js';

import { bridge } from '../../ipc/client';
import { settings, setSettings, setUi } from '../../state/stores';
import type { MemoryLoadResult } from '@codara/contract';

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
const globalBytes = (m: MemoryLoadResult) => `${utf8Bytes(m.global)} 字节`;
const projectBytes = (m: MemoryLoadResult) => `${utf8Bytes(m.project)} 字节`;

export function SettingsPage(props: { onClose: () => void }) {
  const b = bridge();
  const s = () => settings.value;
  const [apiKey, setApiKey] = createSignal('');
  const [endpoint, setEndpoint] = createSignal(s()?.provider.endpoint || '');
  const [model, setModel] = createSignal(s()?.provider.model || '');
  const [effort, setEffort] = createSignal(s()?.provider.effort || 'balanced');
  const [maxRetries, setMaxRetries] = createSignal(s()?.provider.maxRetries || 3);
  const [turnsLimit, setTurnsLimit] = createSignal(s()?.budget.turnsLimit || 200);
  const [tokenLimit, setTokenLimit] = createSignal(s()?.budget.tokenLimit || 0);
  const [costLimit, setCostLimit] = createSignal(s()?.budget.costLimitCNY || 0);
  const [minimal, setMinimal] = createSignal(s()?.ui.minimalMode || false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  // M5 记忆状态
  const [mem, setMem] = createSignal<MemoryLoadResult | null>(null);
  const [importing, setImporting] = createSignal(false);
  const [importDone, setImportDone] = createSignal('');

  onMount(async () => {
    try {
      setMem(await b.memoryLoad());
    } catch {
      /* 记忆面板静默降级 */
    }
  });

  const doImport = async () => {
    setImporting(true);
    try {
      const r = await b.memoryImport();
      setImportDone(
        r.imported.length > 0
          ? `已导入 ${r.imported.length} 个来源`
          : r.skipped.length > 0
            ? '无可新增内容（章节已存在）'
            : '未发现可导入来源'
      );
      setMem(await b.memoryLoad());
      setTimeout(() => setImportDone(''), 3000);
    } finally {
      setImporting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await b.settingsSet({
        provider: {
          endpoint: endpoint(),
          model: model(),
          effort: effort() as 'fast' | 'balanced' | 'max',
          maxRetries: maxRetries(),
        },
        apiKey: apiKey() || undefined,
        budget: {
          turnsLimit: turnsLimit(),
          tokenLimit: tokenLimit() > 0 ? tokenLimit() : undefined,
          costLimitCNY: costLimit() > 0 ? costLimit() : undefined,
        },
        ui: { minimalMode: minimal() },
      });
      const v = await b.settingsGet();
      setSettings('value', v);
      setUi({ rightPaneVisible: v.ui.rightPaneVisible });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const clearCredentials = async () => {
    // 设置页提供「清除全部凭据」入口（规格 5.5）
    await b.settingsSet({ apiKey: '' });
    setApiKey('');
  };

  return (
    <div class="wizard">
      <div class="wizard-card">
        <h1>设置</h1>
        <label>
          Endpoint
          <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} />
        </label>
        <label>
          模型名
          <input value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
        </label>
        <label>
          API Key（留空不修改）
          <input type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} />
        </label>
        <label>
          响应档位
          <select value={effort()} onChange={(e) => setEffort(e.currentTarget.value as never)}>
            <option value="fast">快速</option>
            <option value="balanced">均衡</option>
            <option value="max">极致</option>
          </select>
        </label>
        <label>
          失败重试次数
          <input type="number" value={maxRetries()} onInput={(e) => setMaxRetries(Number(e.currentTarget.value))} />
        </label>
        <label>
          单任务轮次上限
          <input type="number" value={turnsLimit()} onInput={(e) => setTurnsLimit(Number(e.currentTarget.value))} />
        </label>
        <label>
          token 上限（0=不限）
          <input type="number" value={tokenLimit()} onInput={(e) => setTokenLimit(Number(e.currentTarget.value))} />
        </label>
        <label>
          费用上限 ¥（0=不限）
          <input type="number" step="0.1" value={costLimit()} onInput={(e) => setCostLimit(Number(e.currentTarget.value))} />
        </label>
        <label class="check-row">
          <input type="checkbox" checked={minimal()} onChange={(e) => setMinimal(e.currentTarget.checked)} />
          老机模式（关闭动画、右栏收起）
        </label>
        <Show when={mem()}>
          {(m) => (
            <div class="memory-block">
              <p class="hint" style="margin-bottom:6px">
                记忆：全局 {m().global ? `已配置（${globalBytes(m())}）` : '未创建'} · 项目{' '}
                {m().project ? `已配置（${projectBytes(m())}）` : '未创建'}（项目根 AGENTS.md，8KB 上限）
              </p>
              <Show when={!m().imported && m().importable.length > 0}>
                <button class="memory-import" disabled={importing()} onClick={doImport}>
                  {importing() ? '导入中…' : `导入 ${m().importable.join(' / ')} 记忆`}
                </button>
              </Show>
              <Show when={m().imported}>
                <p class="hint">✓ 兼容记忆已导入（一次性向导）</p>
              </Show>
              <Show when={importDone()}>
                <p class="hint">{importDone()}</p>
              </Show>
            </div>
          )}
        </Show>
        <div class="wizard-actions">
          <button class="danger" onClick={clearCredentials}>
            清除全部凭据
          </button>
          <span style="flex:1" />
          <button onClick={props.onClose}>关闭</button>
          <button class="primary" disabled={saving()} onClick={save}>
            {saved() ? '已保存 ✓' : saving() ? '保存中…' : '保存'}
          </button>
        </div>
        <Show when={s()?.provider.hasKey}>
          <p class="hint">已配置 API Key（DPAPI 加密存储）</p>
        </Show>
      </div>
    </div>
  );
}
