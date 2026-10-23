import { fetchModelList } from './model-api.js';
import { featureLayerMessages, listFeatureLayers, onFeatureLayersChanged } from './feature-layers.js';
import { createPromptOrder, hasSavedModelSettings, loadModelSettings, saveModelSettings, type ModelSettings, type PromptEntry } from './model-settings.js';
import { modelSettingsView, presetWorkspaceView, worldbookSettingsView, type ModelViewState } from './model-view.js';
import { importModelPreset, MAX_PRESET_BYTES, MAX_PRESET_ENTRIES } from './preset-import.js';
import { listWorldbooks, readWorldbook } from './worldbook-source.js';
import { onAnchorsChanged } from './anchor-store.js';
import { getContextFilterStatus, onContextFilterStatusChanged } from './context-filter.js';

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
  private bookRequest: AbortController | null = null;
  private previewRequest: AbortController | null = null;
  private unsubscribe: (() => void)[];
  private importRequest = 0;
  private draftRevision = 0;
  private importNotice = '';
  private importError = false;
  private selectedKey = '';
  private preview: ModelViewState['layerPreview'];
  private worldbook: NonNullable<ModelViewState['worldbook']> = { names: [], book: '', entries: [], loading: false, error: '' };
  private booksLoaded = false;

  constructor() {
    try {
      this.settings = loadModelSettings();
      if (hasSavedModelSettings()) this.saved = JSON.stringify(this.settings);
      this.ensureLayerSlots();
    } catch (error) { this.loadError = (error as Error).message; }
    this.unsubscribe = [
      onFeatureLayersChanged(() => { this.ensureLayerSlots(); this.render(); }),
      onAnchorsChanged(() => { if (this.selectedKey === 'layer:anchors') void this.refreshPreview(); }),
      onContextFilterStatusChanged(() => this.syncFilterStatus()),
    ];
  }

  mount(container: HTMLElement, page: 'model' | 'features' = 'model'): void {
    this.unmount();
    this.container = container;
    this.page = page;
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    container.addEventListener('input', event => this.edit(event), { signal });
    container.addEventListener('change', event => {
      if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-preset-file')) void this.importPresetFile(event.target);
    }, { signal });
    container.addEventListener('click', event => this.click(event), { signal });
    this.render();
    this.loadSelectedSource();
  }

  maskKey(): void {
    const key = this.container?.querySelector<HTMLInputElement>('[data-model-field="key"]');
    if (key) key.type = 'password';
    const toggle = this.container?.querySelector<HTMLElement>('[data-model-action="toggle-key"]');
    if (toggle) { toggle.textContent = '显示'; toggle.setAttribute('aria-pressed', 'false'); }
  }

  unmount(): void {
    this.importRequest++;
    this.maskKey();
    this.refresh?.abort(); this.bookRequest?.abort(); this.previewRequest?.abort();
    this.refresh = this.bookRequest = this.previewRequest = null;
    this.listeners?.abort();
    this.container = null;
  }

  destroy(): void { this.unmount(); this.unsubscribe.forEach(stop => stop()); }
  private isSaved(): boolean { return this.saved === JSON.stringify(this.settings); }

  private ensureLayerSlots(): void {
    if (!this.settings) return;
    for (const layer of listFeatureLayers()) {
      if (!this.settings.promptOrder.includes(`layer:${layer.id}`)) {
        this.settings.promptOrder.splice(this.settings.promptOrder.indexOf('input'), 0, `layer:${layer.id}`);
      }
    }
  }

  private state(): ModelViewState {
    if (!this.settings?.promptOrder.includes(this.selectedKey)) this.selectedKey = this.settings?.promptOrder[0] ?? '';
    return { saved: this.isSaved(), refreshing: this.refresh !== null, selectedKey: this.selectedKey,
      layerPreview: this.preview, worldbook: this.worldbook, filterStatus: getContextFilterStatus(),
      importNotice: this.importNotice || undefined, importError: this.importError };
  }

  private render(): void {
    if (!this.container) return;
    if (!this.settings) { this.container.innerHTML = `<p role="alert">${escape(this.loadError)}</p>`; return; }
    if (this.page === 'model') { this.container.innerHTML = modelSettingsView(this.settings, this.state()); return; }
    const registered = listFeatureLayers();
    const layers = this.settings.promptOrder.filter(key => key.startsWith('layer:')).map(key => {
      const id = key.slice(6);
      return { id, title: registered.find(layer => layer.id === id)?.title ?? `${id}（当前不可用）` };
    });
    this.container.innerHTML = `<div class="image-settings model-settings">
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">02</span>
        <h2 class="section-title">预设功能接入</h2><p class="section-description">启用后按预设左侧条目的位置发送内容。</p></header>
        <div class="feature-layer-list">${layers.map(layer => `<label class="feature-layer-row"><span>${escape(layer.title)}</span><input type="checkbox" data-layer-id="${escape(layer.id)}"${this.settings!.enabledLayers.includes(layer.id) ? ' checked' : ''}></label>`).join('')}</div>
      </section>
      <section class="config-section"><h3 class="subsection-title">挂载世界书</h3>${worldbookSettingsView(this.settings, this.worldbook)}</section>
      <button type="button" class="text-button model-feature-link" data-page="model-api">返回模型 API 预设 →</button>
      <div class="model-save-line" data-saved="${this.isSaved()}"><button type="button" class="text-button" data-model-action="save-model"${this.isSaved() ? ' disabled' : ''}>保存配置</button><p class="config-status" data-model-status role="status"></p></div>
    </div>`;
  }

  private renderPreset(): void {
    if (!this.settings || !this.container) return;
    const workspace = this.container.querySelector<HTMLElement>('[data-preset-workspace]');
    if (!workspace) return;
    const scroll = workspace.querySelector<HTMLElement>('[data-preset-list]')?.scrollTop ?? 0;
    workspace.innerHTML = presetWorkspaceView(this.settings, this.state());
    const list = workspace.querySelector<HTMLElement>('[data-preset-list]');
    if (list) list.scrollTop = scroll;
  }

  private renderSources(): void {
    if (!this.settings || !this.container) return;
    if (this.page === 'features') {
      const node = this.container.querySelector('[data-worldbook-settings]');
      if (node) node.outerHTML = worldbookSettingsView(this.settings, this.worldbook);
    } else if (this.selectedKey.startsWith('layer:')) this.renderPreset();
  }

  private message(text: string, error = false): void {
    const status = this.container?.querySelector<HTMLElement>('[data-model-status]');
    if (status) { status.textContent = text; status.classList.toggle('is-error', error); }
  }

  private syncSave(): void {
    const saved = this.isSaved();
    const line = this.container?.querySelector<HTMLElement>('.model-save-line');
    if (line) line.dataset.saved = String(saved);
    const button = this.container?.querySelector<HTMLButtonElement>('[data-model-action="save-model"]');
    if (button) button.disabled = saved;
    this.message(saved ? '已保存在当前浏览器。' : '当前更改尚未保存。');
  }

  private syncFilterStatus(): void {
    const node = this.container?.querySelector<HTMLElement>('[data-context-filter-status]');
    if (!node) return;
    const status = getContextFilterStatus();
    node.classList.toggle('is-error', Boolean(status.error));
    node.textContent = status.error || (status.active ? '已接入酒馆主 API 上下文隐藏。' : '酒馆主 API 上下文隐藏已关闭。');
  }

  private edit(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) || !this.settings) return;
    const settings = this.settings;
    if (input instanceof HTMLSelectElement && input.hasAttribute('data-worldbook-name')) {
      this.worldbook.book = input.value; void this.refreshWorldbooks(false); return;
    }
    if (input instanceof HTMLInputElement && input.hasAttribute('data-worldbook-entry')) {
      const name = input.dataset.worldbookName ?? this.worldbook.book;
      const id = input.dataset.worldbookEntry!;
      if (name !== this.worldbook.book || (input.checked && !this.worldbook.entries.some(entry => entry.id === id && entry.enabled))) return;
      const selected = new Set(settings.worldbooks.find(book => book.name === name)?.entries ?? []);
      if (input.checked) selected.add(id); else selected.delete(id);
      this.setBookSelection(name, [...selected]); return;
    }
    const field = input.dataset.modelField;
    if (field) {
      switch (field) {
        case 'mode':
          settings.mode = input.value === 'custom' ? 'custom' : 'tavern'; this.maskKey();
          this.container!.querySelector<HTMLElement>('[data-model-custom]')!.hidden = settings.mode !== 'custom';
          this.container!.querySelector<HTMLElement>('[data-model-tavern]')!.hidden = settings.mode !== 'tavern'; break;
        case 'url': case 'key': case 'model': case 'presetName': settings[field] = input.value; break;
        case 'parseImageMarkers': case 'hideImageContext': settings[field] = (input as HTMLInputElement).checked; break;
        case 'maxTokens': case 'temperature': settings[field] = input.value === '' ? NaN : Number(input.value); break;
        case 'transport':
          if (['nonstream', 'stream', 'compatible'].includes(input.value)) settings.transport = input.value as ModelSettings['transport']; break;
      }
      if (field === 'url' || field === 'key' || field === 'mode') {
        this.refresh?.abort(); this.refresh = null; this.syncRefresh();
        if (field !== 'mode') { settings.models = []; this.container?.querySelector('datalist')?.replaceChildren(); }
      }
    } else if (input.dataset.promptField) {
      const id = input.closest<HTMLElement>('[data-entry-id]')?.dataset.entryId;
      const entry = [...settings.head, ...settings.tail].find(item => item.id === id);
      if (!entry) return;
      if (input.dataset.promptField === 'content' || input.dataset.promptField === 'name') entry[input.dataset.promptField] = input.value;
      if (input.dataset.promptField === 'role' && ['system', 'user', 'assistant'].includes(input.value)) entry.role = input.value as PromptEntry['role'];
      if (input.dataset.promptField === 'name') {
        for (const node of Array.from(this.container!.querySelectorAll<HTMLElement>('[data-preset-title]'))) {
          if (node.dataset.presetTitle === `prompt:${entry.id}`) node.textContent = entry.name || '未命名条目';
        }
      }
    } else if (input instanceof HTMLInputElement && (input.dataset.presetEnabled || input.dataset.layerId)) {
      const key = input.dataset.presetEnabled ?? `layer:${input.dataset.layerId}`;
      if (key.startsWith('layer:')) {
        const id = key.slice(6);
        settings.enabledLayers = input.checked ? [...new Set([...settings.enabledLayers, id])] : settings.enabledLayers.filter(item => item !== id);
      } else {
        const entry = [...settings.head, ...settings.tail].find(item => `prompt:${item.id}` === key);
        if (!entry || entry.marker) return;
        entry.enabled = input.checked;
      }
    } else return;
    this.draftRevision++; this.syncSave();
  }

  private click(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !this.settings) return;
    const button = event.target.closest<HTMLButtonElement>('[data-model-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.modelAction;
    try {
      if (action === 'toggle-key') {
        const key = this.container!.querySelector<HTMLInputElement>('[data-model-field="key"]')!;
        key.type = key.type === 'password' ? 'text' : 'password';
        button.textContent = key.type === 'password' ? '显示' : '隐藏'; button.setAttribute('aria-pressed', String(key.type === 'text'));
      } else if (action === 'refresh-models') void this.refreshModels();
      else if (action === 'refresh-worldbooks') void this.refreshWorldbooks();
      else if (action === 'refresh-layer') void this.refreshPreview();
      else if (action === 'select-worldbook' || action === 'clear-worldbook') {
        this.setBookSelection(this.worldbook.book, action === 'clear-worldbook' ? [] : this.worldbook.entries.filter(entry => entry.enabled).map(entry => entry.id));
      } else if (action === 'save-model') {
        for (const field of Array.from(this.container!.querySelectorAll<HTMLInputElement>('input[type="number"]'))) if (!field.reportValidity()) return;
        saveModelSettings(this.settings); this.saved = JSON.stringify(this.settings); this.maskKey(); this.syncSave();
      } else if (action === 'select-preset') {
        this.selectedKey = button.dataset.presetKey!; this.previewRequest?.abort(); this.preview = undefined;
        this.renderPreset(); this.loadSelectedSource();
      } else if (action === 'add-entry') {
        if (this.settings.head.length + this.settings.tail.length >= MAX_PRESET_ENTRIES) throw new Error('最多保留 200 条预设。');
        const id = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
        this.settings.head.push({ id, name: '新条目', role: 'system', content: '', enabled: true });
        const index = this.settings.promptOrder.indexOf(this.selectedKey);
        this.selectedKey = `prompt:${id}`;
        this.settings.promptOrder.splice(index < 0 ? this.settings.promptOrder.length : index + 1, 0, this.selectedKey);
        this.draftRevision++; this.renderPreset(); this.syncSave();
        this.container?.querySelector<HTMLElement>('[data-prompt-field="name"]')?.focus();
      } else if (action === 'move-up' || action === 'move-down' || action === 'remove-entry') {
        const key = button.dataset.presetKey!, order = this.settings.promptOrder;
        const index = order.indexOf(key);
        if (index < 0) return;
        if (action === 'remove-entry') {
          if (!key.startsWith('prompt:')) return;
          this.settings.head = this.settings.head.filter(item => `prompt:${item.id}` !== key);
          this.settings.tail = this.settings.tail.filter(item => `prompt:${item.id}` !== key);
          order.splice(index, 1);
          if (this.selectedKey === key) this.selectedKey = order[Math.min(index, order.length - 1)];
        } else {
          const next = index + (action === 'move-up' ? -1 : 1);
          if (next < 0 || next >= order.length) return;
          [order[index], order[next]] = [order[next], order[index]];
        }
        this.draftRevision++; this.renderPreset(); this.syncSave(); this.loadSelectedSource();
      }
    } catch (error) { this.message((error as Error).message, true); }
  }

  private setBookSelection(name: string, entries: string[]): void {
    if (!name || !this.settings) return;
    const books = this.settings.worldbooks, index = books.findIndex(book => book.name === name);
    if (index >= 0) { if (entries.length) books[index].entries = entries; else books.splice(index, 1); }
    else if (entries.length) books.push({ name, entries });
    this.draftRevision++; this.renderSources(); this.syncSave();
    if (this.page === 'model') void this.refreshPreview();
  }

  private loadSelectedSource(): void {
    if (this.page === 'features' || this.selectedKey === 'layer:worldbook') void this.refreshWorldbooks(!this.booksLoaded);
    if (this.page === 'model' && this.selectedKey.startsWith('layer:')) void this.refreshPreview();
  }

  private async refreshWorldbooks(reloadNames = true): Promise<void> {
    if (!this.container || !this.settings) return;
    this.bookRequest?.abort();
    const controller = new AbortController(); this.bookRequest = controller;
    this.worldbook = { ...this.worldbook, entries: [], loading: true, error: '' }; this.renderSources();
    try {
      if (reloadNames || !this.booksLoaded) {
        const names = await listWorldbooks(controller.signal); controller.signal.throwIfAborted();
        this.worldbook.names = names; this.booksLoaded = true;
      }
      this.worldbook.book ||= this.settings.worldbooks[0]?.name ?? this.worldbook.names[0] ?? '';
      if (this.worldbook.book) this.worldbook.entries = await readWorldbook(this.worldbook.book, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.worldbook.error = error instanceof Error ? error.message : '世界书读取失败。';
    } finally {
      if (this.bookRequest === controller && !controller.signal.aborted) {
        this.bookRequest = null; this.worldbook.loading = false; this.renderSources();
      }
    }
  }

  private async refreshPreview(): Promise<void> {
    if (!this.settings || !this.container || this.page !== 'model' || !this.selectedKey.startsWith('layer:')) return;
    this.previewRequest?.abort();
    const controller = new AbortController(); this.previewRequest = controller;
    const key = this.selectedKey; this.preview = { key, text: '', loading: true }; this.renderPreset();
    try {
      const messages = await featureLayerMessages(key.slice(6), structuredClone(this.settings), { messages: [], signal: controller.signal });
      controller.signal.throwIfAborted();
      this.preview = { key, text: messages.map(message => message.content).join('\n\n'), loading: false };
    } catch (error) {
      if (!controller.signal.aborted) this.preview = { key, text: '', loading: false, error: error instanceof Error ? error.message : '内容读取失败。' };
    } finally {
      if (this.previewRequest === controller && !controller.signal.aborted) {
        this.previewRequest = null; if (this.selectedKey === key) this.renderPreset();
      }
    }
  }

  private presetMessage(text: string, error = false): void {
    this.importNotice = text; this.importError = error;
    const status = this.container?.querySelector<HTMLElement>('[data-preset-status]');
    if (status) { status.textContent = text; status.classList.toggle('is-error', error); }
  }

  private async importPresetFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]; input.value = '';
    if (!file || !this.settings) return;
    const request = ++this.importRequest, revision = this.draftRevision, settings = this.settings, signal = this.listeners?.signal;
    this.presetMessage('正在读取预设…');
    try {
      if (file.size > MAX_PRESET_BYTES) throw new Error('预设文件不能超过 2 MiB。');
      const source = await file.text();
      if (request !== this.importRequest || signal?.aborted || this.page !== 'model') return;
      if (revision !== this.draftRevision || settings !== this.settings) throw new Error('读取期间配置已有更改，请重新选择文件。');
      const imported = importModelPreset(source, file.name.replace(/\.json$/i, ''));
      const layers = settings.promptOrder.filter(key => key.startsWith('layer:')).map(key => key.slice(6));
      this.settings = { ...settings, presetName: imported.presetName, head: imported.head, tail: imported.tail,
        promptOrder: createPromptOrder(imported.head, imported.tail, layers) };
      this.selectedKey = this.settings.promptOrder[0]; this.previewRequest?.abort(); this.preview = undefined;
      this.draftRevision++;
      this.importNotice = `已导入“${imported.presetName || '未命名预设'}”，共 ${imported.head.length + imported.tail.length} 条；点击保存配置才会保留。${imported.warnings.join(' ')}`;
      this.importError = false; this.render(); this.syncSave(); this.loadSelectedSource();
    } catch (error) {
      if (request === this.importRequest && !signal?.aborted) this.presetMessage(`导入失败，原配置已保留：${error instanceof Error ? error.message : '无法读取文件。'}`, true);
    }
  }

  private syncRefresh(): void {
    const button = this.container?.querySelector<HTMLButtonElement>('[data-model-action="refresh-models"]');
    if (button) { button.disabled = this.refresh !== null; button.textContent = this.refresh ? '刷新中…' : '刷新列表'; }
  }

  private async refreshModels(): Promise<void> {
    if (this.refresh || !this.settings || this.settings.mode !== 'custom') return;
    const controller = new AbortController(); this.refresh = controller; this.syncRefresh();
    this.message('正在读取模型列表…');
    try {
      const models = await fetchModelList({ url: this.settings.url, key: this.settings.key }, controller.signal);
      if (controller.signal.aborted || this.refresh !== controller) return;
      this.settings.models = models;
      const list = this.container?.querySelector('datalist');
      if (list) list.innerHTML = models.map(model => `<option value="${escape(model)}"></option>`).join('');
      this.syncSave();
      this.message(models.length ? `已读取 ${models.length} 个模型，可选择或手动填写；点击保存保留配置。` : '接口未返回模型，可手动填写模型名称。');
    } catch (error) { if (!controller.signal.aborted) this.message((error as Error).message, true); }
    finally { if (this.refresh === controller) { this.refresh = null; this.syncRefresh(); } }
  }
}
