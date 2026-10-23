import { fetchModelList } from './model-api.js';
import { featureLayerMessages, listFeatureLayers, onFeatureLayersChanged } from './feature-layers.js';
import { createPromptOrder, detachStoredWorldbook, hasSavedModelSettings, loadModelSettings, saveModelSettings } from './model-settings.js';
import { modelSettingsView, presetWorkspaceView, worldbookSettingsView } from './model-view.js';
import { importModelPreset, MAX_PRESET_BYTES, MAX_PRESET_ENTRIES } from './preset-import.js';
import { deleteWorldbook, importWorldbook, listWorldbooks, onWorldbooksChanged, readWorldbook } from './worldbook-source.js';
import { onAnchorsChanged } from './anchor-store.js';
import { getContextFilterStatus, onContextFilterStatusChanged } from './context-filter.js';
import { assertChatSnapshot, captureLatestAssistant } from './chat-host.js';
function escape(value) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export class ModelConfig {
    settings = null;
    loadError = '';
    saved = '';
    container = null;
    page = 'model';
    listeners = null;
    refresh = null;
    bookRequest = null;
    previewRequest = null;
    unsubscribe;
    importRequest = 0;
    draftRevision = 0;
    importNotice = '';
    importError = false;
    selectedKey = '';
    preview;
    worldbook = { names: [], book: '', entries: [], loading: false, error: '' };
    booksLoaded = false;
    worldbookNotice = '';
    worldbookError = false;
    get hasPendingWrites() { return Boolean(this.worldbook.busy); }
    constructor() {
        this.reloadSaved();
        this.unsubscribe = [
            onFeatureLayersChanged(() => { this.ensureLayerSlots(); this.render(); }),
            onAnchorsChanged(() => { if (this.selectedKey === 'layer:anchors')
                void this.refreshPreview(); }),
            onWorldbooksChanged(() => {
                this.booksLoaded = false;
                if (this.worldbook.busy)
                    return;
                if (this.page === 'worldbook' || this.selectedKey === 'layer:worldbook')
                    this.loadSelectedSource();
            }),
            onContextFilterStatusChanged(() => this.syncFilterStatus()),
        ];
    }
    reloadSaved(scope = 'all') {
        this.refresh?.abort();
        this.bookRequest?.abort();
        this.previewRequest?.abort();
        this.refresh = this.bookRequest = this.previewRequest = null;
        this.importRequest++;
        this.draftRevision++;
        this.loadError = '';
        if (scope === 'all') {
            this.settings = null;
            this.saved = '';
        }
        this.importNotice = '';
        this.importError = false;
        this.selectedKey = '';
        this.preview = undefined;
        if (scope !== 'presets') {
            this.worldbook = { names: [], book: '', entries: [], loading: false, error: '', busy: this.worldbook.busy };
            this.booksLoaded = false;
            this.worldbookNotice = '';
            this.worldbookError = false;
        }
        try {
            const stored = loadModelSettings();
            if (scope !== 'all' && this.settings) {
                const fields = scope === 'worldbooks' ? ['worldbooks']
                    : ['presetName', 'head', 'tail', 'promptOrder', 'enabledLayers', 'parseImageMarkers', 'hideImageContext'];
                const imported = Object.fromEntries(fields.map(key => [key, structuredClone(stored[key])]));
                this.settings = { ...this.settings, ...imported };
                this.saved = JSON.stringify({ ...(this.saved ? JSON.parse(this.saved) : stored), ...imported });
            }
            else {
                this.settings = stored;
                this.saved = hasSavedModelSettings() ? JSON.stringify(stored) : '';
            }
            this.ensureLayerSlots();
        }
        catch (error) {
            this.loadError = error.message;
        }
        this.render();
        this.loadSelectedSource();
    }
    mount(container, page = 'model') {
        this.unmount();
        this.container = container;
        this.page = page;
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => {
            if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-preset-file'))
                void this.importPresetFile(event.target);
            if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-worldbook-file'))
                void this.importWorldbookFile(event.target);
        }, { signal });
        container.addEventListener('click', event => this.click(event), { signal });
        this.render();
        this.loadSelectedSource();
    }
    maskKey() {
        const key = this.container?.querySelector('[data-model-field="key"]');
        if (key)
            key.type = 'password';
        const toggle = this.container?.querySelector('[data-model-action="toggle-key"]');
        if (toggle) {
            toggle.textContent = '显示';
            toggle.setAttribute('aria-pressed', 'false');
        }
    }
    unmount() {
        this.importRequest++;
        this.maskKey();
        this.refresh?.abort();
        this.bookRequest?.abort();
        this.previewRequest?.abort();
        this.refresh = this.bookRequest = this.previewRequest = null;
        this.listeners?.abort();
        this.container = null;
    }
    destroy() { this.unmount(); this.unsubscribe.forEach(stop => stop()); }
    isSaved() { return this.saved === JSON.stringify(this.settings); }
    ensureLayerSlots() {
        if (!this.settings)
            return;
        for (const layer of listFeatureLayers()) {
            if (!this.settings.promptOrder.includes(`layer:${layer.id}`)) {
                this.settings.promptOrder.splice(this.settings.promptOrder.indexOf('input'), 0, `layer:${layer.id}`);
            }
        }
    }
    state() {
        if (!this.settings?.promptOrder.includes(this.selectedKey))
            this.selectedKey = this.settings?.promptOrder[0] ?? '';
        return { saved: this.isSaved(), refreshing: this.refresh !== null, selectedKey: this.selectedKey,
            layerPreview: this.preview, worldbook: this.worldbook, filterStatus: getContextFilterStatus(),
            importNotice: this.importNotice || undefined, importError: this.importError };
    }
    render() {
        if (!this.container)
            return;
        if (!this.settings || this.loadError) {
            this.container.innerHTML = `<p role="alert">${escape(this.loadError)}</p>`;
            return;
        }
        if (this.page === 'model') {
            this.container.innerHTML = modelSettingsView(this.settings, this.state());
            return;
        }
        if (this.page === 'worldbook') {
            this.container.innerHTML = `<div class="image-settings model-settings worldbook-library">
        <section class="config-section">
          <label class="config-field"><span>上传世界书 · JSON</span><input type="file" data-worldbook-file accept=".json,application/json"${this.worldbook.busy ? ' disabled' : ''}></label>
          <p class="config-status">支持世界书 JSON 与 character_book 条目，最大 20 MiB。上传后保存在当前浏览器，同名书另存一份。</p>
          <p class="config-status${this.worldbookError ? ' is-error' : ''}" data-worldbook-status role="status">${escape(this.worldbookNotice)}</p>
        </section>
        <section class="config-section">${worldbookSettingsView(this.settings, this.worldbook, true)}</section>
        <label class="prompt-enable"><input type="checkbox" data-layer-id="worldbook"${this.settings.enabledLayers.includes('worldbook') ? ' checked' : ''}>在预设中启用世界书层</label>
        <button type="button" class="text-button model-feature-link" data-page="model-api">前往模型 API 预设 →</button>
        <div class="model-save-line" data-saved="${this.isSaved()}"><button type="button" class="text-button" data-model-action="save-model"${this.isSaved() ? ' disabled' : ''}>保存配置</button><p class="config-status" data-model-status role="status">${this.isSaved() ? '已保存在当前浏览器。' : '选择条目后，点击保存配置生效。'}</p></div>
      </div>`;
            return;
        }
        const registered = listFeatureLayers();
        const layers = this.settings.promptOrder.filter(key => key.startsWith('layer:')).map(key => {
            const id = key.slice(6);
            return { id, title: registered.find(layer => layer.id === id)?.title ?? `${id}（当前不可用）` };
        });
        this.container.innerHTML = `<div class="image-settings model-settings">
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">02</span>
        <h2 class="section-title">预设功能接入</h2><p class="section-description">启用后按预设左侧条目的位置发送内容。</p></header>
        <div class="feature-layer-list">${layers.map(layer => `<label class="feature-layer-row"><span>${escape(layer.title)}</span><input type="checkbox" data-layer-id="${escape(layer.id)}"${this.settings.enabledLayers.includes(layer.id) ? ' checked' : ''}></label>`).join('')}</div>
      </section>
      <button type="button" class="text-button model-feature-link" data-page="model-api">返回模型 API 预设 →</button>
      <div class="model-save-line" data-saved="${this.isSaved()}"><button type="button" class="text-button" data-model-action="save-model"${this.isSaved() ? ' disabled' : ''}>保存配置</button><p class="config-status" data-model-status role="status"></p></div>
    </div>`;
    }
    renderPreset() {
        if (!this.settings || !this.container)
            return;
        const workspace = this.container.querySelector('[data-preset-workspace]');
        if (!workspace)
            return;
        const scroll = workspace.querySelector('[data-preset-list]')?.scrollTop ?? 0;
        this.preserveWorldbookFocus(() => { workspace.innerHTML = presetWorkspaceView(this.settings, this.state()); });
        const list = workspace.querySelector('[data-preset-list]');
        if (list)
            list.scrollTop = scroll;
    }
    renderSources() {
        if (!this.settings || !this.container)
            return;
        if (this.page === 'worldbook') {
            const node = this.container.querySelector('[data-worldbook-settings]');
            if (node)
                this.preserveWorldbookFocus(() => { node.outerHTML = worldbookSettingsView(this.settings, this.worldbook, true); });
        }
        else if (this.page === 'model' && this.selectedKey.startsWith('layer:'))
            this.renderPreset();
    }
    preserveWorldbookFocus(render) {
        const root = this.container?.getRootNode();
        const active = root?.activeElement;
        const input = active instanceof HTMLInputElement && active.hasAttribute('data-worldbook-entry') ? active : null;
        const button = active instanceof HTMLButtonElement && active.closest('[data-worldbook-settings]') ? active : null;
        const scroll = this.container?.querySelector('.worldbook-entry-list')?.scrollTop ?? 0;
        render();
        const list = this.container?.querySelector('.worldbook-entry-list');
        if (list)
            list.scrollTop = scroll;
        if (!input && !button)
            return;
        const controls = this.container?.querySelectorAll('[data-worldbook-entry], [data-model-action]');
        const replacement = Array.from(controls ?? []).find(node => input
            ? node.dataset.worldbookEntry === input.dataset.worldbookEntry && node.dataset.worldbookName === input.dataset.worldbookName
            : node.dataset.modelAction === button.dataset.modelAction && node.dataset.entryId === button.dataset.entryId);
        if (replacement && !replacement.disabled)
            replacement.focus({ preventScroll: true });
    }
    message(text, error = false) {
        const status = this.container?.querySelector('[data-model-status]');
        if (status) {
            status.textContent = text;
            status.classList.toggle('is-error', error);
        }
    }
    syncSave() {
        const saved = this.isSaved();
        const line = this.container?.querySelector('.model-save-line');
        if (line)
            line.dataset.saved = String(saved);
        const button = this.container?.querySelector('[data-model-action="save-model"]');
        if (button)
            button.disabled = saved;
        this.message(saved ? '已保存在当前浏览器。' : '当前更改尚未保存。');
    }
    syncFilterStatus() {
        const node = this.container?.querySelector('[data-context-filter-status]');
        if (!node)
            return;
        const status = getContextFilterStatus();
        node.classList.toggle('is-error', Boolean(status.error));
        node.textContent = status.error || (status.active ? '已接入酒馆主 API 上下文隐藏。' : '酒馆主 API 上下文隐藏已关闭。');
    }
    edit(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) || !this.settings)
            return;
        const settings = this.settings;
        if (input instanceof HTMLSelectElement && input.hasAttribute('data-worldbook-name')) {
            if (this.worldbook.busy)
                return;
            this.worldbook.book = input.value;
            this.worldbook.previewId = undefined;
            void this.refreshWorldbooks(false);
            return;
        }
        if (input instanceof HTMLInputElement && input.hasAttribute('data-worldbook-entry')) {
            const name = input.dataset.worldbookName ?? this.worldbook.book;
            const id = input.dataset.worldbookEntry;
            if (this.worldbook.busy || name !== this.worldbook.book || (input.checked && !this.worldbook.entries.some(entry => entry.id === id && entry.enabled && entry.activation && entry.content.trim())))
                return;
            const selected = new Set(settings.worldbooks.find(book => book.name === name)?.entries ?? []);
            if (input.checked)
                selected.add(id);
            else
                selected.delete(id);
            this.setBookSelection(name, [...selected]);
            return;
        }
        const field = input.dataset.modelField;
        if (field) {
            switch (field) {
                case 'mode':
                    settings.mode = input.value === 'custom' ? 'custom' : 'tavern';
                    this.maskKey();
                    this.container.querySelector('[data-model-custom]').hidden = settings.mode !== 'custom';
                    this.container.querySelector('[data-model-tavern]').hidden = settings.mode !== 'tavern';
                    break;
                case 'url':
                case 'key':
                case 'model':
                case 'presetName':
                    settings[field] = input.value;
                    break;
                case 'parseImageMarkers':
                case 'hideImageContext':
                    settings[field] = input.checked;
                    break;
                case 'maxTokens':
                case 'temperature':
                    settings[field] = input.value === '' ? NaN : Number(input.value);
                    break;
                case 'transport':
                    if (['nonstream', 'stream', 'compatible'].includes(input.value))
                        settings.transport = input.value;
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
        }
        else if (input.dataset.promptField) {
            const id = input.closest('[data-entry-id]')?.dataset.entryId;
            const entry = [...settings.head, ...settings.tail].find(item => item.id === id);
            if (!entry)
                return;
            if (input.dataset.promptField === 'content' || input.dataset.promptField === 'name')
                entry[input.dataset.promptField] = input.value;
            if (input.dataset.promptField === 'role' && ['system', 'user', 'assistant'].includes(input.value))
                entry.role = input.value;
            if (input.dataset.promptField === 'name') {
                for (const node of Array.from(this.container.querySelectorAll('[data-preset-title]'))) {
                    if (node.dataset.presetTitle === `prompt:${entry.id}`)
                        node.textContent = entry.name || '未命名条目';
                }
            }
        }
        else if (input instanceof HTMLInputElement && (input.dataset.presetEnabled || input.dataset.layerId)) {
            const key = input.dataset.presetEnabled ?? `layer:${input.dataset.layerId}`;
            if (key.startsWith('layer:')) {
                const id = key.slice(6);
                settings.enabledLayers = input.checked ? [...new Set([...settings.enabledLayers, id])] : settings.enabledLayers.filter(item => item !== id);
            }
            else {
                const entry = [...settings.head, ...settings.tail].find(item => `prompt:${item.id}` === key);
                if (!entry || entry.marker)
                    return;
                entry.enabled = input.checked;
            }
        }
        else
            return;
        this.draftRevision++;
        this.syncSave();
    }
    click(event) {
        if (!(event.target instanceof Element) || !this.settings)
            return;
        const button = event.target.closest('[data-model-action]');
        if (!button || button.disabled)
            return;
        const action = button.dataset.modelAction;
        try {
            if (action === 'toggle-key') {
                const key = this.container.querySelector('[data-model-field="key"]');
                key.type = key.type === 'password' ? 'text' : 'password';
                button.textContent = key.type === 'password' ? '显示' : '隐藏';
                button.setAttribute('aria-pressed', String(key.type === 'text'));
            }
            else if (action === 'refresh-models')
                void this.refreshModels();
            else if (action === 'refresh-worldbooks')
                void this.refreshWorldbooks();
            else if (action === 'delete-worldbook')
                void this.removeWorldbook();
            else if (action === 'preview-worldbook-entry') {
                this.worldbook.previewId = button.dataset.entryId;
                this.renderSources();
            }
            else if (action === 'refresh-layer')
                void this.refreshPreview();
            else if (action === 'select-worldbook' || action === 'clear-worldbook') {
                this.setBookSelection(this.worldbook.book, action === 'clear-worldbook' ? [] : this.worldbook.entries.filter(entry => entry.enabled && entry.activation && entry.content.trim()).map(entry => entry.id));
            }
            else if (action === 'save-model') {
                for (const field of Array.from(this.container.querySelectorAll('input[type="number"]')))
                    if (!field.reportValidity())
                        return;
                saveModelSettings(this.settings);
                this.saved = JSON.stringify(this.settings);
                this.maskKey();
                this.syncSave();
            }
            else if (action === 'select-preset') {
                this.selectedKey = button.dataset.presetKey;
                this.previewRequest?.abort();
                this.preview = undefined;
                this.renderPreset();
                this.loadSelectedSource();
            }
            else if (action === 'add-entry') {
                if (this.settings.head.length + this.settings.tail.length >= MAX_PRESET_ENTRIES)
                    throw new Error('最多保留 200 条预设。');
                const id = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
                this.settings.head.push({ id, name: '新条目', role: 'system', content: '', enabled: true });
                const index = this.settings.promptOrder.indexOf(this.selectedKey);
                this.selectedKey = `prompt:${id}`;
                this.settings.promptOrder.splice(index < 0 ? this.settings.promptOrder.length : index + 1, 0, this.selectedKey);
                this.draftRevision++;
                this.renderPreset();
                this.syncSave();
                this.container?.querySelector('[data-prompt-field="name"]')?.focus();
            }
            else if (action === 'move-up' || action === 'move-down' || action === 'remove-entry') {
                const key = button.dataset.presetKey, order = this.settings.promptOrder;
                const index = order.indexOf(key);
                if (index < 0)
                    return;
                if (action === 'remove-entry') {
                    if (!key.startsWith('prompt:'))
                        return;
                    this.settings.head = this.settings.head.filter(item => `prompt:${item.id}` !== key);
                    this.settings.tail = this.settings.tail.filter(item => `prompt:${item.id}` !== key);
                    order.splice(index, 1);
                    if (this.selectedKey === key)
                        this.selectedKey = order[Math.min(index, order.length - 1)];
                }
                else {
                    const next = index + (action === 'move-up' ? -1 : 1);
                    if (next < 0 || next >= order.length)
                        return;
                    [order[index], order[next]] = [order[next], order[index]];
                }
                this.draftRevision++;
                this.renderPreset();
                this.syncSave();
                this.loadSelectedSource();
            }
        }
        catch (error) {
            this.message(error.message, true);
        }
    }
    setBookSelection(name, entries) {
        if (!name || !this.settings)
            return;
        const books = this.settings.worldbooks, index = books.findIndex(book => book.name === name);
        if (index >= 0) {
            if (entries.length)
                books[index].entries = entries;
            else
                books.splice(index, 1);
        }
        else if (entries.length)
            books.push({ name, entries });
        this.draftRevision++;
        this.renderSources();
        this.syncSave();
        if (this.page === 'model')
            void this.refreshPreview();
    }
    loadSelectedSource() {
        if (this.page === 'worldbook' || (this.page === 'model' && this.selectedKey === 'layer:worldbook'))
            void this.refreshWorldbooks(!this.booksLoaded);
        if (this.page === 'model' && this.selectedKey.startsWith('layer:'))
            void this.refreshPreview();
    }
    async refreshWorldbooks(reloadNames = true) {
        if (!this.container || !this.settings)
            return;
        this.bookRequest?.abort();
        const controller = new AbortController();
        this.bookRequest = controller;
        this.worldbook = { ...this.worldbook, entries: [], loading: true, error: '' };
        this.renderSources();
        try {
            if (reloadNames || !this.booksLoaded) {
                const names = await listWorldbooks(controller.signal);
                controller.signal.throwIfAborted();
                this.worldbook.names = names;
                this.booksLoaded = true;
            }
            this.worldbook.book ||= this.settings.worldbooks[0]?.name ?? this.worldbook.names[0] ?? '';
            if (this.worldbook.book)
                this.worldbook.entries = await readWorldbook(this.worldbook.book, controller.signal);
        }
        catch (error) {
            if (!controller.signal.aborted)
                this.worldbook.error = error instanceof Error ? error.message : '世界书读取失败。';
        }
        finally {
            if (this.bookRequest === controller && !controller.signal.aborted) {
                this.bookRequest = null;
                this.worldbook.loading = false;
                this.renderSources();
            }
        }
    }
    async refreshPreview() {
        if (!this.settings || !this.container || this.page !== 'model' || !this.selectedKey.startsWith('layer:'))
            return;
        this.previewRequest?.abort();
        const controller = new AbortController();
        this.previewRequest = controller;
        const key = this.selectedKey;
        this.preview = { key, text: '', loading: true };
        this.renderPreset();
        try {
            const settings = structuredClone(this.settings);
            const snapshot = key === 'layer:worldbook' ? await captureLatestAssistant() : null;
            controller.signal.throwIfAborted();
            const messages = await featureLayerMessages(key.slice(6), settings, { messages: [], sourceText: snapshot?.text ?? '', signal: controller.signal });
            if (snapshot) {
                try {
                    await assertChatSnapshot(snapshot);
                }
                catch {
                    throw new Error('聊天或正文状态已变化，请刷新世界书预览。');
                }
            }
            controller.signal.throwIfAborted();
            this.preview = { key, text: messages.map(message => message.content).join('\n\n'), loading: false };
        }
        catch (error) {
            if (!controller.signal.aborted)
                this.preview = { key, text: '', loading: false, error: error instanceof Error ? error.message : '内容读取失败。' };
        }
        finally {
            if (this.previewRequest === controller && !controller.signal.aborted) {
                this.previewRequest = null;
                if (this.selectedKey === key)
                    this.renderPreset();
            }
        }
    }
    presetMessage(text, error = false) {
        this.importNotice = text;
        this.importError = error;
        const status = this.container?.querySelector('[data-preset-status]');
        if (status) {
            status.textContent = text;
            status.classList.toggle('is-error', error);
        }
    }
    worldbookMessage(text, error = false) {
        this.worldbookNotice = text;
        this.worldbookError = error;
        const status = this.container?.querySelector('[data-worldbook-status]');
        if (status) {
            status.textContent = text;
            status.classList.toggle('is-error', error);
        }
        const input = this.container?.querySelector('[data-worldbook-file]');
        if (input)
            input.disabled = Boolean(this.worldbook.busy);
    }
    async importWorldbookFile(input) {
        const file = input.files?.[0];
        input.value = '';
        if (!file || !this.settings || this.worldbook.busy)
            return;
        const signal = this.listeners?.signal;
        this.worldbook.busy = true;
        this.worldbookMessage('正在上传世界书…');
        this.renderSources();
        try {
            if (file.size > 20 * 1024 * 1024)
                throw new Error('世界书文件不能超过 20 MiB。');
            const source = await file.text();
            if (signal?.aborted) {
                this.worldbookMessage('上传已取消，请重新选择文件。');
                return;
            }
            let value;
            try {
                value = JSON.parse(source.replace(/^\uFEFF/, ''));
            }
            catch {
                throw new Error('文件不是有效的 JSON。');
            }
            const name = await importWorldbook(value, file.name);
            if (!signal?.aborted) {
                this.worldbook.book = name;
                this.worldbook.previewId = undefined;
            }
            this.worldbookMessage(`已上传“${name}”。勾选要挂载的条目，再保存配置。`);
        }
        catch (error) {
            this.worldbookMessage(`上传失败：${error instanceof Error ? error.message : '无法读取文件。'}`, true);
        }
        finally {
            this.worldbook.busy = false;
            this.booksLoaded = false;
            this.worldbookMessage(this.worldbookNotice, this.worldbookError);
            this.loadSelectedSource();
        }
    }
    async removeWorldbook() {
        const name = this.worldbook.book;
        if (!name || !this.settings || this.worldbook.busy || !this.worldbook.names.includes(name))
            return;
        if (!window.confirm(`删除上传的世界书“${name}”？它的条目挂载也会移除。`))
            return;
        this.worldbook.busy = true;
        this.worldbookMessage('正在删除世界书…');
        this.renderSources();
        try {
            // Detach first: a failed deletion can leave a book available for re-selection,
            // but must never leave saved references that could match a later re-upload.
            detachStoredWorldbook(name);
            if (this.saved) {
                const saved = JSON.parse(this.saved);
                saved.worldbooks = saved.worldbooks.filter(book => book.name !== name);
                this.saved = JSON.stringify(saved);
            }
            this.setBookSelection(name, []);
            await deleteWorldbook(name);
            if (this.worldbook.book === name) {
                this.worldbook.book = '';
                this.worldbook.entries = [];
                this.worldbook.previewId = undefined;
            }
            this.worldbookMessage(`已删除“${name}”。`);
        }
        catch (error) {
            this.worldbookMessage(`删除失败：${error instanceof Error ? error.message : '无法删除世界书。'}`, true);
        }
        finally {
            this.worldbook.busy = false;
            this.booksLoaded = false;
            this.worldbookMessage(this.worldbookNotice, this.worldbookError);
            this.loadSelectedSource();
        }
    }
    async importPresetFile(input) {
        const file = input.files?.[0];
        input.value = '';
        if (!file || !this.settings)
            return;
        const request = ++this.importRequest, revision = this.draftRevision, settings = this.settings, signal = this.listeners?.signal;
        this.presetMessage('正在读取预设…');
        try {
            if (file.size > MAX_PRESET_BYTES)
                throw new Error('预设文件不能超过 2 MiB。');
            const source = await file.text();
            if (request !== this.importRequest || signal?.aborted || this.page !== 'model')
                return;
            if (revision !== this.draftRevision || settings !== this.settings)
                throw new Error('读取期间配置已有更改，请重新选择文件。');
            const imported = importModelPreset(source, file.name.replace(/\.json$/i, ''));
            const layers = settings.promptOrder.filter(key => key.startsWith('layer:')).map(key => key.slice(6));
            this.settings = { ...settings, presetName: imported.presetName, head: imported.head, tail: imported.tail,
                promptOrder: createPromptOrder(imported.head, imported.tail, layers) };
            this.selectedKey = this.settings.promptOrder[0];
            this.previewRequest?.abort();
            this.preview = undefined;
            this.draftRevision++;
            this.importNotice = `已导入“${imported.presetName || '未命名预设'}”，共 ${imported.head.length + imported.tail.length} 条；点击保存配置才会保留。${imported.warnings.join(' ')}`;
            this.importError = false;
            this.render();
            this.syncSave();
            this.loadSelectedSource();
        }
        catch (error) {
            if (request === this.importRequest && !signal?.aborted)
                this.presetMessage(`导入失败，原配置已保留：${error instanceof Error ? error.message : '无法读取文件。'}`, true);
        }
    }
    syncRefresh() {
        const button = this.container?.querySelector('[data-model-action="refresh-models"]');
        if (button) {
            button.disabled = this.refresh !== null;
            button.textContent = this.refresh ? '刷新中…' : '刷新列表';
        }
    }
    async refreshModels() {
        if (this.refresh || !this.settings || this.settings.mode !== 'custom')
            return;
        const controller = new AbortController();
        this.refresh = controller;
        this.syncRefresh();
        this.message('正在读取模型列表…');
        try {
            const models = await fetchModelList({ url: this.settings.url, key: this.settings.key }, controller.signal);
            if (controller.signal.aborted || this.refresh !== controller)
                return;
            this.settings.models = models;
            const list = this.container?.querySelector('datalist');
            if (list)
                list.innerHTML = models.map(model => `<option value="${escape(model)}"></option>`).join('');
            this.syncSave();
            this.message(models.length ? `已读取 ${models.length} 个模型，可选择或手动填写；点击保存保留配置。` : '接口未返回模型，可手动填写模型名称。');
        }
        catch (error) {
            if (!controller.signal.aborted)
                this.message(error.message, true);
        }
        finally {
            if (this.refresh === controller) {
                this.refresh = null;
                this.syncRefresh();
            }
        }
    }
}
