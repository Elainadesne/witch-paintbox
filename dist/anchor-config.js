import { loadAnchors, saveAnchor, deleteAnchor, onAnchorsChanged, newAnchorId, ANCHOR_NAME_LIMIT, ANCHOR_ALIAS_LIMIT, ANCHOR_TAG_LIMIT, ANCHOR_PORTRAIT_LIMIT, } from './anchor-store.js';
import { getCurrentRoundImages } from './current-images.js';
import { imageHistoryPositive, onImageHistoryChanged } from './image-history.js';
import { watchChatRendering } from './chat-host.js';
import { loadImageSettings } from './image-settings.js';
import { generatePreparedImage } from './image-provider.js';
import { getHostStore } from './host-storage.js';
import { loadSharedOutfits, saveSharedOutfit, deleteSharedOutfit, onSharedOutfitsChanged, } from './shared-outfit-store.js';
import { emitPetEvent, petEnd, petFault, petTaskId, withFault } from './pet-events.js';
function escape(value) {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
/** Keep weighted groups together when the user selects tags by hand. */
function selectableTags(prompt) {
    const tags = [];
    const stack = [];
    const pairs = { '{': '}', '[': ']', '(': ')', '<': '>' };
    let weighted = false;
    let start = 0;
    for (let i = 0; i < prompt.length; i++) {
        const character = prompt[i];
        if (character === '\\') {
            i++;
            continue;
        }
        if (prompt.slice(i, i + 2) === '::') {
            weighted = !weighted;
            i++;
            continue;
        }
        if (weighted)
            continue;
        if (pairs[character])
            stack.push(pairs[character]);
        else if (character === stack.at(-1))
            stack.pop();
        else if (!stack.length && /[,，\r\n]/.test(character)) {
            const tag = prompt.slice(start, i).trim();
            if (tag)
                tags.push(tag);
            start = i + 1;
        }
    }
    const tail = prompt.slice(start).trim();
    if (tail)
        tags.push(tail);
    return tags;
}
export class AnchorConfig {
    container = null;
    listeners = null;
    unsubscribe = [];
    timer;
    roundRequest = 0;
    anchorsRequest = 0;
    tab = 'round';
    anchors = [];
    sharedOutfits = [];
    sharedOutfitsError = '';
    sharedDraft = null;
    sharedDirty = false;
    sharedDeleting = false;
    round = [];
    roundNotice = '正在读取本轮图片…';
    roundError = false;
    anchorsError = '';
    draft = null;
    negativeExpanded = false;
    sourcePrompt = '';
    dirty = false;
    busy = false;
    deleting = false;
    picker = null;
    urls = [];
    notice = '';
    failed = false;
    portraitRequest = null;
    portraitPhase = 'queued';
    portraitNotice = '';
    portraitError = false;
    portraitPet = null;
    get hasPendingWrites() { return this.busy || this.portraitRequest !== null; }
    mount(container, initialTab) {
        this.unmount();
        if (initialTab)
            this.tab = initialTab;
        this.container = container;
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('click', event => { void this.click(event); }, { signal });
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => this.change(event), { signal });
        this.unsubscribe = [
            onAnchorsChanged(() => { void this.refreshAnchors(); }),
            onSharedOutfitsChanged(() => this.refreshSharedOutfits()),
            onImageHistoryChanged(() => this.scheduleRound()),
            watchChatRendering(() => this.scheduleRound()),
        ];
        this.round = [];
        this.roundNotice = '正在读取本轮图片…';
        this.refreshSharedOutfits();
        this.render();
        void this.refreshAnchors();
        void this.refreshRound();
    }
    unmount() {
        this.listeners?.abort();
        this.unsubscribe.splice(0).forEach(stop => stop());
        clearTimeout(this.timer);
        this.roundRequest++;
        this.anchorsRequest++;
        this.releaseUrls();
        this.container = null;
    }
    destroy() { this.cancelPortrait(); this.unmount(); }
    releaseUrls() {
        this.urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    }
    image(blob, className) {
        if (!blob)
            return `<span class="${className} anchor-no-image" aria-label="尚未设置角色图">✦</span>`;
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        return `<img class="${className}" src="${url}" alt="" loading="lazy">`;
    }
    message(text, error = false) {
        this.notice = text;
        this.failed = error;
        const node = this.container?.querySelector('[data-anchor-status]');
        if (node) {
            node.textContent = text;
            node.classList.toggle('is-error', error);
        }
    }
    scheduleRound() {
        clearTimeout(this.timer);
        this.roundRequest++;
        this.round = [];
        this.roundNotice = '正在读取本轮图片…';
        this.roundError = false;
        if (this.tab === 'round')
            this.render();
        this.timer = setTimeout(() => { void this.refreshRound(); }, 180);
    }
    async refreshRound() {
        const request = ++this.roundRequest;
        try {
            const result = await getCurrentRoundImages();
            if (!this.container || request !== this.roundRequest)
                return;
            this.round = result.images;
            this.roundNotice = result.images.length ? '' : '本轮还没有已保存的图片。先点击最新 AI 回复中的“生成图片”，再来挑选角色。';
            this.roundError = false;
        }
        catch (error) {
            if (!this.container || request !== this.roundRequest)
                return;
            this.round = [];
            this.roundNotice = error instanceof Error ? error.message : '无法读取本轮图片，请重试。';
            this.roundError = true;
        }
        if (this.tab === 'round')
            this.render();
    }
    async refreshAnchors() {
        const request = ++this.anchorsRequest;
        try {
            const anchors = await loadAnchors();
            if (!this.container || request !== this.anchorsRequest)
                return;
            this.anchors = anchors;
            this.anchorsError = '';
        }
        catch (error) {
            if (!this.container || request !== this.anchorsRequest)
                return;
            this.anchorsError = error instanceof Error ? error.message : '无法读取角色，请重试。';
        }
        if (this.tab === 'anchors' && !this.draft && !this.busy)
            this.render();
    }
    refreshSharedOutfits() {
        try {
            this.sharedOutfits = loadSharedOutfits();
            this.sharedOutfitsError = '';
        }
        catch (error) {
            this.sharedOutfitsError = error instanceof Error ? error.message : '无法读取通用服装，请重试。';
        }
        if (this.tab === 'shared-outfits' && !this.sharedDraft && !this.busy)
            this.render();
    }
    render() {
        if (!this.container)
            return;
        this.releaseUrls();
        this.container.innerHTML = `<div class="image-settings anchor-settings">
      <nav class="anchor-tabs" aria-label="标签锚定页面">
        <button type="button" data-anchor-tab="round" aria-pressed="${this.tab === 'round'}">本轮生图</button>
        <button type="button" data-anchor-tab="anchors" aria-pressed="${this.tab === 'anchors'}">锚定配置</button>
        <button type="button" data-anchor-tab="shared-outfits" aria-pressed="${this.tab === 'shared-outfits'}">通用服装库</button>
      </nav>
      ${this.tab === 'round' ? this.roundView() : this.tab === 'shared-outfits' ? this.sharedDraft ? this.sharedEditorView() : this.sharedLibraryView() : this.draft ? this.editorView() : this.libraryView()}
      <p class="config-status${this.failed ? ' is-error' : ''}" data-anchor-status role="status">${escape(this.notice)}</p>
    </div>`;
        this.syncPortrait();
    }
    roundView() {
        return `<div class="anchor-toolbar"><p class="config-status">当前聊天最新 AI 回复的已生成图片。点击图片与 tag，配置单个角色。</p>
      <button type="button" class="text-button" data-anchor-action="refresh">刷新</button></div>
      ${this.roundNotice ? `<p class="anchor-empty${this.roundError ? ' is-error' : ''}" role="status">${escape(this.roundNotice)}</p>` : ''}
      <div class="anchor-round-grid">${this.round.map(item => `<button type="button" class="anchor-image-card" data-anchor-image="${escape(item.entry.id)}">
        ${this.image(item.entry.blob, 'anchor-round-image')}
        <span class="anchor-card-caption"><strong>${escape(item.summary)}</strong><span class="anchor-tag-excerpt">${escape(imageHistoryPositive(item.entry))}</span><span class="anchor-card-action">配置角色 →</span></span>
      </button>`).join('')}</div>`;
    }
    libraryView() {
        return `<div class="anchor-toolbar"><p class="config-status">固定外貌与服装分别保存；模型 API 的标签锚定条目会展示角色、别名与完整服装库。</p>
      <button type="button" class="text-button" data-anchor-action="new">新建角色</button></div>
      ${this.anchorsError ? `<p class="anchor-empty is-error" role="alert">${escape(this.anchorsError)}</p><button type="button" class="text-button" data-anchor-action="reload">重新读取</button>` : ''}
      ${!this.anchors.length && !this.anchorsError ? '<p class="anchor-empty">还没有锚定角色。可以从“本轮生图”挑一张图片，也可以直接新建。</p>' : ''}
      <div class="anchor-library">${this.anchors.map(anchor => `<article class="anchor-record">
        <button type="button" class="anchor-character" data-anchor-id="${escape(anchor.id)}">
          ${this.image(anchor.portrait, 'anchor-portrait')}
          <span><strong>${escape(anchor.name)}</strong>${anchor.aliases.length ? `<span class="anchor-aliases">又称：${escape(anchor.aliases.join('、'))}</span>` : ''}<span class="anchor-tag-excerpt">${escape(anchor.appearance)}</span></span>
          <span class="anchor-edit-label">编辑</span>
        </button>
        <ul class="anchor-wardrobe">${anchor.outfits.map(outfit => `<li><button type="button" data-anchor-id="${escape(anchor.id)}" data-anchor-outfit="${escape(outfit.id)}"><span>${escape(outfit.name)}</span>${anchor.selectedOutfitId === outfit.id ? '<small>当前服装</small>' : ''}</button></li>`).join('')}
          <li><button type="button" class="anchor-add-outfit" data-anchor-id="${escape(anchor.id)}" data-anchor-outfit="new">＋ 添加服装</button></li>
        </ul>
      </article>`).join('')}</div>`;
    }
    sharedLibraryView() {
        return `<div class="anchor-toolbar"><p class="config-status">保存可供角色共用的服装。用 #服装名调用时，未指定服装的 @角色 仅展开固定外貌，避免叠加默认装。</p>
      <button type="button" class="text-button" data-anchor-action="new-shared">新建通用服装</button></div>
      ${this.sharedOutfitsError ? `<p class="anchor-empty is-error" role="alert">${escape(this.sharedOutfitsError)}</p><button type="button" class="text-button" data-anchor-action="reload-shared">重新读取</button>` : ''}
      ${!this.sharedOutfits.length && !this.sharedOutfitsError ? '<p class="anchor-empty">还没有通用服装。点击“新建通用服装”，保存名称与服装 tag，便可在不同角色间使用。</p>' : ''}
      <div class="anchor-library">${this.sharedOutfits.map(outfit => `<button type="button" class="anchor-record shared-outfit-record" data-shared-outfit-id="${escape(outfit.id)}">
        <span class="shared-outfit-heading"><strong>${escape(outfit.name)}</strong><span class="anchor-edit-label">编辑</span></span>
        <span class="anchor-tag-excerpt">${escape(outfit.tags)}</span>
        <span class="shared-outfit-call">#${escape(outfit.name)}</span>
      </button>`).join('')}</div>`;
    }
    sharedEditorView() {
        const draft = this.sharedDraft;
        const exists = this.sharedOutfits.some(outfit => outfit.id === draft.id);
        return `<div class="anchor-toolbar"><h3 class="subsection-title">${exists ? '编辑通用服装' : '新建通用服装'}</h3><button type="button" class="text-button" data-anchor-action="back-shared"${this.busy ? ' disabled' : ''}>返回列表</button></div>
      <fieldset class="anchor-editor shared-outfit-editor"${this.busy ? ' disabled' : ''}>
        <label class="config-field"><span>服装名称</span><input type="text" data-shared-outfit-field="name" value="${escape(draft.name)}" maxlength="${ANCHOR_NAME_LIMIT}" placeholder="例如：旅行装" autocomplete="off"></label>
        <label class="config-field"><span>服装 tag</span><textarea rows="6" data-shared-outfit-field="tags" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(draft.tags)}</textarea></label>
        <p class="config-status">保存服装与配饰 tag，权重括号和 :: 写法原样保留；不自动筛选或修改内容。</p>
        <p class="anchor-usage">在生图提示词中用 <code>@角色, #服装名</code> 组合固定外貌与通用服装。每个调用独立成项，用逗号或换行分隔。若同时明确写了 <code>@角色:专属服装</code>，该专属服装仍会保留。</p>
        <div class="anchor-save-line"><button type="button" class="primary" data-anchor-action="save-shared"${!this.sharedDirty || this.busy ? ' disabled' : ''}>${this.busy ? '保存中…' : '保存通用服装'}</button>
          ${exists ? '<button type="button" class="text-button anchor-danger" data-anchor-action="delete-shared">删除服装</button>' : ''}</div>
        ${this.sharedDeleting ? '<div class="shared-outfit-delete-confirm" role="alert"><p>删除这套通用服装？角色自己的服装库不会受影响。</p><button type="button" class="text-button anchor-danger" data-anchor-action="confirm-delete-shared">确认删除</button><button type="button" class="text-button" data-anchor-action="cancel-delete-shared">取消</button></div>' : ''}
      </fieldset>`;
    }
    editorView() {
        const draft = this.draft;
        const exists = this.anchors.some(anchor => anchor.id === draft.id);
        return `<div class="anchor-toolbar"><h3 class="subsection-title">${exists ? '编辑角色' : '配置角色'}</h3><button type="button" class="text-button" data-anchor-action="back"${this.busy ? ' disabled' : ''}>返回列表</button></div>
      <fieldset class="anchor-editor"${this.busy ? ' disabled' : ''}>
        <div class="anchor-identity">${this.image(draft.portrait, 'anchor-editor-portrait')}
          <div class="anchor-identity-fields"><label class="config-field"><span>角色中文名称</span><input type="text" data-anchor-field="name" value="${escape(draft.name)}" maxlength="${ANCHOR_NAME_LIMIT}" placeholder="例如：莎莉" autocomplete="off"></label>
            <label class="config-field"><span>别名与称呼</span><textarea rows="3" data-anchor-field="aliases" spellcheck="false" placeholder="每行一个，也可用逗号分隔" aria-describedby="anchor-aliases-hint">${escape(draft.aliases.join('\n'))}</textarea></label>
            <p class="config-status" id="anchor-aliases-hint">每个称呼需含汉字，最多 ${ANCHOR_ALIAS_LIMIT} 个；可用换行、中英文逗号分隔。别名共用当前角色的外貌与服装。</p>
            <label class="config-field"><span>角色图</span><input type="file" accept="image/png,image/jpeg,image/webp" data-anchor-portrait></label>
            <div class="anchor-portrait-actions"><button type="button" class="text-button" data-anchor-action="generate-portrait"${this.portraitRequest ? ' disabled' : ''}>生成角色图</button><button type="button" class="text-button" data-anchor-action="cancel-portrait"${this.portraitRequest ? '' : ' hidden'}>取消</button></div>
            <p class="config-status anchor-portrait-hint">沿用生图 API 的参数与画师串，生成后点击“保存角色”保留。</p>
            <p class="config-status${this.portraitError ? ' is-error' : ''}" data-portrait-status role="status">${escape(this.portraitNotice)}</p>
            ${draft.portrait ? '<button type="button" class="text-button" data-anchor-action="remove-portrait">移除角色图</button>' : ''}
          </div>
        </div>
        <label class="config-field"><span>固定外貌 · base</span><textarea rows="5" data-anchor-field="appearance" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(draft.appearance)}</textarea></label>
        <div class="anchor-toolbar anchor-tag-tools"><p class="config-status">仅保留版权角色、发色发型、瞳色、肤色、体型与种族等固定特征；服装单独保存，表情、动作和场景留给当轮生图。由你确认保留的 tag，插件不会自动删改。</p><button type="button" class="text-button" data-anchor-action="pick-tags">筛选外貌 tag</button></div>
        ${this.pickerView()}
        ${this.sourcePrompt ? `<details class="anchor-source"><summary>查看这张图片的完整生成 tag</summary><pre>${escape(this.sourcePrompt)}</pre></details>` : ''}
        <div class="anchor-negative">
          ${this.negativeExpanded ? `<label class="config-field"><span>角色负面提示词</span><textarea rows="3" data-anchor-field="negative" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false" aria-describedby="anchor-negative-hint">${escape(draft.negative)}</textarea></label>
            <div class="anchor-toolbar"><p class="config-status" id="anchor-negative-hint">NAI 单串生图时加入全局负面词；多角色分栏时只加入该角色栏。GPT 不支持独立负面词。</p><button type="button" class="text-button" data-anchor-action="remove-negative">移除负面提示词</button></div>`
            : '<button type="button" class="text-button" data-anchor-action="add-negative">添加负面提示词</button>'}
        </div>
        <section class="anchor-outfit-section"><div class="anchor-toolbar"><h3 class="subsection-title">服装库</h3><button type="button" class="text-button" data-anchor-action="add-outfit">＋ 添加服装</button></div>
          <label class="config-field"><span>当前服装（默认）</span><select data-anchor-field="selectedOutfitId"><option value="">只用固定外貌</option>${draft.outfits.map(outfit => `<option value="${escape(outfit.id)}"${draft.selectedOutfitId === outfit.id ? ' selected' : ''}>${escape(outfit.name || '未命名服装')}</option>`).join('')}</select></label>
          <p class="config-status">当前选择作为 default；其他服装也会随角色资料提供给模型，供当轮选择。</p>
          <div class="anchor-outfit-editors">${draft.outfits.map(outfit => `<details class="anchor-outfit" data-outfit="${escape(outfit.id)}"${outfit.id === draft.selectedOutfitId || !outfit.name ? ' open' : ''}>
            <summary>${escape(outfit.name || '新服装')}</summary>
            <div class="anchor-outfit-fields"><label class="config-field"><span>服装名称</span><input type="text" data-outfit-field="name" maxlength="${ANCHOR_NAME_LIMIT}" value="${escape(outfit.name)}" placeholder="例如：日常装"></label>
              <label class="config-field"><span>服装 tag</span><textarea rows="3" data-outfit-field="tags" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(outfit.tags)}</textarea></label>
              <button type="button" class="text-button anchor-danger" data-anchor-action="remove-outfit">删除这套服装</button></div>
          </details>`).join('')}</div>
        </section>
        <div class="anchor-usage"><p><code>@角色</code> 使用固定外貌与默认服装；<code>@别名:服装</code> 指定角色服装；<code>@角色:无服装</code> 只使用固定外貌。称呼与角色名共用同一份配置。</p>
          <p>同一条提示词含 <code>#通用服装</code>，或独立的 nude、completely_nude、topless、bikini、swimsuit、nightgown、towel tag 时，未指定服装的 <code>@角色</code> 只展开 base。兼容空格、下划线与权重写法；明确指定的角色服装优先。</p>
          <p>调用需用逗号或换行与其他 tag 分隔，只匹配完整调用。旧的“角色名”“角色名/服装名”和“角色名/无服装”仍可使用，沿用原有服装规则；无前缀角色名仍携带默认服装。</p></div>
        <div class="anchor-save-line"><button type="button" class="primary" data-anchor-action="save"${!this.dirty || this.portraitRequest ? ' disabled' : ''}>${this.busy ? '保存中…' : '保存角色'}</button>
          ${exists ? `<button type="button" class="text-button anchor-danger" data-anchor-action="delete"${this.portraitRequest ? ' disabled' : ''}>删除角色</button>` : ''}</div>
        ${this.deleting ? '<div class="anchor-delete-confirm" role="alert"><p>删除这个角色及其服装库？原生成图片会保留。</p><button type="button" class="text-button anchor-danger" data-anchor-action="confirm-delete">确认删除</button><button type="button" class="text-button" data-anchor-action="cancel-delete">取消</button></div>' : ''}
      </fieldset>`;
    }
    pickerView() {
        if (!this.picker)
            return '';
        return `<section class="anchor-tag-picker" aria-label="选择要保留的外貌标签"><p class="config-status">勾选要留下的 tag；带括号的权重组会作为整体保留，也可在上方直接编辑。</p>
      <div class="anchor-tag-list">${this.picker.map((item, index) => `<label><input type="checkbox" data-tag-index="${index}"${item.keep ? ' checked' : ''}><span>${escape(item.tag)}</span></label>`).join('')}</div>
      <div class="anchor-picker-actions"><button type="button" class="text-button" data-anchor-action="select-none">取消全选</button><button type="button" class="text-button" data-anchor-action="apply-tags">应用所选</button><button type="button" class="text-button" data-anchor-action="close-picker">收起</button></div></section>`;
    }
    markDirty() {
        this.dirty = true;
        this.deleting = false;
        const button = this.container?.querySelector('[data-anchor-action="save"]');
        if (button)
            button.disabled = this.busy || this.portraitRequest !== null;
        this.container?.querySelector('.anchor-delete-confirm')?.remove();
        this.message('尚未保存。');
    }
    markSharedDirty() {
        this.sharedDirty = true;
        this.sharedDeleting = false;
        const button = this.container?.querySelector('[data-anchor-action="save-shared"]');
        if (button)
            button.disabled = this.busy;
        this.container?.querySelector('.shared-outfit-delete-confirm')?.remove();
        this.message('通用服装尚未保存。');
    }
    edit(event) {
        const field = event.target;
        if (this.busy || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement))
            return;
        const sharedKey = field.dataset.sharedOutfitField;
        if (this.sharedDraft && (sharedKey === 'name' || sharedKey === 'tags')) {
            this.sharedDraft[sharedKey] = field.value;
            this.markSharedDirty();
            return;
        }
        if (!this.draft)
            return;
        const key = field.dataset.anchorField;
        if (key === 'aliases') {
            this.draft.aliases = field.value.split(/[,，\r\n]+/).map(alias => alias.trim()).filter(Boolean);
            this.markDirty();
        }
        if (key === 'name' || key === 'appearance' || key === 'negative' || key === 'selectedOutfitId') {
            if (key !== 'name' && this.draft[key] !== field.value)
                this.cancelPortrait('角色提示词或服装已修改，已取消本次生成等待。');
            this.draft[key] = field.value;
            if (key === 'appearance') {
                this.picker = null;
                this.container?.querySelector('.anchor-tag-picker')?.remove();
            }
            this.markDirty();
        }
        const outfitKey = field.dataset.outfitField;
        if (outfitKey === 'name' || outfitKey === 'tags') {
            const details = field.closest('[data-outfit]');
            const outfit = this.draft.outfits.find(item => item.id === details?.dataset.outfit);
            if (!outfit)
                return;
            if (outfitKey === 'tags' && outfit.id === this.draft.selectedOutfitId && outfit.tags !== field.value)
                this.cancelPortrait('服装 tag 已修改，已取消本次生成等待。');
            outfit[outfitKey] = field.value;
            if (outfitKey === 'name') {
                details.querySelector('summary').textContent = field.value || '新服装';
                const option = Array.from(this.container.querySelectorAll('[data-anchor-field="selectedOutfitId"] option')).find(item => item.value === outfit.id);
                if (option)
                    option.textContent = field.value || '未命名服装';
            }
            this.markDirty();
        }
        if (field instanceof HTMLInputElement && field.dataset.tagIndex !== undefined && this.picker) {
            const tag = this.picker[Number(field.dataset.tagIndex)];
            if (tag)
                tag.keep = field.checked;
        }
    }
    change(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-anchor-portrait') || !this.draft || this.busy)
            return;
        const file = input.files?.[0];
        if (!file)
            return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > ANCHOR_PORTRAIT_LIMIT) {
            input.value = '';
            this.message('请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。', true);
            return;
        }
        this.cancelPortrait('已手动更换角色图，已取消本次生成等待。');
        this.draft.portrait = file;
        this.markDirty();
        this.render();
    }
    begin(anchor, source) {
        if (this.draft && this.dirty && !window.confirm('放弃当前尚未保存的角色修改？'))
            return false;
        this.cancelPortrait('已切换角色，已取消之前的生成等待。');
        this.draft = anchor ? structuredClone(anchor) : {
            id: newAnchorId(), name: '', aliases: [], appearance: source ? imageHistoryPositive(source.entry) : '', negative: '', outfits: [],
            selectedOutfitId: '', portrait: source?.entry.blob ?? null, updatedAt: Date.now(),
        };
        this.sourcePrompt = source ? imageHistoryPositive(source.entry) : '';
        this.negativeExpanded = !!this.draft.negative.trim();
        this.dirty = !anchor;
        this.deleting = false;
        this.picker = null;
        this.tab = 'anchors';
        this.notice = '';
        this.failed = false;
        if (!this.portraitRequest) {
            this.portraitNotice = '';
            this.portraitError = false;
        }
        this.render();
        this.container?.querySelector('[data-anchor-field="name"]')?.focus({ preventScroll: true });
        return true;
    }
    beginShared(outfit) {
        if (this.sharedDraft && this.sharedDirty && !window.confirm('放弃当前尚未保存的通用服装修改？'))
            return;
        this.sharedDraft = outfit ? { ...outfit } : { id: newAnchorId(), name: '', tags: '' };
        this.sharedDirty = !outfit;
        this.sharedDeleting = false;
        this.tab = 'shared-outfits';
        this.message('');
        this.render();
        this.container?.querySelector('[data-shared-outfit-field="name"]')?.focus({ preventScroll: true });
    }
    async commitShared(remove = false) {
        const draft = this.sharedDraft;
        if (!draft || this.busy)
            return;
        this.busy = true;
        this.render();
        try {
            if (remove)
                await deleteSharedOutfit(draft.id);
            else
                await saveSharedOutfit({ ...draft });
            this.refreshSharedOutfits();
            this.sharedDraft = null;
            this.sharedDirty = false;
            this.sharedDeleting = false;
            this.message(remove ? '通用服装已删除。' : getHostStore() ? '通用服装已保存到 TT 扩展数据。' : '通用服装已保存在当前浏览器。');
        }
        catch (error) {
            this.message(error instanceof Error ? error.message : '保存失败，修改仍保留在当前编辑页。', true);
        }
        finally {
            this.busy = false;
            this.render();
        }
    }
    addOutfit() {
        if (!this.draft)
            return;
        const outfit = { id: newAnchorId(), name: '', tags: '' };
        this.draft.outfits.push(outfit);
        this.markDirty();
        this.render();
        const details = Array.from(this.container.querySelectorAll('[data-outfit]')).find(item => item.dataset.outfit === outfit.id);
        details?.querySelector('input')?.focus();
    }
    async commit(remove = false) {
        const draft = this.draft;
        if (!draft || this.busy || this.portraitRequest)
            return;
        this.busy = true;
        this.render();
        try {
            const snapshot = structuredClone(draft);
            snapshot.updatedAt = Date.now();
            if (remove)
                await deleteAnchor(snapshot.id);
            else
                await saveAnchor(snapshot);
            // Only update the matching editor; navigation may have unmounted it.
            if (this.draft === draft) {
                this.anchors = remove ? this.anchors.filter(item => item.id !== snapshot.id)
                    : [...this.anchors.filter(item => item.id !== snapshot.id), { ...snapshot, name: snapshot.name.trim(), appearance: snapshot.appearance.trim(), negative: snapshot.negative.trim() }];
                this.draft = null;
                this.sourcePrompt = '';
                this.picker = null;
                this.dirty = false;
                this.deleting = false;
                this.message(remove ? '角色及服装库已删除。' : getHostStore() ? '角色与服装已保存到 TT 扩展数据。' : '角色与服装已保存在当前浏览器。');
            }
        }
        catch (error) {
            this.message(error instanceof Error ? error.message : '保存失败，修改仍保留在当前编辑页。', true);
        }
        finally {
            this.busy = false;
            this.render();
        }
    }
    syncPortrait() {
        const request = this.portraitRequest;
        const generate = this.container?.querySelector('[data-anchor-action="generate-portrait"]');
        if (generate) {
            generate.disabled = this.busy || request !== null;
            generate.textContent = !request ? '生成角色图' : request.signal.aborted ? '取消中…' : this.portraitPhase === 'queued' ? '排队中…' : '绘制中…';
        }
        const cancel = this.container?.querySelector('[data-anchor-action="cancel-portrait"]');
        if (cancel) {
            cancel.hidden = !request;
            cancel.disabled = !request || request.signal.aborted;
        }
        const status = this.container?.querySelector('[data-portrait-status]');
        if (status) {
            status.textContent = this.portraitNotice;
            status.classList.toggle('is-error', this.portraitError);
        }
        const save = this.container?.querySelector('[data-anchor-action="save"]');
        if (save)
            save.disabled = this.busy || request !== null || !this.dirty;
        const remove = this.container?.querySelector('[data-anchor-action="delete"]');
        if (remove)
            remove.disabled = this.busy || request !== null;
    }
    cancelPortrait(reason = '已取消本次角色图生成等待。') {
        const request = this.portraitRequest;
        if (!request || request.signal.aborted)
            return;
        request.abort();
        this.portraitNotice = reason + (this.portraitPhase === 'generating' ? '服务端任务可能仍在继续。' : '');
        this.portraitError = false;
        this.syncPortrait();
        const pet = this.portraitPet;
        if (pet)
            pet.end({ type: 'end', id: pet.id, task: 'image', source: 'portrait', result: 'cancelled', message: this.portraitNotice,
                serverMayContinue: this.portraitPhase === 'generating' });
    }
    async generatePortrait() {
        const draft = this.draft;
        if (!draft || this.busy || this.portraitRequest)
            return;
        const appearance = draft.appearance, negative = draft.negative, outfitId = draft.selectedOutfitId, portrait = draft.portrait;
        const outfitTags = draft.outfits.find(outfit => outfit.id === outfitId)?.tags ?? '';
        const current = () => this.draft === draft && draft.appearance === appearance && draft.negative === negative && draft.selectedOutfitId === outfitId
            && (draft.outfits.find(outfit => outfit.id === outfitId)?.tags ?? '') === outfitTags && draft.portrait === portrait;
        this.deleting = false;
        this.container?.querySelector('.anchor-delete-confirm')?.remove();
        const request = new AbortController();
        this.portraitRequest = request;
        this.portraitPhase = 'queued';
        const pet = petTaskId();
        const endPet = petEnd();
        const petImage = { type: 'end', id: pet, task: 'image', source: 'portrait' };
        this.portraitPet = { id: pet, end: endPet };
        this.portraitNotice = '正在加入生图队列…';
        this.portraitError = false;
        this.syncPortrait();
        try {
            if (!appearance.trim())
                throw withFault(new Error('请先填写角色的固定外貌 tag。'), 'setup');
            const settings = loadImageSettings();
            if (settings.provider === 'openai' && negative.trim()) {
                throw withFault(new Error('GPT 生图不支持角色独立负面提示词，请清空该角色的负面词或切换 NAI。'), 'setup');
            }
            emitPetEvent({ type: 'image', id: pet, source: 'portrait', phase: 'start', provider: settings.provider, summary: draft.name });
            const positive = [settings.positive, appearance, outfitTags].map(part => part.trim()).filter(Boolean).join(', ');
            const combinedNegative = [settings.negative, negative].map(part => part.trim()).filter(Boolean).join(', ');
            const result = await generatePreparedImage(settings, { positive, negative: combinedNegative, characters: [] }, request.signal, progress => {
                if (request.signal.aborted || !current())
                    return;
                this.portraitPhase = progress.state;
                this.portraitNotice = progress.state === 'queued' ? `等待绘制 · 队列第 ${progress.position} 位` : '正在生成角色图…';
                emitPetEvent({ type: 'image', id: pet, source: 'portrait', phase: progress.state,
                    position: progress.state === 'queued' ? progress.position : undefined });
                this.syncPortrait();
            });
            if (request.signal.aborted || !current()) {
                endPet({ ...petImage, result: 'dropped', paid: true, message: '' });
                return;
            }
            if (!result.blob.size || result.blob.size > ANCHOR_PORTRAIT_LIMIT)
                throw withFault(new Error('生成的角色图超过 10 MiB 或为空，请调小生图尺寸后重试。'), 'decode');
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.blob.type))
                throw withFault(new Error('生成结果不是支持的角色图片格式。'), 'decode');
            draft.portrait = result.blob;
            this.sourcePrompt = positive;
            this.dirty = true;
            this.deleting = false;
            this.portraitNotice = '角色图已生成，点击“保存角色”后保留。';
            endPet({ ...petImage, result: 'done', message: this.portraitNotice, picture: {
                    blob: result.blob, width: result.parameters.width, height: result.parameters.height,
                    target: () => this.container?.querySelector('.anchor-editor-portrait') ?? null,
                } });
            if (this.tab === 'anchors') {
                this.markDirty();
                this.render();
            }
        }
        catch (error) {
            if (!request.signal.aborted && current()) {
                this.portraitError = true;
                this.portraitNotice = error instanceof Error ? error.message : '角色图生成失败，请重试。';
                endPet({ ...petImage, result: 'failed', message: this.portraitNotice, fault: petFault(error) });
            }
        }
        finally {
            endPet({ ...petImage, result: 'dropped', message: '' });
            if (this.portraitRequest === request) {
                this.portraitRequest = null;
                this.syncPortrait();
            }
        }
    }
    async click(event) {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const button = target.closest('button');
        if (!button || button.disabled || this.busy)
            return;
        const tab = button.dataset.anchorTab;
        if (tab === 'round' || tab === 'anchors' || tab === 'shared-outfits') {
            this.tab = tab;
            this.message(tab === 'shared-outfits' && this.sharedDirty ? '通用服装尚未保存。' : tab === 'anchors' && this.dirty ? '角色修改尚未保存。' : '');
            this.render();
            if (tab === 'round')
                void this.refreshRound();
            if (tab === 'shared-outfits')
                this.refreshSharedOutfits();
            return;
        }
        if (button.dataset.sharedOutfitId) {
            const outfit = this.sharedOutfits.find(item => item.id === button.dataset.sharedOutfitId);
            if (outfit)
                this.beginShared(outfit);
            return;
        }
        if (button.dataset.anchorImage) {
            const source = this.round.find(item => item.entry.id === button.dataset.anchorImage);
            if (source)
                this.begin(undefined, source);
            return;
        }
        if (button.dataset.anchorId) {
            const anchor = this.anchors.find(item => item.id === button.dataset.anchorId);
            if (!anchor)
                return;
            if (!this.begin(anchor))
                return;
            if (button.dataset.anchorOutfit === 'new')
                this.addOutfit();
            else if (button.dataset.anchorOutfit) {
                const details = Array.from(this.container.querySelectorAll('[data-outfit]')).find(item => item.dataset.outfit === button.dataset.anchorOutfit);
                if (details) {
                    details.open = true;
                    details.querySelector('input')?.focus();
                }
            }
            return;
        }
        switch (button.dataset.anchorAction) {
            case 'refresh':
                await this.refreshRound();
                break;
            case 'reload':
                await this.refreshAnchors();
                break;
            case 'reload-shared':
                this.refreshSharedOutfits();
                break;
            case 'new':
                this.begin();
                break;
            case 'new-shared':
                this.beginShared();
                break;
            case 'back-shared':
                if (this.sharedDirty && !window.confirm('放弃当前尚未保存的通用服装修改？'))
                    return;
                this.sharedDraft = null;
                this.sharedDirty = false;
                this.sharedDeleting = false;
                this.message('');
                this.render();
                break;
            case 'save-shared':
                this.commitShared();
                break;
            case 'delete-shared':
                this.sharedDeleting = true;
                this.render();
                break;
            case 'cancel-delete-shared':
                this.sharedDeleting = false;
                this.render();
                break;
            case 'confirm-delete-shared':
                this.commitShared(true);
                break;
            case 'back':
                if (this.dirty && !window.confirm('放弃当前尚未保存的角色修改？'))
                    return;
                this.cancelPortrait();
                this.draft = null;
                this.picker = null;
                this.dirty = false;
                this.deleting = false;
                this.message('');
                this.render();
                break;
            case 'generate-portrait':
                await this.generatePortrait();
                break;
            case 'cancel-portrait':
                this.cancelPortrait();
                break;
            case 'remove-portrait':
                if (this.draft) {
                    this.cancelPortrait('角色图已移除，已取消本次生成等待。');
                    this.draft.portrait = null;
                    this.markDirty();
                    this.render();
                }
                break;
            case 'add-negative':
                if (!this.draft)
                    return;
                this.negativeExpanded = true;
                this.render();
                this.container?.querySelector('[data-anchor-field="negative"]')?.focus();
                break;
            case 'remove-negative':
                if (!this.draft)
                    return;
                if (this.draft.negative) {
                    this.cancelPortrait('角色负面词已移除，已取消本次生成等待。');
                    this.draft.negative = '';
                    this.markDirty();
                }
                this.negativeExpanded = false;
                this.render();
                this.container?.querySelector('[data-anchor-action="add-negative"]')?.focus();
                break;
            case 'add-outfit':
                this.addOutfit();
                break;
            case 'remove-outfit': {
                if (!this.draft)
                    return;
                const id = button.closest('[data-outfit]')?.dataset.outfit;
                if (this.draft.selectedOutfitId === id)
                    this.cancelPortrait('当前服装已移除，已取消本次生成等待。');
                this.draft.outfits = this.draft.outfits.filter(item => item.id !== id);
                if (this.draft.selectedOutfitId === id)
                    this.draft.selectedOutfitId = '';
                this.markDirty();
                this.render();
                break;
            }
            case 'pick-tags': {
                if (!this.draft)
                    return;
                const tags = selectableTags(this.draft.appearance);
                if (!tags.length) {
                    this.message('先填写或从图片带入外貌 tag。', true);
                    return;
                }
                if (tags.length > 512) {
                    this.message('标签较多，请直接在外貌文本中编辑。', true);
                    return;
                }
                this.picker = tags.map(tag => ({ tag, keep: true }));
                this.render();
                break;
            }
            case 'select-none':
                this.picker?.forEach(item => { item.keep = false; });
                this.render();
                break;
            case 'apply-tags':
                if (!this.draft || !this.picker)
                    return;
                if (!this.picker.some(item => item.keep)) {
                    this.message('请至少保留一个外貌 tag。', true);
                    return;
                }
                this.cancelPortrait('外貌 tag 已修改，已取消本次生成等待。');
                this.draft.appearance = this.picker.filter(item => item.keep).map(item => item.tag).join(', ');
                this.picker = null;
                this.markDirty();
                this.render();
                break;
            case 'close-picker':
                this.picker = null;
                this.render();
                break;
            case 'save':
                await this.commit();
                break;
            case 'delete':
                this.deleting = true;
                this.render();
                break;
            case 'cancel-delete':
                this.deleting = false;
                this.render();
                break;
            case 'confirm-delete':
                await this.commit(true);
                break;
        }
    }
}
