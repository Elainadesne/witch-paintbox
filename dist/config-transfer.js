import { archiveKeyCount, archiveUrlCount, exportArchive, MAX_ARCHIVE_BYTES, parseArchive, summarizeArchive } from './config-archive.js';
import { applyArchive, defaultImportModes, importSections, importSectionTitles, loadLocalConfig, mergeArchive } from './config-merge.js';
import { imageProviderName, loadImageSettings } from './image-settings.js';
function escape(value) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const scopeTitles = { all: '全部配置', artists: '画师串', presets: '预设', worldbooks: '世界书' };
const scopeDescriptions = {
    all: '包含 NAI / GPT / Gemini / Grok 各通道生图 API、参数、画师串和预设，以及共用模型 API、标签锚定（含角色图）、通用服装、世界书与使用偏好。',
    artists: '分享当前生图类型的命名画师配置、提示词及选用状态，文件会记录目标类型。',
    presets: '分享当前生图类型的预设名称、文本条目、编排顺序、功能层启用状态及共用标记开关。',
    worldbooks: '包含完整世界书库、原文条目，以及 NAI / GPT 两套已保存的挂载选择。',
};
const modeLabels = { skip: '跳过', overwrite: '覆盖' };
export class ConfigTransfer {
    context;
    onApplied;
    canApply;
    container = null;
    listeners = null;
    request = 0;
    phase = 'idle';
    kind = 'all';
    includeKeys = false;
    pending = null;
    notice = '';
    error = false;
    constructor(context, onApplied, canApply) {
        this.context = context;
        this.onApplied = onApplied;
        this.canApply = canApply;
    }
    get isApplying() { return this.phase === 'apply'; }
    mount(container) {
        this.unmount();
        this.container = container;
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('change', event => {
            const input = event.target;
            if (this.phase !== 'idle')
                return;
            if (input instanceof HTMLInputElement) {
                if (input.hasAttribute('data-transfer-keys'))
                    this.includeKeys = this.kind === 'all' && input.checked;
                if (input.hasAttribute('data-transfer-file'))
                    void this.readFile(input);
            }
        }, { signal });
        container.addEventListener('click', event => {
            if (!(event.target instanceof Element) || this.phase !== 'idle')
                return;
            const button = event.target.closest('button');
            if (!button || button.disabled)
                return;
            const kind = button.dataset.transferKind;
            if (kind && Object.hasOwn(scopeTitles, kind)) {
                this.kind = kind;
                if (this.kind !== 'all')
                    this.includeKeys = false;
                this.render();
                this.container?.querySelector(`[data-transfer-kind="${kind}"]`)?.focus();
                return;
            }
            const section = button.dataset.transferSection, mode = button.dataset.transferMode;
            if (this.pending && (mode === 'skip' || mode === 'overwrite')) {
                for (const item of importSections(this.pending.archive))
                    if (!section || item === section)
                        this.pending.modes[item] = mode;
                this.render();
                this.container?.querySelector(section ? `[data-transfer-section="${section}"][data-transfer-mode="${mode}"]` : `[data-transfer-all][data-transfer-mode="${mode}"]`)?.focus();
                return;
            }
            if (button.dataset.transferAction === 'export')
                void this.download();
            if (button.dataset.transferAction === 'confirm')
                void this.apply();
            if (button.dataset.transferAction === 'cancel') {
                this.pending = null;
                this.notice = '已取消导入，现有配置未改动。';
                this.error = false;
                this.render();
            }
        }, { signal });
        this.render();
    }
    unmount() {
        this.listeners?.abort();
        this.listeners = null;
        this.container = null;
        if (this.phase !== 'apply') {
            this.request++;
            if (this.phase !== 'idle')
                this.notice = '操作已取消，请重新选择文件或导出。';
            this.phase = 'idle';
        }
    }
    render() {
        if (!this.container)
            return;
        const busy = this.phase !== 'idle';
        const archive = this.pending?.archive;
        let details = new Map(), planError = '';
        if (this.pending) {
            try {
                details = mergeArchive(this.pending.archive, this.pending.local, this.pending.modes).details;
            }
            catch (error) {
                planError = error instanceof Error ? error.message : '无法按当前方式合并。';
            }
        }
        const modes = this.pending ? { ...defaultImportModes(this.pending.archive), ...this.pending.modes } : {};
        const sections = archive ? importSections(archive) : [];
        this.container.innerHTML = `<div class="image-settings transfer-settings">
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">01</span><h2 class="section-title">配置导出</h2><p class="section-description">选择要保存或分享的内容。</p></header>
        <div class="transfer-scope-options" role="group" aria-label="导出范围">${Object.keys(scopeTitles).map(kind => `<button type="button" data-transfer-kind="${kind}" aria-pressed="${this.kind === kind}"${busy ? ' disabled' : ''}>${scopeTitles[kind]}</button>`).join('')}</div>
        <p class="config-status">${scopeDescriptions[this.kind]}</p>
        ${this.kind === 'artists' || this.kind === 'presets' ? `<p class="config-status">本次导出：${imageProviderName(loadImageSettings().provider)}。</p>` : ''}
        ${this.kind === 'all' ? `<label class="prompt-enable"><input type="checkbox" data-transfer-keys${this.includeKeys ? ' checked' : ''}${busy ? ' disabled' : ''}>包含 API 密钥和相应 URL</label><p class="config-status">勾选后，NAI / GPT 两套生图 API（含已保存连接）与共用模型 API 的密钥、URL 会以明文写入文件；未勾选时一并清空导出文件中的密钥和 URL。</p>` : ''}
        <div class="transfer-actions"><button type="button" class="text-button" data-transfer-action="export"${busy ? ' disabled' : ''}>${this.phase === 'export' ? '正在整理…' : '导出 JSON'}</button></div>
        <p class="config-status">导出已保存的配置；请先保存其他页面的修改。已生成的图片历史不包含在配置文件内。</p>
      </section>
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">02</span><h2 class="section-title">配置导入</h2><p class="section-description">先查看文件包含什么，再确认是否应用。</p></header>
        <label class="config-field"><span>选择魔女画匣配置文件 · JSON</span><input type="file" data-transfer-file accept=".json,application/json"${busy ? ' disabled' : ''}></label>
        <p class="config-status">最大 128 MiB。选择文件仅进行校验，不会立即覆盖配置。</p>
        ${archive ? `<section class="transfer-review" tabindex="-1" aria-label="导入内容确认">
          <h3>校验通过 · ${scopeTitles[archive.kind]}</h3>
          <p class="config-status">${escape(this.pending.filename)} · 导出于 ${escape(new Date(archive.exportedAt).toLocaleString())}</p>
          <ul class="transfer-summary">${summarizeArchive(archive).map(row => `<li><strong>${escape(row.title)}</strong><br><span>${escape(row.detail)}</span></li>`).join('')}
            ${archive.kind === 'all' ? `<li><strong>API 密钥</strong><br><span>${archiveKeyCount(archive) ? `包含 ${archiveKeyCount(archive)} 处密钥，内容不在此展示。` : '未包含有效密钥；完整导入后需重新填写。'}</span></li>` : ''}
            ${archive.kind === 'all' ? `<li><strong>API 请求 URL</strong><br><span>${archiveUrlCount(archive) ? `包含 ${archiveUrlCount(archive)} 处请求 URL。` : '未包含请求 URL；完整导入后，自定义接口需重新填写地址。'}</span></li>` : ''}
          </ul>
          <h3>导入方式</h3>
          <p class="config-status">跳过：本地已有的同名条目和已经配置过的设置保持不变，只补充本地没有的内容。覆盖：同名条目和设置改用文件内容。本地独有的条目始终保留；文件没有密钥的 API 连接不会替换本地连接。生成图片历史不受影响。</p>
          ${sections.length > 1 ? `<div class="transfer-mode-all" role="group" aria-label="全部类别">${['skip', 'overwrite'].map(mode => `<button type="button" class="text-button" data-transfer-all data-transfer-mode="${mode}"${busy ? ' disabled' : ''}>全部${modeLabels[mode]}</button>`).join('')}</div>` : ''}
          <ul class="transfer-summary transfer-plan">${sections.map(section => `<li><div><strong>${importSectionTitles[section]}</strong><br><span>${escape(details.get(section) ?? '')}</span></div>
            <div class="transfer-mode" role="group" aria-label="${importSectionTitles[section]}的导入方式">${['skip', 'overwrite'].map(mode => `<button type="button" data-transfer-section="${section}" data-transfer-mode="${mode}" aria-pressed="${modes[section] === mode}"${busy ? ' disabled' : ''}>${modeLabels[mode]}</button>`).join('')}</div></li>`).join('')}
          </ul>
          ${planError ? `<p class="config-status is-error">无法按当前方式导入：${escape(planError)}</p>` : ''}
          <div class="transfer-actions"><button type="button" class="text-button" data-transfer-action="confirm"${busy || planError ? ' disabled' : ''}>${this.isApplying ? '正在导入…' : '确认导入以上配置'}</button><button type="button" class="text-button" data-transfer-action="cancel"${busy ? ' disabled' : ''}>取消</button></div>
        </section>` : ''}
      </section>
      <p class="config-status${this.error ? ' is-error' : ''}" data-transfer-status role="status">${escape(this.notice)}</p>
    </div>`;
    }
    async readFile(input) {
        const file = input.files?.[0];
        input.value = '';
        if (!file)
            return;
        const request = ++this.request;
        this.pending = null;
        this.phase = 'read';
        this.notice = '正在校验配置文件…';
        this.error = false;
        this.render();
        try {
            if (file.size > MAX_ARCHIVE_BYTES)
                throw new Error('配置文件不能超过 128 MiB。');
            const source = await file.text();
            if (request !== this.request)
                return;
            const archive = parseArchive(source);
            const local = await loadLocalConfig(archive, this.context);
            if (request !== this.request)
                return;
            this.pending = { filename: file.name, archive, local, modes: defaultImportModes(archive) };
            this.notice = '校验完成，请核对导入内容，并为每一类选择跳过或覆盖。';
        }
        catch (error) {
            if (request !== this.request)
                return;
            this.error = true;
            this.notice = `校验失败，现有配置未改动：${error instanceof Error ? error.message : '无法读取文件。'}`;
        }
        finally {
            if (request === this.request) {
                this.phase = 'idle';
                this.render();
                this.container?.querySelector('.transfer-review')?.focus();
            }
        }
    }
    async download() {
        const blocked = this.canApply();
        if (blocked) {
            this.notice = blocked;
            this.error = true;
            this.render();
            return;
        }
        const request = ++this.request, kind = this.kind, keys = kind === 'all' && this.includeKeys;
        this.phase = 'export';
        this.notice = '正在整理已保存的配置…';
        this.error = false;
        this.render();
        try {
            const blob = await exportArchive(kind, keys, this.context);
            if (request !== this.request)
                return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.hidden = true;
            link.href = url;
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
            link.download = `魔女画匣-${scopeTitles[kind]}${keys ? '-含密钥和URL' : ''}-${stamp}.json`;
            try {
                document.body.append(link);
                link.click();
            }
            finally {
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 30_000);
            }
            this.notice = '已创建配置文件并交给浏览器下载。';
        }
        catch (error) {
            if (request !== this.request)
                return;
            this.error = true;
            this.notice = `导出失败：${error instanceof Error ? error.message : '无法创建文件。'}`;
        }
        finally {
            if (request === this.request) {
                this.phase = 'idle';
                this.render();
            }
        }
    }
    async apply() {
        if (!this.pending)
            return;
        const blocked = this.canApply();
        if (blocked) {
            this.notice = blocked;
            this.error = true;
            this.render();
            return;
        }
        const { archive, modes } = this.pending;
        this.phase = 'apply';
        this.notice = '正在导入已确认的配置…';
        this.error = false;
        this.render();
        try {
            await applyArchive(archive, this.context, modes);
            this.onApplied(archive.kind, archive.kind === 'artists' || archive.kind === 'presets' ? archive.data.provider : undefined);
            this.pending = null;
            this.notice = archive.kind === 'all' ? '配置已导入，当前页面即可继续使用；使用偏好已提交酒馆保存。' : `${scopeTitles[archive.kind]}已导入，当前页面即可继续使用。`;
        }
        catch (error) {
            this.error = true;
            this.notice = error instanceof Error ? error.message : '配置导入失败。';
        }
        finally {
            this.phase = 'idle';
            this.render();
        }
    }
}
