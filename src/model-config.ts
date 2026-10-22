import { fetchModelList } from './model-api.js';
import { listFeatureLayers, onFeatureLayersChanged } from './feature-layers.js';
import { hasSavedModelSettings, loadModelSettings, saveModelSettings, type ModelSettings, type PromptEntry } from './model-settings.js';
import { modelSettingsView } from './model-view.js';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export class ModelConfig {
  private settings: ModelSettings | null = null;
  private loadError = '';
  private saved = '';
  private container: HTMLElement | null = null;
  private page: 'model' | 'features' = 'model';
  private listeners: AbortController | null = null;
  private refresh: AbortController | null = null;
  private unsubscribe: () => void;

  constructor() {
    try {
      this.settings = loadModelSettings();
      if (hasSavedModelSettings()) this.saved = JSON.stringify(this.settings);
    }
    catch (error) { this.loadError = (error as Error).message; }
    this.unsubscribe = onFeatureLayersChanged(() => {
      if (this.container && this.page === 'features') this.render();
    });
  }

  mount(container: HTMLElement, page: 'model' | 'features' = 'model'): void {
    this.unmount();
    this.container = container;
    this.page = page;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    container.addEventListener('input', event => this.edit(event), { signal });
    container.addEventListener('click', event => this.click(event), { signal });
    this.render();
  }

  maskKey(): void {
    const key = this.container?.querySelector<HTMLInputElement>('[data-model-field="key"]');
    if (key) key.type = 'password';
    const toggle = this.container?.querySelector<HTMLElement>('[data-model-action="toggle-key"]');
    if (toggle) {
      toggle.textContent = '显示';
      toggle.setAttribute('aria-pressed', 'false');
    }
  }

  unmount(): void {
    this.maskKey();
    this.refresh?.abort();
    this.refresh = null;
    this.listeners?.abort();
    this.container = null;
  }

  destroy(): void {
    this.unmount();
    this.unsubscribe();
  }

  private isSaved(): boolean { return this.saved === JSON.stringify(this.settings); }

  private render(): void {
    if (!this.container) return;
    if (!this.settings) {
      this.container.innerHTML = `<p role="alert">${escape(this.loadError)}</p>`;
      return;
    }
    if (this.page === 'model') {
      this.container.innerHTML = modelSettingsView(this.settings, { saved: this.isSaved(), refreshing: this.refresh !== null });
      return;
    }
    const registered = listFeatureLayers();
    const unavailable = this.settings.enabledLayers.filter(id => !registered.some(layer => layer.id === id));
    this.container.innerHTML = `<div class="image-settings model-settings">
      <section class="config-section"><h2 class="section-title">功能层配置</h2>
        <p class="muted">启用的内容会放在预设头部与尾部之间。</p>
        ${registered.length || unavailable.length ? `<div class="feature-layer-list">${[
          ...registered,
          ...unavailable.map(id => ({ id, title: `${id}（当前不可用）` })),
        ].map(layer => `<label class="feature-layer-row"><span>${escape(layer.title)}</span><input type="checkbox" data-layer-id="${escape(layer.id)}"${this.settings!.enabledLayers.includes(layer.id) ? ' checked' : ''}></label>`).join('')}</div>`
        : '<p class="config-status">目前还没有接入的功能。世界书等内容将通过这里的接口加入。</p>'}
      </section>
      <button type="button" class="text-button model-feature-link" data-page="model-api">返回模型 API 预设 →</button>
      <div class="model-save-line" data-saved="${this.isSaved()}"><button type="button" class="text-button" data-model-action="save-model"${this.isSaved() ? ' disabled' : ''}>保存配置</button><p class="config-status" data-model-status role="status"></p></div>
    </div>`;
  }

  private message(text: string, error = false): void {
    const status = this.container?.querySelector<HTMLElement>('[data-model-status]');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  private syncSave(): void {
    const saved = this.isSaved();
    const line = this.container?.querySelector<HTMLElement>('.model-save-line');
    if (line) line.dataset.saved = String(saved);
    const button = this.container?.querySelector<HTMLButtonElement>('[data-model-action="save-model"]');
    if (button) button.disabled = saved;
    this.message(saved ? '已保存在当前浏览器。' : '当前更改尚未保存。');
  }

  private edit(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) || !this.settings) return;
    const settings = this.settings;
    const field = input.dataset.modelField;
    if (field) {
      switch (field) {
        case 'mode':
          settings.mode = input.value === 'custom' ? 'custom' : 'tavern';
          this.maskKey();
          this.container!.querySelector<HTMLElement>('[data-model-custom]')!.hidden = settings.mode !== 'custom';
          this.container!.querySelector<HTMLElement>('[data-model-tavern]')!.hidden = settings.mode !== 'tavern';
          break;
        case 'url': case 'key': case 'model': settings[field] = input.value; break;
        case 'maxTokens': case 'temperature':
          settings[field] = input.value === '' ? NaN : Number(input.value);
          break;
        case 'transport':
          if (['nonstream', 'stream', 'compatible'].includes(input.value)) settings.transport = input.value as ModelSettings['transport'];
          break;
      }
      if (field === 'url' || field === 'key' || field === 'mode') {
        this.refresh?.abort();
        this.refresh = null;
        this.syncRefresh();
        if (field !== 'mode') {
          settings.models = [];
          this.container?.querySelector('datalist')?.replaceChildren();
        }
      }
    } else if (input.dataset.promptField) {
      const parent = input.closest<HTMLElement>('[data-entry-id]');
      const section = parent?.dataset.section;
      if (section !== 'head' && section !== 'tail') return;
      const entry = settings[section].find(item => item.id === parent!.dataset.entryId);
      if (!entry) return;
      if (input.dataset.promptField === 'content') entry.content = input.value;
      if (input.dataset.promptField === 'enabled') entry.enabled = (input as HTMLInputElement).checked;
      if (input.dataset.promptField === 'role' && ['system', 'user', 'assistant'].includes(input.value)) entry.role = input.value as PromptEntry['role'];
    } else if (input instanceof HTMLInputElement && input.dataset.layerId) {
      const id = input.dataset.layerId;
      settings.enabledLayers = input.checked
        ? [...new Set([...settings.enabledLayers, id])]
        : settings.enabledLayers.filter(item => item !== id);
    } else return;
    this.syncSave();
  }

  private click(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !this.settings) return;
    const button = event.target.closest<HTMLButtonElement>('[data-model-action]');
    if (!button) return;
    const action = button.dataset.modelAction;
    try {
      if (action === 'toggle-key') {
        const key = this.container!.querySelector<HTMLInputElement>('[data-model-field="key"]')!;
        key.type = key.type === 'password' ? 'text' : 'password';
        button.textContent = key.type === 'password' ? '显示' : '隐藏';
        button.setAttribute('aria-pressed', String(key.type === 'text'));
      } else if (action === 'refresh-models') {
        void this.refreshModels();
      } else if (action === 'save-model') {
        for (const field of Array.from(this.container!.querySelectorAll<HTMLInputElement>('input[type="number"]'))) {
          if (!field.reportValidity()) return;
        }
        saveModelSettings(this.settings);
        this.saved = JSON.stringify(this.settings);
        this.maskKey();
        this.syncSave();
      } else if (action === 'add-head' || action === 'add-tail') {
        const section = action === 'add-head' ? 'head' : 'tail';
        if (this.settings[section].length >= 100) throw new Error('每段最多保留 100 条预设。');
        const id = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
        this.settings[section].push({ id, role: 'system', content: '', enabled: true });
        this.renderKeepingSections();
        const details = this.container!.querySelector<HTMLDetailsElement>(`details[data-section="${section}"]`)!;
        details.open = true;
        details.querySelector<HTMLTextAreaElement>(`[data-entry-id="${id}"] textarea`)!.focus();
        this.syncSave();
      } else if (action === 'remove-entry') {
        const section = button.dataset.section;
        if (section !== 'head' && section !== 'tail') return;
        this.settings[section] = this.settings[section].filter(item => item.id !== button.dataset.entryId);
        this.renderKeepingSections();
        this.syncSave();
      }
    } catch (error) { this.message((error as Error).message, true); }
  }

  private renderKeepingSections(): void {
    const open = Array.from(this.container?.querySelectorAll<HTMLDetailsElement>('details[data-section][open]') ?? [])
      .map(node => node.dataset.section);
    this.render();
    this.container?.querySelectorAll<HTMLDetailsElement>('details[data-section]').forEach(node => { node.open = open.includes(node.dataset.section); });
  }

  private syncRefresh(): void {
    const button = this.container?.querySelector<HTMLButtonElement>('[data-model-action="refresh-models"]');
    if (button) {
      button.disabled = this.refresh !== null;
      button.textContent = this.refresh ? '刷新中…' : '刷新列表';
    }
  }

  private async refreshModels(): Promise<void> {
    if (this.refresh || !this.settings || this.settings.mode !== 'custom') return;
    const controller = new AbortController();
    this.refresh = controller;
    this.syncRefresh();
    this.message('正在读取模型列表…');
    try {
      const models = await fetchModelList({ url: this.settings.url, key: this.settings.key }, controller.signal);
      if (controller.signal.aborted || this.refresh !== controller) return;
      this.settings.models = models;
      const list = this.container?.querySelector('datalist');
      if (list) list.innerHTML = models.map(model => `<option value="${escape(model)}"></option>`).join('');
      this.syncSave();
      this.message(models.length ? `已读取 ${models.length} 个模型，可选择或手动填写；点击保存保留配置。` : '接口未返回模型，可手动填写模型名称。');
    } catch (error) {
      if (!controller.signal.aborted) this.message((error as Error).message, true);
    } finally {
      if (this.refresh === controller) {
        this.refresh = null;
        this.syncRefresh();
      }
    }
  }
}
