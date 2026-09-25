// 首次启动向导：厂商模板（含 Agnes / 自定义）→ Base URL + API Key → 在线拉取模型多选
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
  // 候选模型（拉取成功 = 在线列表；失败 = 模板预置 + 手输）
  const [models, setModels] = createSignal<string[]>([]);
  const [checked, setChecked] = createSignal<string[]>([]);
  const [manualModel, setManualModel] = createSignal('');
  const [fetching, setFetching] = createSignal(false);
  const [fetchError, setFetchError] = createSignal('');
  const [effort, setEffort] = createSignal<'fast' | 'balanced' | 'max'>('balanced');
  const [saving, setSaving] = createSignal(false);

  const pick = (t: VendorTemplate) => {
    setSelected(t);
    setEndpoint(t.endpoint);
    setModels(t.models ?? []);
    setChecked([]);
    setManualModel('');
    setFetchError('');
    setStep(t.kind === 'local' ? 2 : 1);
  };

  // 在线拉取 {base}/models（OpenAI 兼容），失败回退模板预置列表
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
        setChecked([r.models[0] as string]);
      } else {
        const fallback = selected()?.models ?? [];
        setModels(fallback);
        setChecked(fallback.length > 0 ? [fallback[0] as string] : []);
        setFetchError(r.error ? `拉取失败：${r.error}。可从常用列表勾选或手动输入。` : '端点未返回模型，可从常用列表勾选或手动输入。');
      }
    } finally {
      setFetching(false);
    }
  };

  const toggle = (m: string) => {
    setChecked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const finish = async () => {
    setSaving(true);
    try {
      const list = checked().length > 0 ? checked() : manualModel().trim() ? [manualModel().trim()] : [];
      const t = selected();
      await b.settingsSet({
        provider: {
          templateId: t?.id,
          endpoint: endpoint().trim(),
          model: list[0] ?? t?.defaultModel ?? '',
          models: list,
          effort: effort(),
          pricing: t?.pricing,
        },
        apiKey: apiKey().trim() || undefined,
        wizardCompleted: true,
      });
      props.onDone();
    } finally {
      setSaving(false);
    }
  };

  const canFinish = () => checked().length > 0 || manualModel().trim().length > 0;

  return (
    <div class="wizard">
      <div class="wizard-card">
        <Show when={step() === 0}>
          <h1>欢迎使用 Codara</h1>
          <p class="sub">对话式编程 Agent · 自然语言描述目标，它交付结果</p>
          <h3>第一步：选择模型厂商</h3>
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
          <p class="hint">下一步填 Base URL 与 API Key 后将在线拉取可选模型，勾选一个或多个、随时切换。本地模型零成本兜底、断网可用。</p>
        </Show>

        <Show when={step() === 1}>
          <h1>配置 {selected()?.name}</h1>
          <label>
            Base URL（OpenAI 兼容地址）
            <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} placeholder="https://api.example.com/v1" />
          </label>
          <label>
            API Key
            <input type="password" value={apiKey()} onInput={(e) => setApiKey(e.currentTarget.value)} placeholder="sk-…" />
          </label>
          <div class="wizard-actions" style="justify-content: flex-start">
            <button class="primary" disabled={fetching() || !endpoint().trim()} onClick={fetchModels}>
              {fetching() ? '拉取中…' : '获取模型列表'}
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
                    <input type="checkbox" checked={checked().includes(m)} onChange={() => toggle(m)} />
                    <span class="code">{m}</span>
                  </label>
                )}
              </For>
            </div>
            <p class="hint">可勾选多个；排第一的为当前使用的模型，之后可在设置页切换。</p>
          </Show>
          <label>
            手动输入模型名（可选，拉取失败时使用）
            <input value={manualModel()} onInput={(e) => setManualModel(e.currentTarget.value)} placeholder="如 deepseek-flash" />
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
            <button class="primary" disabled={saving() || !canFinish()} onClick={finish}>
              {saving() ? '保存中…' : '完成并开始'}
            </button>
          </div>
          <p class="hint">Key 经 sidecar DPAPI 按当前用户加密；可在设置中随时清除全部凭据或恢复初始配置。</p>
        </Show>

        <Show when={step() === 2}>
          <h1>本地模型（{selected()?.name}）</h1>
          <label>
            Base URL
            <input value={endpoint()} onInput={(e) => setEndpoint(e.currentTarget.value)} />
          </label>
          <div class="wizard-actions" style="justify-content: flex-start">
            <button class="primary" disabled={fetching() || !endpoint().trim()} onClick={fetchModels}>
              {fetching() ? '拉取中…' : '获取模型列表'}
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
                    <input type="checkbox" checked={checked().includes(m)} onChange={() => toggle(m)} />
                    <span class="code">{m}</span>
                  </label>
                )}
              </For>
            </div>
          </Show>
          <label>
            手动输入模型名（可选）
            <input value={manualModel()} onInput={(e) => setManualModel(e.currentTarget.value)} placeholder="如 qwen2.5-coder:7b" />
          </label>
          <div class="wizard-actions">
            <button onClick={() => setStep(0)}>返回</button>
            <button class="primary" disabled={saving() || !canFinish()} onClick={finish}>
              完成（无需 Key）
            </button>
          </div>
          <p class="hint">本地端点零成本、断网可用；按本地模型能力自动裁剪视觉/长上下文。</p>
        </Show>
      </div>
    </div>
  );
}
