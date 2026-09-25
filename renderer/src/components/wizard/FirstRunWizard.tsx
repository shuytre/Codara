// 首次启动向导：国产直连模板（默认推荐）+ 本地兜底 + 自定义 endpoint（规格 7.7）
import { createSignal, For, Show } from 'solid-js';

import { VENDOR_TEMPLATES, type VendorTemplate } from '@codara/contract';
import { bridge } from '../../ipc/client';
import { settings } from '../../state/stores';

export function FirstRunWizard(props: { onDone: () => void }) {
  const b = bridge();
  const [step, setStep] = createSignal(0);
  const [selected, setSelected] = createSignal<VendorTemplate | null>(null);
  const [apiKey, setApiKey] = createSignal('');
  const [endpoint, setEndpoint] = createSignal('');
  const [model, setModel] = createSignal('');
  const [effort, setEffort] = createSignal<'fast' | 'balanced' | 'max'>('balanced');
  const [saving, setSaving] = createSignal(false);

  const pick = (t: VendorTemplate) => {
    setSelected(t);
    setEndpoint(t.endpoint);
    setModel(t.defaultModel);
    if (t.kind === 'local') setStep(2);
    else setStep(1);
  };

  const finish = async () => {
    setSaving(true);
    try {
      await b.settingsSet({
        provider: {
          templateId: selected()?.id,
          endpoint: endpoint(),
          model: model(),
          effort: effort(),
          pricing: selected()?.pricing,
        },
        apiKey: apiKey() || undefined,
        wizardCompleted: true,
      });
      props.onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="wizard">
      <div class="wizard-card">
        <Show when={step() === 0}>
          <h1>欢迎使用 Codara</h1>
          <p class="sub">对话式编程 Agent · 自然语言描述目标，它交付结果</p>
          <h3>第一步：选择模型端点（预置国产直连，无需科学上网）</h3>
          <div class="tpl-list">
            <For each={VENDOR_TEMPLATES}>
              {(t) => (
                <button class={`tpl ${t.kind === 'local' ? 'local' : ''}`} onClick={() => pick(t)}>
                  <div class="tpl-name">{t.name}</div>
                  <div class="tpl-note">
                    {t.note || `¥${t.pricing.promptPerM}/M 输入 · ¥${t.pricing.completionPerM}/M 输出`}
                  </div>
                </button>
              )}
            </For>
          </div>
          <p class="hint">第二步可填入 API Key（DPAPI 加密存储，不落明文）。本地模型零成本兜底、断网可用。</p>
        </Show>

        <Show when={step() === 1}>
          <h1>配置 {selected()?.name}</h1>
          <label>
            API Key
            <input type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} placeholder="sk-…" />
          </label>
          <label>
            Endpoint
            <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} />
          </label>
          <label>
            模型名
            <input value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
          </label>
          <label>
            响应档位
            <select value={effort()} onChange={(e) => setEffort(e.currentTarget.value as never)}>
              <option value="fast">快速（最低消耗）</option>
              <option value="balanced">均衡（默认）</option>
              <option value="max">极致（复杂任务）</option>
            </select>
          </label>
          <div class="wizard-actions">
            <button onClick={() => setStep(0)}>返回</button>
            <button class="primary" disabled={saving() || !apiKey()} onClick={finish}>
              {saving() ? '保存中…' : '完成并开始'}
            </button>
          </div>
          <p class="hint">Key 经 sidecar DPAPI 按当前用户加密；可在设置中随时清除全部凭据。</p>
        </Show>

        <Show when={step() === 2}>
          <h1>本地模型（{selected()?.name}）</h1>
          <label>
            Endpoint
            <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} />
          </label>
          <label>
            模型名
            <input value={model()} onInput={(e) => setModel(e.currentTarget.value)} />
          </label>
          <div class="wizard-actions">
            <button onClick={() => setStep(0)}>返回</button>
            <button class="primary" disabled={saving()} onClick={finish}>
              完成（无需 Key）
            </button>
          </div>
          <p class="hint">本地端点零成本、断网可用；按本地模型能力自动裁剪视觉/长上下文。</p>
        </Show>
      </div>
    </div>
  );
}
