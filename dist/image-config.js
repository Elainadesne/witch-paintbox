import { loadImageSettings, saveImageSettings } from './image-settings.js';
import { imageSettingsView } from './image-view.js';
import { generateImage, validateImageConnection } from './novelai.js';
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
    imageUrl = '';
    imageSeed = 0;
    generationMessage = '';
    generationFailed = false;
    constructor() {
        try {
            this.settings = loadImageSettings();
            this.connection = { ...this.settings.connection };
            this.connectionId = this.settings.activeConnectionId;
            this.connectionName = this.settings.connectionProfiles.find(item => item.id === this.connectionId)?.name ?? '';
            this.artistName = this.settings.artists.find(item => item.id === this.settings.activeArtistId)?.name ?? '';
        }
        catch (error) {
            this.loadError = error.message;
        }
    }
    mount(container) {
        this.unmount();
        this.container = container;
        if (!this.settings) {
            const message = document.createElement('p');
            message.setAttribute('role', 'alert');
            message.textContent = this.loadError;
            container.replaceChildren(message);
            return;
        }
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => this.select(event), { signal });
        container.addEventListener('click', event => this.click(event), { signal });
        this.render();
    }
    unmount() {
        this.maskKey();
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
        if (!this.container || !this.settings)
            return;
        this.container.innerHTML = imageSettingsView({ ...this.settings, connection: this.connection, activeConnectionId: this.connectionId }, { connectionName: this.connectionName, artistName: this.artistName, connectionSaved: this.isConnectionSaved() });
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
    persist(area) {
        try {
            saveImageSettings(this.settings);
            this.message(area, '已保存在当前浏览器。');
        }
        catch (error) {
            this.message(area, error.message, true);
        }
    }
    edit(event) {
        const field = event.target;
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement))
            return;
        const settings = this.settings;
        const connectionField = field.dataset.connection;
        if (connectionField === 'channel' || connectionField === 'url' || connectionField === 'key') {
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
            this.persist('artist');
            return;
        }
        const parameter = field.dataset.parameter;
        if (!parameter || !Object.hasOwn(settings.parameters, parameter))
            return;
        if (field instanceof HTMLInputElement && !field.checkValidity())
            return;
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
        this.persist('settings');
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
        this.message('connection', saved ? '已保存在当前浏览器。' : '当前密钥配置尚未保存。');
    }
    syncParameters() {
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
    select(event) {
        const field = event.target;
        if (!(field instanceof HTMLSelectElement))
            return;
        const settings = this.settings;
        try {
            if (field.dataset.field === 'connectionProfile') {
                const profile = settings.connectionProfiles.find(item => item.id === field.value);
                if (profile) {
                    const connection = { channel: profile.channel, url: profile.url, key: profile.key };
                    const next = { ...settings, connection, activeConnectionId: profile.id };
                    saveImageSettings(next);
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
                saveImageSettings(next);
                this.settings = next;
                this.artistName = preset?.name ?? '';
                this.render();
            }
        }
        catch (error) {
            this.message(field.dataset.field === 'connectionProfile' ? 'connection' : 'artist', error.message, true);
            field.value = field.dataset.field === 'connectionProfile' ? this.connectionId : settings.activeArtistId;
        }
    }
    click(event) {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const action = target.closest('button[data-action]')?.dataset.action;
        if (!action)
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
                    this.saveConnection();
                    break;
                case 'save-artist':
                case 'update-artist':
                case 'delete-artist':
                    this.saveArtist(action);
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
            this.message(action === 'save-connection' ? 'connection' : 'artist', error.message, true);
        }
    }
    saveConnection() {
        const connection = validateImageConnection(this.connection);
        const name = this.connectionName.trim() || (connection.channel === 'official' ? 'NovelAI 官方' : new URL(connection.url).host);
        const id = this.connectionId || newId();
        const settings = this.settings;
        if (settings.connectionProfiles.some(item => item.id !== id && item.name === name)) {
            throw new Error('已有同名连接配置，请选中它后保存，或使用其他名称。');
        }
        const profile = { ...connection, id, name };
        const next = {
            ...settings, connection, activeConnectionId: id,
            connectionProfiles: settings.connectionProfiles.some(item => item.id === id)
                ? settings.connectionProfiles.map(item => item.id === id ? profile : item)
                : [...settings.connectionProfiles, profile],
        };
        saveImageSettings(next);
        this.settings = next;
        this.connection = { ...connection };
        this.connectionName = name;
        this.connectionId = id;
        this.render();
        this.message('connection', '已保存在当前浏览器。');
    }
    saveArtist(action) {
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
        saveImageSettings(next);
        this.settings = next;
        if (action === 'delete-artist')
            this.artistName = '';
        else
            this.artistName = this.artistName.trim();
        this.render();
        this.message('artist', action === 'delete-artist' ? '配置已删除，当前填写的提示词仍保留。' : '配置已保存在当前浏览器。');
    }
    async generate() {
        if (this.request)
            return;
        if (this.container) {
            const fields = this.container.querySelectorAll('[data-parameter]');
            for (const field of Array.from(fields)) {
                if (field.checkValidity())
                    continue;
                const drawer = field.closest('details');
                if (drawer)
                    drawer.open = true;
                field.reportValidity();
                return;
            }
        }
        this.generationFailed = false;
        if (!this.isConnectionSaved()) {
            this.generationMessage = '请先保存当前密钥配置。';
            this.generationFailed = true;
            this.syncGeneration();
            return;
        }
        const request = new AbortController();
        this.request = request;
        this.generationMessage = '正在生成图片…';
        this.syncGeneration();
        const snapshot = structuredClone(this.settings);
        try {
            const result = await generateImage(snapshot.connection, snapshot.parameters, snapshot.positive, snapshot.negative, request.signal);
            if (request.signal.aborted)
                return;
            const url = URL.createObjectURL(result.blob);
            if (this.imageUrl)
                URL.revokeObjectURL(this.imageUrl);
            this.imageUrl = url;
            this.imageSeed = result.seed;
            this.generationMessage = `生成完成 · 种子 ${result.seed}`;
        }
        catch (error) {
            this.generationFailed = true;
            this.generationMessage = request.signal.aborted ? '已取消等待。' : error.message;
        }
        finally {
            this.request = null;
            this.syncGeneration();
        }
    }
    syncGeneration() {
        if (!this.container)
            return;
        const busy = this.request !== null;
        const button = this.container.querySelector('[data-action="generate"]');
        button.disabled = busy;
        button.querySelector('strong').textContent = busy ? '正在生成…' : this.imageUrl ? '再次生成图片' : '点击生成图片';
        this.container.querySelector('[data-action="cancel-generation"]').hidden = !busy;
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
            download.download = `witch-paintbox-${this.imageSeed}.png`;
            download.textContent = '保存图片';
            output.replaceChildren(image, download);
            output.dataset.url = this.imageUrl;
        }
    }
}
