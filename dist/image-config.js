import { loadImageSettings, saveImageSettings, switchImageProvider } from './image-settings.js';
import { imageSettingsView, OPENAI_SIZE_PRESETS } from './image-view.js';
import { NAI_SIZE_PRESETS, validateImageConnection } from './novelai.js';
import { fetchOpenAIImageModels, validateOpenAIImageConnection } from './openai-image.js';
import { generateConfiguredImage } from './image-provider.js';
import { imageFileExtension } from './raster-image.js';
function newId() {
    return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
export class ImageConfig {
    settings = null;
    loadError = '';
    connection = { channel: 'official', url: '', key: '' };
    connectionId = '';
    connectionName = '';
    artistName = '';
    container = null;
    listeners = null;
    request = null;
    modelRequest = null;
    modelOptions = [];
    imageUrl = '';
    imageFilename = 'witch-paintbox.png';
    generationMessage = '';
    generationFailed = false;
    generationPhase = 'queued';
    writing = false;
    pendingSaves = 0;
    saveRevision = 0;
    get hasPendingWrites() { return this.writing || this.pendingSaves > 0; }
    constructor() {
        this.reloadSaved();
    }
    reloadSaved(artistsOnly = false) {
        this.cancelModelRefresh();
        if (artistsOnly && this.settings) {
            const saved = loadImageSettings(this.settings.provider);
            this.settings = { ...this.settings, artists: saved.artists, positive: saved.positive, negative: saved.negative, activeArtistId: saved.activeArtistId };
            this.artistName = saved.artists.find(item => item.id === saved.activeArtistId)?.name ?? '';
            this.render();
            return;
        }
        const previousProvider = this.settings?.provider;
        this.settings = null;
        this.loadError = '';
        this.connection = { channel: 'official', url: '', key: '' };
        this.modelOptions = [];
        this.connectionId = this.connectionName = this.artistName = '';
        try {
            this.settings = loadImageSettings();
            if (previousProvider && previousProvider !== this.settings.provider) {
                this.request?.abort();
                this.clearOutput();
            }
            this.connection = { ...this.settings.connection };
            this.modelOptions = [...this.settings.models];
            this.connectionId = this.settings.activeConnectionId;
            this.connectionName = this.settings.connectionProfiles.find(item => item.id === this.connectionId)?.name ?? '';
            this.artistName = this.settings.artists.find(item => item.id === this.settings.activeArtistId)?.name ?? '';
        }
        catch (error) {
            this.loadError = error.message;
        }
        this.render();
    }
    mount(container) {
        this.unmount();
        this.container = container;
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => { void this.select(event); }, { signal });
        container.addEventListener('click', event => { void this.click(event); }, { signal });
        this.render();
    }
    unmount() {
        this.maskKey();
        this.cancelModelRefresh();
        this.listeners?.abort();
        this.container = null;
    }
    maskKey() {
        const input = this.container?.querySelector('[data-connection="key"]');
        if (input)
            input.type = 'password';
        const toggle = this.container?.querySelector('[data-action="toggle-key"]');
        if (toggle) {
            toggle.textContent = '显示';
            toggle.setAttribute('aria-pressed', 'false');
        }
    }
    destroy() {
        this.unmount();
        this.request?.abort();
        if (this.imageUrl)
            URL.revokeObjectURL(this.imageUrl);
    }
    isConnectionSaved() {
        const profile = this.settings?.connectionProfiles.find(item => item.id === this.connectionId);
        return !!profile && profile.name === this.connectionName
            && profile.channel === this.connection.channel && profile.url === this.connection.url
            && profile.key === this.connection.key && this.settings?.activeConnectionId === profile.id;
    }
    render() {
        if (!this.container)
            return;
        if (!this.settings) {
            const message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.textContent = this.loadError;
            this.container.replaceChildren(message);
            return;
        }
        this.container.innerHTML = imageSettingsView({ ...this.settings, connection: this.connection, activeConnectionId: this.connectionId, models: this.modelOptions }, { connectionName: this.connectionName, artistName: this.artistName, connectionSaved: this.isConnectionSaved(), refreshing: this.modelRequest !== null });
        this.syncParameters();
        this.syncGeneration();
    }
    message(area, text, error = false) {
        const node = this.container?.querySelector(`[data-${area}-status]`);
        if (!node)
            return;
        node.textContent = text;
        node.classList.toggle('is-error', error);
    }
    async persist(area) {
        const settings = this.settings;
        const revision = ++this.saveRevision;
        this.pendingSaves++;
        try {
            await saveImageSettings(structuredClone(settings));
            if (revision === this.saveRevision && this.settings === settings)
                this.message(area, '已保存。');
        }
        catch (error) {
            if (revision === this.saveRevision && this.settings === settings)
                this.message(area, error.message, true);
        }
        finally {
            this.pendingSaves--;
        }
    }
    async write(action) {
        if (this.writing)
            return;
        this.writing = true;
        const controls = Array.from(this.container?.querySelectorAll('input, select, textarea, button') ?? []);
        const disabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
            await action();
        }
        finally {
            this.writing = false;
            controls.forEach((control, index) => { if (control.isConnected)
                control.disabled = disabled[index]; });
            this.syncProviderButtons();
        }
    }
    edit(event) {
        if (this.writing)
            return;
        const field = event.target;
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement))
            return;
        const settings = this.settings;
        const connectionField = field.dataset.connection;
        if (connectionField === 'channel' || connectionField === 'url' || connectionField === 'key') {
            this.cancelModelRefresh();
            if (this.connection[connectionField] !== field.value)
                this.clearModels();
            if (connectionField === 'channel')
                this.connection.channel = field.value === 'custom' ? 'custom' : 'official';
            else
                this.connection[connectionField] = field.value;
            this.syncConnection();
            return;
        }
        if (field.dataset.field === 'connectionName') {
            this.connectionName = field.value;
            this.syncConnection();
            return;
        }
        if (field.dataset.field === 'artistName') {
            this.artistName = field.value;
            return;
        }
        if (field.dataset.field === 'positive' || field.dataset.field === 'negative') {
            settings[field.dataset.field] = field.value;
            void this.persist('artist');
            return;
        }
        const parameter = field.dataset.parameter;
        const parameters = settings.provider === 'openai' ? settings.openaiParameters : settings.parameters;
        if (!parameter || !Object.hasOwn(parameters, parameter))
            return;
        if (parameter === 'width' || parameter === 'height')
            this.syncSizePreset();
        if (field instanceof HTMLInputElement && !field.checkValidity())
            return;
        if (settings.provider === 'openai') {
            switch (parameter) {
                case 'model':
                    settings.openaiParameters.model = field.value;
                    break;
                case 'quality':
                    settings.openaiParameters.quality = field.value;
                    break;
                case 'width':
                case 'height':
                    if (field.value === '')
                        return;
                    settings.openaiParameters[parameter] = Number(field.value);
                    break;
            }
            void this.persist('settings');
            return;
        }
        switch (parameter) {
            case 'model':
            case 'sampler':
            case 'noiseSchedule':
                settings.parameters[parameter] = field.value;
                break;
            case 'sm':
            case 'smDyn':
                settings.parameters[parameter] = field.checked;
                break;
            case 'width':
            case 'height':
            case 'steps':
            case 'scale':
            case 'seed':
            case 'cfgRescale':
                if (field.value === '')
                    return;
                settings.parameters[parameter] = Number(field.value);
                break;
        }
        this.syncParameters();
        void this.persist('settings');
    }
    syncConnection() {
        const saved = this.isConnectionSaved();
        const line = this.container?.querySelector('.credential-line');
        if (line)
            line.dataset.saved = String(saved);
        const button = this.container?.querySelector('[data-action="save-connection"]');
        if (button)
            button.disabled = saved;
        const url = this.container?.querySelector('[data-custom-url]');
        if (url)
            url.hidden = this.connection.channel !== 'custom';
        this.message('connection', saved ? '已保存。' : '当前密钥配置尚未保存。');
    }
    syncParameters() {
        if (this.settings.provider === 'openai')
            return;
        const p = this.settings.parameters;
        const legacy = p.model === 'nai-diffusion-3';
        if (!legacy)
            p.sm = p.smDyn = false;
        if (!p.sm)
            p.smDyn = false;
        if (p.model.startsWith('nai-diffusion-5') || (!legacy && p.noiseSchedule === 'native'))
            p.noiseSchedule = 'karras';
        for (const key of ['sm', 'smDyn']) {
            const input = this.container?.querySelector(`[data-parameter="${key}"]`);
            if (input) {
                input.disabled = !legacy || (key === 'smDyn' && !p.sm);
                input.checked = p[key];
            }
        }
        const schedule = this.container?.querySelector('[data-parameter="noiseSchedule"]');
        if (schedule) {
            schedule.disabled = p.model.startsWith('nai-diffusion-5') || p.sampler === 'k_dpm_fast';
            schedule.value = p.noiseSchedule;
            const native = schedule.querySelector('option[value="native"]');
            if (native)
                native.disabled = !legacy;
        }
    }
    syncSizePreset() {
        const width = this.container?.querySelector('[data-parameter="width"]');
        const height = this.container?.querySelector('[data-parameter="height"]');
        const select = this.container?.querySelector('[data-field="sizePreset"]');
        if (width && height && select) {
            const presets = this.settings.provider === 'openai' ? OPENAI_SIZE_PRESETS : NAI_SIZE_PRESETS;
            select.value = presets.find(item => item.width === width.valueAsNumber && item.height === height.valueAsNumber)?.value ?? 'custom';
        }
    }
    async select(event) {
        if (this.writing)
            return;
        const field = event.target;
        if (!(field instanceof HTMLSelectElement))
            return;
        const settings = this.settings;
        if (field.dataset.field === 'sizePreset') {
            const presets = settings.provider === 'openai' ? OPENAI_SIZE_PRESETS : NAI_SIZE_PRESETS;
            const parameters = settings.provider === 'openai' ? settings.openaiParameters : settings.parameters;
            const preset = presets.find(item => item.value === field.value);
            if (preset) {
                for (const dimension of ['width', 'height']) {
                    parameters[dimension] = preset[dimension];
                    const input = this.container?.querySelector(`[data-parameter="${dimension}"]`);
                    if (input)
                        input.value = String(preset[dimension]);
                }
                void this.persist('settings');
            }
            return;
        }
        if (field.dataset.field !== 'connectionProfile' && field.dataset.field !== 'artistPreset')
            return;
        try {
            await this.write(async () => {
                if (field.dataset.field === 'connectionProfile') {
                    this.cancelModelRefresh();
                    this.clearModels();
                    const profile = settings.connectionProfiles.find(item => item.id === field.value);
                    if (profile) {
                        const connection = { channel: profile.channel, url: profile.url, key: profile.key };
                        const next = { ...settings, connection, activeConnectionId: profile.id };
                        await saveImageSettings(next);
                        this.settings = next;
                        this.connection = { ...connection };
                    }
                    else {
                        this.connection = { channel: 'official', url: '', key: '' };
                    }
                    this.connectionId = profile?.id ?? '';
                    this.connectionName = profile?.name ?? '';
                    this.render();
                }
                if (field.dataset.field === 'artistPreset') {
                    const preset = settings.artists.find(item => item.id === field.value);
                    const next = {
                        ...settings, activeArtistId: preset?.id ?? '',
                        positive: preset?.positive ?? settings.positive, negative: preset?.negative ?? settings.negative,
                    };
                    await saveImageSettings(next);
                    this.settings = next;
                    this.artistName = preset?.name ?? '';
                    this.render();
                }
            });
        }
        catch (error) {
            this.message(field.dataset.field === 'connectionProfile' ? 'connection' : 'artist', error.message, true);
            field.value = field.dataset.field === 'connectionProfile' ? this.connectionId : settings.activeArtistId;
        }
    }
    async click(event) {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const action = target.closest('button[data-action]')?.dataset.action;
        if (!action || this.writing)
            return;
        try {
            switch (action) {
                case 'toggle-key': {
                    const input = this.container.querySelector('[data-connection="key"]');
                    const button = target.closest('button');
                    input.type = input.type === 'password' ? 'text' : 'password';
                    button.textContent = input.type === 'password' ? '显示' : '隐藏';
                    button.setAttribute('aria-pressed', String(input.type === 'text'));
                    break;
                }
                case 'save-connection':
                    await this.write(() => this.saveConnection());
                    break;
                case 'switch-provider': {
                    const provider = target.closest('button')?.dataset.provider;
                    if (provider === 'novelai' || provider === 'openai')
                        await this.changeProvider(provider);
                    break;
                }
                case 'refresh-models':
                    void this.refreshModels();
                    break;
                case 'save-artist':
                case 'update-artist':
                case 'delete-artist':
                    await this.write(() => this.saveArtist(action));
                    break;
                case 'generate':
                    void this.generate();
                    break;
                case 'cancel-generation':
                    this.request?.abort();
                    break;
            }
        }
        catch (error) {
            this.message(action === 'save-connection' ? 'connection' : action === 'switch-provider' ? 'settings' : 'artist', error.message, true);
        }
    }
    async saveConnection() {
        this.cancelModelRefresh();
        const openai = this.settings.provider === 'openai';
        const connection = openai ? validateOpenAIImageConnection(this.connection) : validateImageConnection(this.connection);
        const name = this.connectionName.trim() || (connection.channel === 'official' ? openai ? 'OpenAI 官方' : 'NovelAI 官方' : new URL(connection.url).host);
        const id = this.connectionId || newId();
        const settings = this.settings;
        if (settings.connectionProfiles.some(item => item.id !== id && item.name === name)) {
            throw new Error('已有同名连接配置，请选中它后保存，或使用其他名称。');
        }
        const profile = { ...connection, id, name };
        const next = {
            ...settings, connection, activeConnectionId: id,
            models: settings.provider === 'openai' ? [...this.modelOptions] : settings.models,
            connectionProfiles: settings.connectionProfiles.some(item => item.id === id)
                ? settings.connectionProfiles.map(item => item.id === id ? profile : item)
                : [...settings.connectionProfiles, profile],
        };
        await saveImageSettings(next);
        this.settings = next;
        this.connection = { ...connection };
        this.connectionName = name;
        this.connectionId = id;
        this.render();
        this.message('connection', '已保存。');
    }
    async saveArtist(action) {
        const settings = this.settings;
        const current = settings.artists.find(item => item.id === settings.activeArtistId);
        let next;
        if (action === 'delete-artist') {
            if (!current)
                throw new Error('请先选择要删除的配置。');
            next = { ...settings, artists: settings.artists.filter(item => item.id !== current.id), activeArtistId: '' };
        }
        else {
            const name = this.artistName.trim();
            if (!name)
                throw new Error('请填写配置名称。');
            if (action === 'update-artist' && !current)
                throw new Error('请先选择要更新的配置。');
            const id = action === 'update-artist' ? current.id : newId();
            if (settings.artists.some(item => item.id !== id && item.name === name)) {
                throw new Error('已有同名配置，请使用“更新”，或填写其他名称后保存。');
            }
            const preset = { id, name, positive: settings.positive, negative: settings.negative };
            next = {
                ...settings, activeArtistId: id,
                artists: action === 'update-artist' ? settings.artists.map(item => item.id === id ? preset : item) : [...settings.artists, preset],
            };
        }
        await saveImageSettings(next);
        this.settings = next;
        if (action === 'delete-artist')
            this.artistName = '';
        else
            this.artistName = this.artistName.trim();
        this.render();
        this.message('artist', action === 'delete-artist' ? '配置已删除，当前填写的提示词仍保留。' : '配置已保存。');
    }
    validParameters() {
        const fields = this.container?.querySelectorAll('[data-parameter]') ?? [];
        for (const field of Array.from(fields)) {
            if (field.checkValidity())
                continue;
            const drawer = field.closest('details');
            if (drawer)
                drawer.open = true;
            field.reportValidity();
            return false;
        }
        return true;
    }
    clearOutput() {
        if (this.imageUrl)
            URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = '';
        this.generationMessage = '';
        this.generationFailed = false;
    }
    syncProviderButtons() {
        for (const button of Array.from(this.container?.querySelectorAll('[data-action="switch-provider"]') ?? [])) {
            button.disabled = this.writing || this.request !== null;
        }
    }
    async changeProvider(provider) {
        if (!this.settings || provider === this.settings.provider || this.request || !this.validParameters())
            return;
        this.cancelModelRefresh();
        await this.write(async () => {
            // The connection editor is a separate draft: switching never confirms an unsaved key.
            await saveImageSettings(structuredClone(this.settings));
            await switchImageProvider(provider);
            this.clearOutput();
            this.reloadSaved();
        });
    }
    cancelModelRefresh() {
        const refreshing = this.modelRequest !== null;
        this.modelRequest?.abort();
        this.modelRequest = null;
        this.syncModelRefresh();
        if (refreshing)
            this.message('model-list', '');
    }
    clearModels() {
        if (this.settings?.provider !== 'openai')
            return;
        this.modelOptions = [];
        this.settings.models = [];
        this.container?.querySelector('#witch-image-model-options')?.replaceChildren();
    }
    syncModelRefresh() {
        const button = this.container?.querySelector('[data-action="refresh-models"]');
        if (!button)
            return;
        button.disabled = this.writing || this.modelRequest !== null;
        button.textContent = this.modelRequest ? '刷新中…' : '刷新列表';
    }
    async refreshModels() {
        const settings = this.settings;
        if (!settings || settings.provider !== 'openai' || this.modelRequest)
            return;
        const request = new AbortController();
        this.modelRequest = request;
        this.syncModelRefresh();
        this.message('model-list', '正在获取模型列表…');
        const connection = { ...this.connection };
        const current = () => this.modelRequest === request && !request.signal.aborted && this.settings === settings;
        try {
            const models = await fetchOpenAIImageModels(connection, request.signal);
            if (!current())
                return;
            if (!models.length) {
                this.message('model-list', '接口没有返回可选模型，已保留原列表，可手动填写模型名称。');
                return;
            }
            this.modelOptions = models;
            const list = this.container?.querySelector('#witch-image-model-options');
            if (list) {
                const fragment = document.createDocumentFragment();
                for (const model of models) {
                    const option = document.createElement('option');
                    option.value = model;
                    fragment.append(option);
                }
                list.replaceChildren(fragment);
            }
            const savedConnection = settings.connection;
            const confirmed = connection.channel === savedConnection.channel && connection.url === savedConnection.url && connection.key === savedConnection.key;
            if (confirmed) {
                settings.models = models;
                this.pendingSaves++;
                try {
                    await saveImageSettings(structuredClone(settings));
                }
                finally {
                    this.pendingSaves--;
                }
            }
            if (current())
                this.message('model-list', `已获取 ${models.length} 个模型，当前填写的模型名称保持不变。${confirmed ? '' : '保存当前连接后会保留此列表。'}`);
        }
        catch (error) {
            if (current())
                this.message('model-list', error.message, true);
        }
        finally {
            if (this.modelRequest === request)
                this.modelRequest = null;
            this.syncModelRefresh();
        }
    }
    async generate() {
        if (this.request)
            return;
        if (!this.validParameters())
            return;
        this.generationFailed = false;
        if (!this.isConnectionSaved()) {
            this.generationMessage = '请先保存当前密钥配置。';
            this.generationFailed = true;
            this.syncGeneration();
            return;
        }
        const request = new AbortController();
        this.request = request;
        this.generationPhase = 'queued';
        this.generationMessage = '正在加入队列…';
        this.syncGeneration();
        const snapshot = structuredClone(this.settings);
        try {
            const result = await generateConfiguredImage(snapshot, snapshot.positive, request.signal, progress => {
                if (request.signal.aborted || this.settings?.provider !== snapshot.provider)
                    return;
                this.generationPhase = progress.state;
                this.generationMessage = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在生成图片…';
                this.syncGeneration();
            });
            if (request.signal.aborted || this.settings?.provider !== snapshot.provider)
                return;
            const url = URL.createObjectURL(result.blob);
            if (this.imageUrl)
                URL.revokeObjectURL(this.imageUrl);
            this.imageUrl = url;
            this.imageFilename = `witch-paintbox-${result.seed ?? Date.now()}.${imageFileExtension(result.blob)}`;
            this.generationMessage = result.seed === undefined ? '生成完成。' : `生成完成 · 种子 ${result.seed}`;
        }
        catch (error) {
            if (this.settings?.provider !== snapshot.provider)
                return;
            this.generationFailed = !request.signal.aborted;
            this.generationMessage = request.signal.aborted
                ? this.generationPhase === 'queued' ? '已取消排队。' : '已取消等待，服务端任务可能仍在继续。'
                : error.message;
        }
        finally {
            this.request = null;
            this.syncGeneration();
        }
    }
    syncGeneration() {
        if (!this.container || !this.settings)
            return;
        this.syncProviderButtons();
        const busy = this.request !== null;
        const button = this.container.querySelector('[data-action="generate"]');
        button.disabled = busy;
        button.querySelector('strong').textContent = busy ? this.generationPhase === 'queued' ? '已加入队列' : '正在生成…' : this.imageUrl ? '再次生成图片' : '点击生成图片';
        const cancel = this.container.querySelector('[data-action="cancel-generation"]');
        cancel.hidden = !busy;
        cancel.textContent = this.generationPhase === 'queued' ? '取消排队' : '取消等待';
        const message = this.container.querySelector('[data-generation-status]');
        message.textContent = this.generationMessage;
        message.classList.toggle('is-error', this.generationFailed);
        const output = this.container.querySelector('[data-output]');
        if (this.imageUrl && output.dataset.url !== this.imageUrl) {
            const image = document.createElement('img');
            image.src = this.imageUrl;
            image.alt = '本次生成的图片';
            const download = document.createElement('a');
            download.href = this.imageUrl;
            download.download = this.imageFilename;
            download.textContent = '保存图片';
            output.replaceChildren(image, download);
            output.dataset.url = this.imageUrl;
        }
        else if (!this.imageUrl && output.dataset.url) {
            output.replaceChildren();
            delete output.dataset.url;
        }
    }
}
