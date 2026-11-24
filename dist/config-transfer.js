import { archiveKeyCount, archiveUrlCount, exportArchive, MAX_ARCHIVE_BYTES, parseArchive, summarizeArchive } from './config-archive.js';
import { applyArchive, defaultImportModes, importSections, importSectionTitles, loadLocalConfig, mergeArchive } from './config-merge.js';
import { imageProviderName, loadImageSettings } from './image-settings.js';
function escape(value) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const scopeTitles = { all: '全部配置', artists: '画师串', presets: '预设', worldbooks: '世界书' };
const scopeDescriptions = {
    all: '打包带走 NAI / GPT / Gemini / Grok 全部生图接口、参数、画师串和预设，加上共用的模型 API、角色锚定（连带角色图）、通用服装、世界书、出图设置和使用偏好。',
    artists: '只分享当前这个生图服务下存好的画师串、正负面词和当前选中项（文件里会标明属于哪个服务）。',
    presets: '只分享当前这个生图服务下的预设名、各条文本、排序、功能层开关，以及共用的配图标记设置。',
    worldbooks: '打包全部上传的世界书和原文条目，连带 NAI / GPT / Gemini / Grok 四个通道各自保存好的挂载勾选。',
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
                this.notice = '导入取消了，原来的配置原封不动。';
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
                this.notice = '操作取消了，想继续就再挑个文件或重导一次。';
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
                planError = error instanceof Error ? error.message : '按现在选的办法没法合到一起。';
            }
        }
        const modes = this.pending ? { ...defaultImportModes(this.pending.archive), ...this.pending.modes } : {};
        const sections = archive ? importSections(archive) : [];
        this.container.innerHTML = `<div class="image-settings transfer-settings">
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">01</span><h2 class="section-title">配置导出</h2><p class="section-description">挑好你要留备份还是发给朋友的内容。</p></header>
        <div class="transfer-scope-options" role="group" aria-label="导出范围">${Object.keys(scopeTitles).map(kind => `<button type="button" data-transfer-kind="${kind}" aria-pressed="${this.kind === kind}"${busy ? ' disabled' : ''}>${scopeTitles[kind]}</button>`).join('')}</div>
        <p class="config-status">${scopeDescriptions[this.kind]}</p>
        ${this.kind === 'artists' || this.kind === 'presets' ? `<p class="config-status">本次导出：${imageProviderName(loadImageSettings().provider)}。</p>` : ''}
        ${this.kind === 'all' ? `<label class="prompt-enable"><input type="checkbox" data-transfer-keys${this.includeKeys ? ' checked' : ''}${busy ? ' disabled' : ''}>连着 API 密钥和地址一起导</label><p class="config-status">勾上的话，NAI / GPT / Gemini / Grok 全通道（包括存好的连接）以及共用模型 API 的密钥和 URL 都会明文写进文件里；不勾就会统统抹空再导出。</p>` : ''}
        <div class="transfer-actions"><button type="button" class="text-button" data-transfer-action="export"${busy ? ' disabled' : ''}>${this.phase === 'export' ? '正在整理…' : '导出 JSON'}</button></div>
        <p class="config-status">只会导出已经存进来的配置（如果刚改了标签锚定或通用服装，记得先过去点一下保存）。画好的图片历史太大了，不会打进这个包里。</p>
      </section>
      <section class="config-section"><header class="section-heading"><span class="section-index" aria-hidden="true">02</span><h2 class="section-title">配置导入</h2><p class="section-description">选完文件先看看里面都有啥，确认没问题再盖上去。</p></header>
        <label class="config-field"><span>选择魔女画匣配置文件 · JSON</span><input type="file" data-transfer-file accept=".json,application/json"${busy ? ' disabled' : ''}></label>
        <p class="config-status">文件最大支持 128 MiB。挑完文件只先做检查，不点确认绝不会动你现在用的配置。</p>
        ${archive ? `<section class="transfer-review" tabindex="-1" aria-label="导入内容确认">
          <h3>校验通过 · ${scopeTitles[archive.kind]}</h3>
          <p class="config-status">${escape(this.pending.filename)} · 导出于 ${escape(new Date(archive.exportedAt).toLocaleString())}</p>
          <ul class="transfer-summary">${summarizeArchive(archive).map(row => `<li><strong>${escape(row.title)}</strong><br><span>${escape(row.detail)}</span></li>`).join('')}
            ${archive.kind === 'all' ? `<li><strong>API 密钥</strong><br><span>${archiveKeyCount(archive) ? `包含 ${archiveKeyCount(archive)} 处密钥，内容不在此展示。` : '未包含有效密钥；完整导入后需重新填写。'}</span></li>` : ''}
            ${archive.kind === 'all' ? `<li><strong>API 请求 URL</strong><br><span>${archiveUrlCount(archive) ? `包含 ${archiveUrlCount(archive)} 处请求 URL。` : '未包含请求 URL；完整导入后，自定义接口需重新填写地址。'}</span></li>` : ''}
          </ul>
          <h3>导入方式</h3>
          <p class="config-status">“跳过”会留着你这边原本配好的设置和同名条目，只把你没有的新东西补进来；“覆盖”则会把重名条目和设置换成文件里的。你本地独有的东西怎么选都不会丢；如果导入文件里没带密钥，也不会把你本机配好的连接抹掉。已经画好的图片历史不受任何影响。</p>
          ${sections.length > 1 ? `<div class="transfer-mode-all" role="group" aria-label="全部类别">${['skip', 'overwrite'].map(mode => `<button type="button" class="text-button" data-transfer-all data-transfer-mode="${mode}"${busy ? ' disabled' : ''}>全部${modeLabels[mode]}</button>`).join('')}</div>` : ''}
          <ul class="transfer-summary transfer-plan">${sections.map(section => `<li><div><strong>${importSectionTitles[section]}</strong><br><span>${escape(details.get(section) ?? '')}</span></div>
            <div class="transfer-mode" role="group" aria-label="${importSectionTitles[section]}的导入方式">${['skip', 'overwrite'].map(mode => `<button type="button" data-transfer-section="${section}" data-transfer-mode="${mode}" aria-pressed="${modes[section] === mode}"${busy ? ' disabled' : ''}>${modeLabels[mode]}</button>`).join('')}</div></li>`).join('')}
          </ul>
          ${planError ? `<p class="config-status is-error">按现在选的方式导入不了：${escape(planError)}</p>` : ''}
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
        this.notice = '正在检查这个配置文件…';
        this.error = false;
        this.render();
        try {
            if (file.size > MAX_ARCHIVE_BYTES)
                throw new Error('这个文件超过 128 MiB 上限了，导不进来。');
            const source = await file.text();
            if (request !== this.request)
                return;
            const archive = parseArchive(source);
            const local = await loadLocalConfig(archive, this.context);
            if (request !== this.request)
                return;
            this.pending = { filename: file.name, archive, local, modes: defaultImportModes(archive) };
            this.notice = '检查过没问题，下面每一项请挑“跳过”还是“覆盖”吧。';
        }
        catch (error) {
            if (request !== this.request)
                return;
            this.error = true;
            this.notice = `文件没过校验，现在的配置没动：${error instanceof Error ? error.message : '打不开这个文件。'}`;
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
        this.notice = '正在打包存好的配置…';
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
            this.notice = '配置文件打好包，交给浏览器下载啦。';
        }
        catch (error) {
            if (request !== this.request)
                return;
            this.error = true;
            this.notice = `没导出来：${error instanceof Error ? error.message : '生成不了这个文件。'}`;
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
        this.notice = '正在往里写入确认好的配置…';
        this.error = false;
        this.render();
        try {
            await applyArchive(archive, this.context, modes);
            this.onApplied(archive.kind, archive.kind === 'artists' || archive.kind === 'presets' ? archive.data.provider : undefined);
            this.pending = null;
            this.notice = archive.kind === 'all' ? '全套配置都导进来啦，直接就能用；出图设置和使用偏好也已经交给酒馆保存。' : `${scopeTitles[archive.kind]}导进来啦，现在就能直接用。`;
        }
        catch (error) {
            this.error = true;
            this.notice = error instanceof Error ? error.message : '配置没能导进来。';
        }
        finally {
            this.phase = 'idle';
            this.render();
        }
    }
}
