// 设置页（主对话内弹出）：endpoint/Key/模型（在线拉取/切换）/档位/超时/重试/并发 + 清除凭据 + 恢复初始 + 记忆（M5）
import { createSignal, For, onMount, Show } from 'solid-js';

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
  const [models, setModels] = createSignal<string[]>(s()?.provider.models || []);
  const [effort, setEffort] = createSignal(s()?.provider.effort || 'balanced');
  const [maxRetries, setMaxRetries] = createSignal(s()?.provider.maxRetries || 3);
  const [turnsLimit, setTurnsLimit] = createSignal(s()?.budget.turnsLimit || 200);
  const [tokenLimit, setTokenLimit] = createSignal(s()?.budget.tokenLimit || 0);
  const [costLimit, setCostLimit] = createSignal(s()?.budget.costLimitCNY || 0);
  const [minimal, setMinimal] = createSignal(s()?.ui.minimalMode || false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  // 在线拉取模型
  const [fetching, setFetching] = createSignal(false);
  const [fetchError, setFetchError] = createSignal('');
  // 恢复初始配置
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [resetting, setResetting] = createSignal(false);
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

  const fetchModels = async () => {
    if (!endpoint().trim()) {
      setFetchError('请先填写 Base URL');
      return;
    }
    setFetching(true);
    setFetchError('');
    try {
      const r = await b.modelsList({ endpoint: endpoint().trim(), apiKey: apiKey().trim() || undefined });
      if (r.ok && r.models.length > 0) {
        setModels(r.models);
        // 当前激活模型若不在列表中，保留在候选首位
        if (model() && !r.models.includes(model())) {
          setModels([model(), ...r.models]);
        }
      } else {
        setFetchError(r.error ? `拉取失败：${r.error}` : '端点未返回模型，可手动输入模型名。');
      }
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await b.settingsSet({
        provider: {
          endpoint: endpoint(),
          model: model(),
          models: models(),
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

  const resetAll = async () => {
    setResetting(true);
    try {
      await b.settingsReset(); // 清空设置并自动重启 → 重现欢迎向导
    } finally {
      setResetting(false);
    }
  };

  return (
    <div class="wizard">
      <div class="wizard-card">
        <h1>设置</h1>
        <label>
          Base URL
          <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} />
        </label>
        <label>
          API Key（留空不修改）
          <input type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} />
        </label>
        <div class="wizard-actions" style="justify-content: flex-start">
          <button disabled={fetching() || !endpoint().trim()} onClick={fetchModels}>
            {fetching() ? '拉取中…' : '按当前 Base URL / Key 拉取模型列表'}
          </button>
        </div>
        <Show when={fetchError()}>
          <p class="hint" style="color: #b45309">{fetchError()}</p>
        </Show>
        <Show when={models().length > 0}>
          <div class="model-pick-list">
            <For each={models()}>
              {(m) => (
                <label class="check-row">
                  <input type="radio" name="active-model" checked={model() === m} onChange={() => setModel(m)} />
                  <span class="code">{m}</span>
                </label>
              )}
            </For>
          </div>
          <p class="hint">单选切换当前使用的模型；保存后立即生效。</p>
        </Show>
        <label>
          模型名（手动输入亦可）
          <input value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
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
          <Show
            when={!confirmReset()}
            fallback={
              <>
                <button class="danger" disabled={resetting()} onClick={resetAll}>
                  {resetting() ? '重置中…' : '确认重置并重启'}
                </button>
                <button onClick={() => setConfirmReset(false)}>取消</button>
              </>
            }
          >
            <button onClick={() => setConfirmReset(true)}>恢复初始配置…</button>
          </Show>
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
