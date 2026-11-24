import {
  loadAnchors, saveAnchor, deleteAnchor, onAnchorsChanged, newAnchorId,
  ANCHOR_NAME_LIMIT, ANCHOR_ALIAS_LIMIT, ANCHOR_TAG_LIMIT, ANCHOR_PORTRAIT_LIMIT, type CharacterAnchor,
} from './anchor-store.js';
import { getCurrentRoundImages, type CurrentRoundImage } from './current-images.js';
import { imageHistoryPositive, onImageHistoryChanged } from './image-history.js';
import { watchChatRendering } from './chat-host.js';
import { imageProviderName, isNaturalLanguageProvider, loadImageSettings } from './image-settings.js';
import { generatePreparedImage } from './image-provider.js';
import { getHostStore } from './host-storage.js';
import {
  loadSharedOutfits, saveSharedOutfit, deleteSharedOutfit, onSharedOutfitsChanged, type SharedOutfit,
} from './shared-outfit-store.js';
import { emitPetEvent, petEnd, petFault, petTaskId, withFault, type PetEvent } from './pet-events.js';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Keep weighted groups together when the user selects tags by hand. */
function selectableTags(prompt: string): string[] {
  const tags: string[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' };
  let weighted = false;
  let start = 0;
  for (let i = 0; i < prompt.length; i++) {
    const character = prompt[i];
    if (character === '\\') { i++; continue; }
    if (prompt.slice(i, i + 2) === '::') { weighted = !weighted; i++; continue; }
    if (weighted) continue;
    if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) stack.pop();
    else if (!stack.length && /[,，\r\n]/.test(character)) {
      const tag = prompt.slice(start, i).trim();
      if (tag) tags.push(tag);
      start = i + 1;
    }
  }
  const tail = prompt.slice(start).trim();
  if (tail) tags.push(tail);
  return tags;
}

export type AnchorTab = 'round' | 'anchors' | 'shared-outfits';

export class AnchorConfig {
  private container: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private roundRequest = 0;
  private anchorsRequest = 0;
  private tab: AnchorTab = 'round';
  private anchors: CharacterAnchor[] = [];
  private sharedOutfits: SharedOutfit[] = [];
  private sharedOutfitsError = '';
  private sharedDraft: SharedOutfit | null = null;
  private sharedDirty = false;
  private sharedDeleting = false;
  private sharedPickerOpen = false;
  private sharedPickerSearch = '';
  private sharedPickerSelection = new Set<string>();
  private round: CurrentRoundImage[] = [];
  private roundNotice = '正在读取本轮图片…';
  private roundError = false;
  private anchorsError = '';
  private draft: CharacterAnchor | null = null;
  private negativeExpanded = false;
  private sourcePrompt = '';
  private dirty = false;
  private busy = false;
  private deleting = false;
  private picker: { tag: string; keep: boolean }[] | null = null;
  private urls: string[] = [];
  private notice = '';
  private failed = false;
  private portraitRequest: AbortController | null = null;
  private portraitPhase: 'queued' | 'generating' = 'queued';
  private portraitNotice = '';
  private portraitError = false;
  private portraitPet: { id: string; end: (event: Extract<PetEvent, { type: 'end' }>) => void } | null = null;

  get hasPendingWrites(): boolean { return this.busy || this.portraitRequest !== null; }

  mount(container: HTMLElement, initialTab?: AnchorTab): void {
    this.unmount();
    if (initialTab) this.tab = initialTab;
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

  unmount(): void {
    this.listeners?.abort();
    this.unsubscribe.splice(0).forEach(stop => stop());
    clearTimeout(this.timer);
    this.roundRequest++;
    this.anchorsRequest++;
    this.releaseUrls();
    this.container = null;
  }

  destroy(): void { this.cancelPortrait(); this.unmount(); }

  private releaseUrls(): void {
    this.urls.splice(0).forEach(url => URL.revokeObjectURL(url));
  }

  private image(blob: Blob | null, className: string): string {
    if (!blob) return `<span class="${className} anchor-no-image" aria-label="还没放角色图">✦</span>`;
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return `<img class="${className}" src="${url}" alt="" loading="lazy">`;
  }

  private message(text: string, error = false): void {
    this.notice = text;
    this.failed = error;
    const node = this.container?.querySelector<HTMLElement>('[data-anchor-status]');
    if (node) { node.textContent = text; node.classList.toggle('is-error', error); }
  }

  private scheduleRound(): void {
    clearTimeout(this.timer);
    this.roundRequest++;
    this.round = [];
    this.roundNotice = '正在读取本轮图片…';
    this.roundError = false;
    if (this.tab === 'round') this.render();
    this.timer = setTimeout(() => { void this.refreshRound(); }, 180);
  }

  private async refreshRound(): Promise<void> {
    const request = ++this.roundRequest;
    try {
      const result = await getCurrentRoundImages();
      if (!this.container || request !== this.roundRequest) return;
      this.round = result.images;
      this.roundNotice = result.images.length ? '' : '这一轮还没有已保存的图片。先在最新 AI 回复里点一次“生成图片”，再来这里挑角色。';
      this.roundError = false;
    } catch (error) {
      if (!this.container || request !== this.roundRequest) return;
      this.round = [];
      this.roundNotice = error instanceof Error ? error.message : '这一轮的图片没读出来，再试一次看看。';
      this.roundError = true;
    }
    if (this.tab === 'round') this.render();
  }

  private async refreshAnchors(): Promise<void> {
    const request = ++this.anchorsRequest;
    try {
      const anchors = await loadAnchors();
      if (!this.container || request !== this.anchorsRequest) return;
      this.anchors = anchors;
      this.anchorsError = '';
    } catch (error) {
      if (!this.container || request !== this.anchorsRequest) return;
      this.anchorsError = error instanceof Error ? error.message : '角色列表没读出来，再试一次。';
    }
    if (this.tab === 'anchors' && !this.draft && !this.busy) this.render();
  }

  private refreshSharedOutfits(): void {
    try {
      this.sharedOutfits = loadSharedOutfits();
      this.sharedOutfitsError = '';
    } catch (error) {
      this.sharedOutfitsError = error instanceof Error ? error.message : '通用服装没读出来，再试一次。';
    }
    if (this.tab === 'shared-outfits' && !this.sharedDraft && !this.busy) this.render();
    if (this.tab === 'anchors' && this.draft && !this.busy) this.updateSharedOutfitChoices();
  }

  private render(): void {
    if (!this.container) return;
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

  private roundView(): string {
    return `<div class="anchor-toolbar"><p class="config-status">这里列出最新一楼已经画好的图。点开就能挑出单人外貌 tag，存成固定角色。</p>
      <button type="button" class="text-button" data-anchor-action="refresh">刷新</button></div>
      ${this.roundNotice ? `<p class="anchor-empty${this.roundError ? ' is-error' : ''}" role="status">${escape(this.roundNotice)}</p>` : ''}
      <div class="anchor-round-grid">${this.round.map(item => `<button type="button" class="anchor-image-card" data-anchor-image="${escape(item.entry.id)}">
        ${this.image(item.entry.blob, 'anchor-round-image')}
        <span class="anchor-card-caption"><strong>${escape(item.summary)}</strong><span class="anchor-tag-excerpt">${escape(imageHistoryPositive(item.entry))}</span><span class="anchor-card-action">配置角色 →</span></span>
      </button>`).join('')}</div>`;
  }

  private libraryView(): string {
    return `<div class="anchor-toolbar"><p class="config-status">外貌和衣服分开存；启用标签锚定层时，角色名、别名和整套衣柜都会交给模型挑选。</p>
      <button type="button" class="text-button" data-anchor-action="new">新建角色</button></div>
      ${this.anchorsError ? `<p class="anchor-empty is-error" role="alert">${escape(this.anchorsError)}</p><button type="button" class="text-button" data-anchor-action="reload">重新读取</button>` : ''}
      ${!this.anchors.length && !this.anchorsError ? '<p class="anchor-empty">还没有存过角色。可以去“本轮生图”里从画好的图挑，也可以直接新建一个。</p>' : ''}
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

  private sharedLibraryView(): string {
    return `<div class="anchor-toolbar"><p class="config-status">存几套大家都能穿的通用服装。只要提示词里写了 #服装名，没单独点名衣服的 @角色 就只带出固定外貌，不会和默认衣服打架。</p>
      <button type="button" class="text-button" data-anchor-action="new-shared">新建通用服装</button></div>
      ${this.sharedOutfitsError ? `<p class="anchor-empty is-error" role="alert">${escape(this.sharedOutfitsError)}</p><button type="button" class="text-button" data-anchor-action="reload-shared">重新读取</button>` : ''}
      ${!this.sharedOutfits.length && !this.sharedOutfitsError ? '<p class="anchor-empty">还没有通用服装。点“新建通用服装”存一套进去，以后所有角色都能直接穿。</p>' : ''}
      <div class="anchor-library">${this.sharedOutfits.map(outfit => `<button type="button" class="anchor-record shared-outfit-record" data-shared-outfit-id="${escape(outfit.id)}">
        <span class="shared-outfit-heading"><strong>${escape(outfit.name)}</strong><span class="anchor-edit-label">编辑</span></span>
        <span class="anchor-tag-excerpt">${escape(outfit.tags)}</span>
        <span class="shared-outfit-call">#${escape(outfit.name)}</span>
      </button>`).join('')}</div>`;
  }

  private sharedEditorView(): string {
    const draft = this.sharedDraft!;
    const exists = this.sharedOutfits.some(outfit => outfit.id === draft.id);
    return `<div class="anchor-toolbar"><h3 class="subsection-title">${exists ? '编辑通用服装' : '新建通用服装'}</h3><button type="button" class="text-button" data-anchor-action="back-shared"${this.busy ? ' disabled' : ''}>返回列表</button></div>
      <fieldset class="anchor-editor shared-outfit-editor"${this.busy ? ' disabled' : ''}>
        <label class="config-field"><span>服装名称</span><input type="text" data-shared-outfit-field="name" value="${escape(draft.name)}" maxlength="${ANCHOR_NAME_LIMIT}" placeholder="例如：旅行装" autocomplete="off"></label>
        <label class="config-field"><span>服装 tag</span><textarea rows="6" data-shared-outfit-field="tags" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(draft.tags)}</textarea></label>
        <p class="config-status">填衣服和配饰 tag 就行，权重括号和 :: 写法会原样留着，插件不会自作主张帮你删改。</p>
        <p class="anchor-usage">写生图词时用 <code>@角色, #服装名</code> 就能把底子外貌和通用服装拼到一起（中间用逗号或换行隔开）。如果同时又写了 <code>@角色:专属服装</code>，那还是以角色自己的专属服装为准。</p>
        <div class="anchor-save-line"><button type="button" class="primary" data-anchor-action="save-shared"${!this.sharedDirty || this.busy ? ' disabled' : ''}>${this.busy ? '保存中…' : '保存通用服装'}</button>
          ${exists ? '<button type="button" class="text-button anchor-danger" data-anchor-action="delete-shared">删除服装</button>' : ''}</div>
        ${this.sharedDeleting ? '<div class="shared-outfit-delete-confirm" role="alert"><p>真要删掉这套通用服装？角色自己衣柜里的衣服不会受影响。</p><button type="button" class="text-button anchor-danger" data-anchor-action="confirm-delete-shared">确认删除</button><button type="button" class="text-button" data-anchor-action="cancel-delete-shared">取消</button></div>' : ''}
      </fieldset>`;
  }

  private editorView(): string {
    const draft = this.draft!;
    const exists = this.anchors.some(anchor => anchor.id === draft.id);
    return `<div class="anchor-toolbar"><h3 class="subsection-title">${exists ? '编辑角色' : '配置角色'}</h3><button type="button" class="text-button" data-anchor-action="back"${this.busy ? ' disabled' : ''}>返回列表</button></div>
      <fieldset class="anchor-editor"${this.busy ? ' disabled' : ''}>
        <div class="anchor-identity">${this.image(draft.portrait, 'anchor-editor-portrait')}
          <div class="anchor-identity-fields"><label class="config-field"><span>角色中文名称</span><input type="text" data-anchor-field="name" value="${escape(draft.name)}" maxlength="${ANCHOR_NAME_LIMIT}" placeholder="例如：莎莉" autocomplete="off"></label>
            <label class="config-field"><span>别名与称呼</span><textarea rows="3" data-anchor-field="aliases" spellcheck="false" placeholder="每行一个，也可用逗号分隔" aria-describedby="anchor-aliases-hint">${escape(draft.aliases.join('\n'))}</textarea></label>
            <p class="config-status" id="anchor-aliases-hint">每个称呼里至少带一个汉字，最多填 ${ANCHOR_ALIAS_LIMIT} 个，用换行或中英文逗号隔开都行。写哪个称呼都能认出这个角色。</p>
            <label class="config-field"><span>角色图</span><input type="file" accept="image/png,image/jpeg,image/webp" data-anchor-portrait></label>
            <div class="anchor-portrait-actions"><button type="button" class="text-button" data-anchor-action="generate-portrait"${this.portraitRequest ? ' disabled' : ''}>生成角色图</button><button type="button" class="text-button" data-anchor-action="cancel-portrait"${this.portraitRequest ? '' : ' hidden'}>取消</button></div>
            <p class="config-status anchor-portrait-hint">会直接套用你配好的生图参数和画师串；画满意了记得点下面的“保存角色”才会留下来。</p>
            <p class="config-status${this.portraitError ? ' is-error' : ''}" data-portrait-status role="status">${escape(this.portraitNotice)}</p>
            ${draft.portrait ? '<button type="button" class="text-button" data-anchor-action="remove-portrait">移除角色图</button>' : ''}
          </div>
        </div>
        <label class="config-field"><span>固定外貌 · base</span><textarea rows="5" data-anchor-field="appearance" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(draft.appearance)}</textarea></label>
        <div class="anchor-toolbar anchor-tag-tools"><p class="config-status">只留角色名、发色、瞳色、肤色、体型和种族这些底子特征；衣服放下面衣柜，表情动作和背景留给每一轮现写。你点选留下的 tag，插件不会私自改动。</p><button type="button" class="text-button" data-anchor-action="pick-tags">筛选外貌 tag</button></div>
        ${this.pickerView()}
        ${this.sourcePrompt ? `<details class="anchor-source"><summary>查看这张图片的完整生成 tag</summary><pre>${escape(this.sourcePrompt)}</pre></details>` : ''}
        <div class="anchor-negative">
          ${this.negativeExpanded ? `<label class="config-field"><span>角色负面提示词</span><textarea rows="3" data-anchor-field="negative" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false" aria-describedby="anchor-negative-hint">${escape(draft.negative)}</textarea></label>
            <div class="anchor-toolbar"><p class="config-status" id="anchor-negative-hint">NAI 单图会合并进全局负面；多人分栏时只加在对应角色那一栏。GPT 这边不吃角色独立负面词。</p><button type="button" class="text-button" data-anchor-action="remove-negative">移除负面提示词</button></div>`
            : '<button type="button" class="text-button" data-anchor-action="add-negative">添加负面提示词</button>'}
        </div>
        <section class="anchor-outfit-section"><div class="anchor-toolbar"><h3 class="subsection-title">服装库</h3><button type="button" class="text-button" data-anchor-action="add-outfit">＋ 添加服装</button></div>
          ${this.sharedOutfitPickerView()}
          <label class="config-field"><span>当前服装（默认）</span><select data-anchor-field="selectedOutfitId"><option value="">只用固定外貌</option>${draft.outfits.map(outfit => `<option value="${escape(outfit.id)}"${draft.selectedOutfitId === outfit.id ? ' selected' : ''}>${escape(outfit.name || '未命名服装')}</option>`).join('')}</select></label>
          <p class="config-status">选中的这套会当成默认装（default）；衣柜里别的衣服也会一并报给模型，方便它按剧情换装。</p>
          <div class="anchor-outfit-editors">${draft.outfits.map(outfit => `<details class="anchor-outfit" data-outfit="${escape(outfit.id)}"${outfit.id === draft.selectedOutfitId || !outfit.name ? ' open' : ''}>
            <summary>${escape(outfit.name || '新服装')}</summary>
            <div class="anchor-outfit-fields"><label class="config-field"><span>服装名称</span><input type="text" data-outfit-field="name" maxlength="${ANCHOR_NAME_LIMIT}" value="${escape(outfit.name)}" placeholder="例如：日常装"></label>
              <label class="config-field"><span>服装 tag</span><textarea rows="3" data-outfit-field="tags" maxlength="${ANCHOR_TAG_LIMIT}" spellcheck="false">${escape(outfit.tags)}</textarea></label>
              <button type="button" class="text-button anchor-danger" data-anchor-action="remove-outfit">删除这套服装</button></div>
          </details>`).join('')}</div>
        </section>
        <div class="anchor-usage"><p>写 <code>@角色</code> 会带上固定外貌和默认装；写 <code>@别名:服装</code> 指定穿某一套；写 <code>@角色:无服装</code> 就只展开固定外貌。正式名和别名都通用。</p>
          <p>要是同一串里出现了 <code>#通用服装</code>，或者写了独立的 nude、completely_nude、topless、bikini、swimsuit、nightgown、towel，没点名衣服的 <code>@角色</code> 会自动退回只展开 base。空格、下划线和权重写法都能认；写了专属服装的还是优先。</p>
          <p>记得用逗号或换行和别的 tag 隔开，防止误匹配。以前的“角色名”“角色名/服装名”和“角色名/无服装”旧写法照样能用；不加前缀直接写名字也会自动带默认服装。</p></div>
        <div class="anchor-save-line"><button type="button" class="primary" data-anchor-action="save"${!this.dirty || this.portraitRequest ? ' disabled' : ''}>${this.busy ? '保存中…' : '保存角色'}</button>
          ${exists ? `<button type="button" class="text-button anchor-danger" data-anchor-action="delete"${this.portraitRequest ? ' disabled' : ''}>删除角色</button>` : ''}</div>
        ${this.deleting ? '<div class="anchor-delete-confirm" role="alert"><p>连角色带她的衣服一起删掉？以前画好的图还会留着。</p><button type="button" class="text-button anchor-danger" data-anchor-action="confirm-delete">确认删除</button><button type="button" class="text-button" data-anchor-action="cancel-delete">取消</button></div>' : ''}
      </fieldset>`;
  }

  private sharedOutfitUnavailable(outfit: SharedOutfit): string {
    if (outfit.name === '无服装') return '“无服装”是保留字，不能当成衣服名';
    return this.draft?.outfits.some(item => item.name.trim() === outfit.name) ? '角色已有同名服装' : '';
  }

  private sharedOutfitChoicesView(): string {
    if (this.sharedOutfitsError) return `<p class="config-status is-error" role="alert">${escape(this.sharedOutfitsError)}</p><button type="button" class="text-button" data-anchor-action="reload-shared">重新读取</button>`;
    if (!this.sharedOutfits.length) return '<p class="config-status">通用服装库里还是空的。</p><button type="button" class="text-button" data-anchor-tab="shared-outfits">去通用服装库添一套 →</button>';
    const query = this.sharedPickerSearch.trim().toLocaleLowerCase();
    const matching = this.sharedOutfits.filter(outfit => outfit.name.toLocaleLowerCase().includes(query));
    return `<p class="config-status">${matching.length > 50 ? `找到 ${matching.length} 套，先显示前 50 套；可搜索缩小范围。` : matching.length ? `找到 ${matching.length} 套服装。` : '没有找到匹配的服装。'}</p>
      <div class="anchor-shared-choices">${matching.slice(0, 50).map(outfit => {
        const unavailable = this.sharedOutfitUnavailable(outfit);
        return `<label class="anchor-shared-choice"><input type="checkbox" data-shared-outfit-pick="${escape(outfit.id)}"${unavailable ? ' disabled' : this.sharedPickerSelection.has(outfit.id) ? ' checked' : ''}>
          <span><strong>${escape(outfit.name)}</strong>${unavailable ? `<small>${unavailable}</small>` : ''}<span class="anchor-tag-excerpt">${escape(outfit.tags)}</span></span></label>`;
      }).join('')}</div>`;
  }

  private sharedOutfitPickerView(): string {
    return `<div class="anchor-shared-picker">
      <button type="button" class="text-button" data-anchor-action="toggle-shared-picker" aria-expanded="${this.sharedPickerOpen}" aria-controls="anchor-shared-picker-panel">从通用服装添加</button>
      ${this.sharedPickerOpen ? `<div id="anchor-shared-picker-panel" class="anchor-shared-panel">
        <p class="config-status">勾好点导入，会把衣服名字和 Tag 抄进当前角色草稿，以后两边各改各的互不影响。加进去后记得在下面选成默认，并点“保存角色”。</p>
        <label class="config-field"><span>搜索通用服装</span><input type="search" data-shared-outfit-search value="${escape(this.sharedPickerSearch)}" maxlength="128" placeholder="按服装名称搜索" autocomplete="off"></label>
        <div data-shared-picker-results>${this.sharedOutfitChoicesView()}</div>
        <div class="actions"><button type="button" class="secondary" data-anchor-action="import-shared-outfits"${!this.sharedPickerSelection.size || this.sharedOutfitsError ? ' disabled' : ''}>添加所选服装${this.sharedPickerSelection.size ? `（${this.sharedPickerSelection.size} 套）` : ''}</button></div>
      </div>` : ''}
    </div>`;
  }

  private updateSharedOutfitChoices(): void {
    for (const id of this.sharedPickerSelection) {
      const outfit = this.sharedOutfits.find(item => item.id === id);
      if (!outfit || this.sharedOutfitUnavailable(outfit)) this.sharedPickerSelection.delete(id);
    }
    const results = this.container?.querySelector<HTMLElement>('[data-shared-picker-results]');
    if (results) results.innerHTML = this.sharedOutfitChoicesView();
    this.syncSharedOutfitSelection();
  }

  private syncSharedOutfitSelection(): void {
    const button = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="import-shared-outfits"]');
    if (button) {
      button.disabled = this.busy || !this.sharedPickerSelection.size || !!this.sharedOutfitsError;
      button.textContent = `添加所选服装${this.sharedPickerSelection.size ? `（${this.sharedPickerSelection.size} 套）` : ''}`;
    }
  }

  private importSharedOutfits(): void {
    if (!this.draft || !this.sharedPickerSelection.size) return;
    try {
      // Read the saved library again: a selection can outlive another tab's edits or deletions.
      const latest = loadSharedOutfits();
      const selected = latest.filter(outfit => this.sharedPickerSelection.has(outfit.id));
      if (selected.length !== this.sharedPickerSelection.size) {
        this.refreshSharedOutfits();
        this.message('通用服装库刚变过，核对一下再重选吧。', true);
        return;
      }
      this.sharedOutfits = latest;
      this.sharedOutfitsError = '';
      let added = 0, skipped = 0;
      for (const outfit of selected) {
        if (this.sharedOutfitUnavailable(outfit)) { ++skipped; continue; }
        this.draft.outfits.push({ id: newAnchorId(), name: outfit.name, tags: outfit.tags });
        ++added;
      }
      this.sharedPickerSelection.clear();
      if (added) {
        this.sharedPickerOpen = false;
        this.sharedPickerSearch = '';
        this.markDirty();
      }
      this.render();
      if (added) this.container?.querySelector<HTMLSelectElement>('[data-anchor-field="selectedOutfitId"]')?.focus({ preventScroll: true });
      this.message(added ? `加上了 ${added} 套服装${skipped ? `，有 ${skipped} 套重名或撞了保留字跳过了` : ''}。可以在“当前服装（默认）”里选它，点“保存角色”生效。`
        : '挑的这几套都已经有了或者撞了保留字，没覆盖角色原有的衣服。');
    } catch (error) {
      this.message(error instanceof Error ? error.message : '没读出通用服装，再试一次。', true);
    }
  }

  private pickerView(): string {
    if (!this.picker) return '';
    return `<section class="anchor-tag-picker" aria-label="选择要保留的外貌标签"><p class="config-status">勾上想留下的 tag 就行；带括号的权重组会整组保留，也可以直接在上面输入框里手改。</p>
      <div class="anchor-tag-list">${this.picker.map((item, index) => `<label><input type="checkbox" data-tag-index="${index}"${item.keep ? ' checked' : ''}><span>${escape(item.tag)}</span></label>`).join('')}</div>
      <div class="anchor-picker-actions"><button type="button" class="text-button" data-anchor-action="select-none">取消全选</button><button type="button" class="text-button" data-anchor-action="apply-tags">应用所选</button><button type="button" class="text-button" data-anchor-action="close-picker">收起</button></div></section>`;
  }

  private markDirty(): void {
    this.dirty = true;
    this.deleting = false;
    const button = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="save"]');
    if (button) button.disabled = this.busy || this.portraitRequest !== null;
    this.container?.querySelector('.anchor-delete-confirm')?.remove();
    this.message('还没保存。');
  }

  private markSharedDirty(): void {
    this.sharedDirty = true;
    this.sharedDeleting = false;
    const button = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="save-shared"]');
    if (button) button.disabled = this.busy;
    this.container?.querySelector('.shared-outfit-delete-confirm')?.remove();
    this.message('这套通用服装还没保存。');
  }

  private edit(event: Event): void {
    const field = event.target;
    if (this.busy || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
    const sharedKey = field.dataset.sharedOutfitField;
    if (this.sharedDraft && (sharedKey === 'name' || sharedKey === 'tags')) {
      this.sharedDraft[sharedKey] = field.value;
      this.markSharedDirty();
      return;
    }
    if (!this.draft) return;
    if (field.hasAttribute('data-shared-outfit-search')) {
      this.sharedPickerSearch = field.value;
      this.updateSharedOutfitChoices();
      return;
    }
    if (field instanceof HTMLInputElement && field.dataset.sharedOutfitPick) {
      const outfit = this.sharedOutfits.find(item => item.id === field.dataset.sharedOutfitPick);
      if (outfit && !this.sharedOutfitUnavailable(outfit)) {
        if (field.checked) this.sharedPickerSelection.add(outfit.id);
        else this.sharedPickerSelection.delete(outfit.id);
      }
      this.syncSharedOutfitSelection();
      return;
    }
    const key = field.dataset.anchorField;
    if (key === 'aliases') {
      this.draft.aliases = field.value.split(/[,，\r\n]+/).map(alias => alias.trim()).filter(Boolean);
      this.markDirty();
    }
    if (key === 'name' || key === 'appearance' || key === 'negative' || key === 'selectedOutfitId') {
      if (key !== 'name' && this.draft[key] !== field.value) this.cancelPortrait('刚改了角色设定，这次生成已经停下了。');
      this.draft[key] = field.value;
      if (key === 'appearance') { this.picker = null; this.container?.querySelector('.anchor-tag-picker')?.remove(); }
      this.markDirty();
    }
    const outfitKey = field.dataset.outfitField;
    if (outfitKey === 'name' || outfitKey === 'tags') {
      const details = field.closest<HTMLDetailsElement>('[data-outfit]');
      const outfit = this.draft.outfits.find(item => item.id === details?.dataset.outfit);
      if (!outfit) return;
      if (outfitKey === 'tags' && outfit.id === this.draft.selectedOutfitId && outfit.tags !== field.value) this.cancelPortrait('刚改了服装 tag，这次生成已经停下了。');
      outfit[outfitKey] = field.value;
      if (outfitKey === 'name') {
        details!.querySelector('summary')!.textContent = field.value || '新服装';
        const option = Array.from(this.container!.querySelectorAll<HTMLOptionElement>('[data-anchor-field="selectedOutfitId"] option')).find(item => item.value === outfit.id);
        if (option) option.textContent = field.value || '未命名服装';
      }
      this.markDirty();
    }
    if (field instanceof HTMLInputElement && field.dataset.tagIndex !== undefined && this.picker) {
      const tag = this.picker[Number(field.dataset.tagIndex)];
      if (tag) tag.keep = field.checked;
    }
  }

  private change(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-anchor-portrait') || !this.draft || this.busy) return;
    const file = input.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > ANCHOR_PORTRAIT_LIMIT) {
      input.value = '';
      this.message('得选 10 MB 以内的 PNG、JPEG 或 WebP 图片。', true);
      return;
    }
    this.cancelPortrait('你换了新图片，原本这次等待生成就先取消了。');
    this.draft.portrait = file;
    this.markDirty();
    this.render();
  }

  private begin(anchor?: CharacterAnchor, source?: CurrentRoundImage): boolean {
    if (this.draft && this.dirty && !window.confirm('刚改的内容还没保存，真要丢掉吗？')) return false;
    this.cancelPortrait('切去别的角色了，刚才那张图的等待先取消。');
    this.draft = anchor ? structuredClone(anchor) : {
      id: newAnchorId(), name: '', aliases: [], appearance: source ? imageHistoryPositive(source.entry) : '', negative: '', outfits: [],
      selectedOutfitId: '', portrait: source?.entry.blob ?? null, updatedAt: Date.now(),
    };
    this.sharedPickerOpen = false;
    this.sharedPickerSearch = '';
    this.sharedPickerSelection.clear();
    this.sourcePrompt = source ? imageHistoryPositive(source.entry) : '';
    this.negativeExpanded = !!this.draft.negative.trim();
    this.dirty = !anchor;
    this.deleting = false;
    this.picker = null;
    this.tab = 'anchors';
    this.notice = '';
    this.failed = false;
    if (!this.portraitRequest) { this.portraitNotice = ''; this.portraitError = false; }
    this.render();
    this.container?.querySelector<HTMLInputElement>('[data-anchor-field="name"]')?.focus({ preventScroll: true });
    return true;
  }

  private beginShared(outfit?: SharedOutfit): void {
    if (this.sharedDraft && this.sharedDirty && !window.confirm('这套通用服装还没保存，真要丢掉修改吗？')) return;
    this.sharedDraft = outfit ? { ...outfit } : { id: newAnchorId(), name: '', tags: '' };
    this.sharedDirty = !outfit;
    this.sharedDeleting = false;
    this.tab = 'shared-outfits';
    this.message('');
    this.render();
    this.container?.querySelector<HTMLInputElement>('[data-shared-outfit-field="name"]')?.focus({ preventScroll: true });
  }

  private async commitShared(remove = false): Promise<void> {
    const draft = this.sharedDraft;
    if (!draft || this.busy) return;
    this.busy = true;
    this.render();
    try {
      if (remove) await deleteSharedOutfit(draft.id);
      else await saveSharedOutfit({ ...draft });
      this.refreshSharedOutfits();
      this.sharedDraft = null;
      this.sharedDirty = false;
      this.sharedDeleting = false;
      this.message(remove ? '通用服装已经删掉了。' : getHostStore() ? '通用服装已经存进 TT 扩展数据。' : '通用服装已经存在这台浏览器里。');
    } catch (error) {
      this.message(error instanceof Error ? error.message : '没存上，你改的内容还留在这里没丢。', true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private addOutfit(): void {
    if (!this.draft) return;
    const outfit = { id: newAnchorId(), name: '', tags: '' };
    this.draft.outfits.push(outfit);
    this.markDirty();
    this.render();
    const details = Array.from(this.container!.querySelectorAll<HTMLDetailsElement>('[data-outfit]')).find(item => item.dataset.outfit === outfit.id);
    details?.querySelector<HTMLInputElement>('input')?.focus();
  }

  private async commit(remove = false): Promise<void> {
    const draft = this.draft;
    if (!draft || this.busy || this.portraitRequest) return;
    this.busy = true;
    this.render();
    try {
      const snapshot = structuredClone(draft);
      snapshot.updatedAt = Date.now();
      if (remove) await deleteAnchor(snapshot.id);
      else await saveAnchor(snapshot);
      // Only update the matching editor; navigation may have unmounted it.
      if (this.draft === draft) {
        this.anchors = remove ? this.anchors.filter(item => item.id !== snapshot.id)
          : [...this.anchors.filter(item => item.id !== snapshot.id), { ...snapshot, name: snapshot.name.trim(), appearance: snapshot.appearance.trim(), negative: snapshot.negative.trim() }];
        this.draft = null;
        this.sourcePrompt = '';
        this.picker = null;
        this.dirty = false;
        this.deleting = false;
        this.message(remove ? '这个角色和她的衣服已经删掉了。' : getHostStore() ? '角色和衣服已经存进 TT 扩展数据。' : '角色和衣服已经存在这台浏览器里。');
      }
    } catch (error) {
      this.message(error instanceof Error ? error.message : '没存上，你改的内容还留在这里没丢。', true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private syncPortrait(): void {
    const request = this.portraitRequest;
    const generate = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="generate-portrait"]');
    if (generate) {
      generate.disabled = this.busy || request !== null;
      generate.textContent = !request ? '生成角色图' : request.signal.aborted ? '取消中…' : this.portraitPhase === 'queued' ? '排队中…' : '绘制中…';
    }
    const cancel = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="cancel-portrait"]');
    if (cancel) { cancel.hidden = !request; cancel.disabled = !request || request.signal.aborted; }
    const status = this.container?.querySelector<HTMLElement>('[data-portrait-status]');
    if (status) { status.textContent = this.portraitNotice; status.classList.toggle('is-error', this.portraitError); }
    const save = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="save"]');
    if (save) save.disabled = this.busy || request !== null || !this.dirty;
    const remove = this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="delete"]');
    if (remove) remove.disabled = this.busy || request !== null;
  }

  private cancelPortrait(reason = '不继续等这张角色图了。'): void {
    const request = this.portraitRequest;
    if (!request || request.signal.aborted) return;
    request.abort();
    this.portraitNotice = reason + (this.portraitPhase === 'generating' ? '（对面的生成任务可能还在后台跑着）' : '');
    this.portraitError = false;
    this.syncPortrait();
    const pet = this.portraitPet;
    if (pet) pet.end({ type: 'end', id: pet.id, task: 'image', source: 'portrait', result: 'cancelled', message: this.portraitNotice,
      serverMayContinue: this.portraitPhase === 'generating' });
  }

  private async generatePortrait(): Promise<void> {
    const draft = this.draft;
    if (!draft || this.busy || this.portraitRequest) return;
    const appearance = draft.appearance, negative = draft.negative, outfitId = draft.selectedOutfitId, portrait = draft.portrait;
    const outfitTags = draft.outfits.find(outfit => outfit.id === outfitId)?.tags ?? '';
    const current = () => this.draft === draft && draft.appearance === appearance && draft.negative === negative && draft.selectedOutfitId === outfitId
      && (draft.outfits.find(outfit => outfit.id === outfitId)?.tags ?? '') === outfitTags && draft.portrait === portrait;
    this.deleting = false;
    this.container?.querySelector('.anchor-delete-confirm')?.remove();
    const request = new AbortController();
    this.portraitRequest = request; this.portraitPhase = 'queued';
    const pet = petTaskId();
    const endPet = petEnd();
    const petImage = { type: 'end', id: pet, task: 'image', source: 'portrait' } as const;
    this.portraitPet = { id: pet, end: endPet };
    this.portraitNotice = '正在加入生图队列…'; this.portraitError = false; this.syncPortrait();
    try {
      if (!appearance.trim()) throw withFault(new Error('先把角色的固定外貌 tag 填好再画。'), 'setup');
      const settings = loadImageSettings();
      if (isNaturalLanguageProvider(settings.provider) && negative.trim()) {
        throw withFault(new Error(`${imageProviderName(settings.provider)} 不吃角色独立负面词，把这段负面清空或者换回 NAI 再试。`), 'setup');
      }
      emitPetEvent({ type: 'image', id: pet, source: 'portrait', phase: 'start', provider: settings.provider, summary: draft.name });
      const positive = [settings.positive, appearance, outfitTags].map(part => part.trim()).filter(Boolean).join(', ');
      const combinedNegative = [settings.negative, negative].map(part => part.trim()).filter(Boolean).join(', ');
      const result = await generatePreparedImage(settings, { positive, negative: combinedNegative, characters: [] }, request.signal, progress => {
        if (request.signal.aborted || !current()) return;
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
      if (!result.blob.size || result.blob.size > ANCHOR_PORTRAIT_LIMIT) throw withFault(new Error('画出来的图太大（超 10 MiB）或者是个空图，调小一点尺寸再试吧。'), 'decode');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.blob.type)) throw withFault(new Error('传回来的不是常见的图片格式（得是 PNG、JPEG 或 WebP）。'), 'decode');
      draft.portrait = result.blob;
      this.sourcePrompt = positive;
      this.dirty = true;
      this.deleting = false;
      this.portraitNotice = '角色图画好了，点“保存角色”就能存下来。';
      endPet({ ...petImage, result: 'done', message: this.portraitNotice, picture: {
        blob: result.blob, width: result.parameters.width, height: result.parameters.height,
        target: () => this.container?.querySelector('.anchor-editor-portrait') ?? null,
      } });
      if (this.tab === 'anchors') {
        this.markDirty();
        this.render();
      }
    } catch (error) {
      if (!request.signal.aborted && current()) {
        this.portraitError = true;
        this.portraitNotice = error instanceof Error ? error.message : '角色图没画出来，再试一次。';
        endPet({ ...petImage, result: 'failed', message: this.portraitNotice, fault: petFault(error) });
      }
    } finally {
      endPet({ ...petImage, result: 'dropped', message: '' });
      if (this.portraitRequest === request) { this.portraitRequest = null; this.syncPortrait(); }
    }
  }

  private async click(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled || this.busy) return;
    const tab = button.dataset.anchorTab;
    if (tab === 'round' || tab === 'anchors' || tab === 'shared-outfits') {
      this.tab = tab;
      this.message(tab === 'shared-outfits' && this.sharedDirty ? '通用服装还没保存。' : tab === 'anchors' && this.dirty ? '刚改的角色内容还没保存。' : '');
      this.render();
      if (tab === 'round') void this.refreshRound();
      if (tab === 'shared-outfits') this.refreshSharedOutfits();
      return;
    }
    if (button.dataset.sharedOutfitId) {
      const outfit = this.sharedOutfits.find(item => item.id === button.dataset.sharedOutfitId);
      if (outfit) this.beginShared(outfit);
      return;
    }
    if (button.dataset.anchorImage) {
      const source = this.round.find(item => item.entry.id === button.dataset.anchorImage);
      if (source) this.begin(undefined, source);
      return;
    }
    if (button.dataset.anchorId) {
      const anchor = this.anchors.find(item => item.id === button.dataset.anchorId);
      if (!anchor) return;
      if (!this.begin(anchor)) return;
      if (button.dataset.anchorOutfit === 'new') this.addOutfit();
      else if (button.dataset.anchorOutfit) {
        const details = Array.from(this.container!.querySelectorAll<HTMLDetailsElement>('[data-outfit]')).find(item => item.dataset.outfit === button.dataset.anchorOutfit);
        if (details) { details.open = true; details.querySelector<HTMLInputElement>('input')?.focus(); }
      }
      return;
    }
    switch (button.dataset.anchorAction) {
      case 'refresh': await this.refreshRound(); break;
      case 'reload': await this.refreshAnchors(); break;
      case 'reload-shared': this.refreshSharedOutfits(); break;
      case 'new': this.begin(); break;
      case 'new-shared': this.beginShared(); break;
      case 'back-shared':
        if (this.sharedDirty && !window.confirm('这套通用服装还没保存，真要丢掉修改吗？')) return;
        this.sharedDraft = null; this.sharedDirty = false; this.sharedDeleting = false; this.message(''); this.render(); break;
      case 'save-shared': this.commitShared(); break;
      case 'delete-shared': this.sharedDeleting = true; this.render(); break;
      case 'cancel-delete-shared': this.sharedDeleting = false; this.render(); break;
      case 'confirm-delete-shared': this.commitShared(true); break;
      case 'back':
        if (this.dirty && !window.confirm('刚改的内容还没保存，真要丢掉吗？')) return;
        this.cancelPortrait();
        this.draft = null; this.picker = null; this.dirty = false; this.deleting = false; this.message(''); this.render(); break;
      case 'generate-portrait': await this.generatePortrait(); break;
      case 'cancel-portrait': this.cancelPortrait(); break;
      case 'remove-portrait': if (this.draft) { this.cancelPortrait('角色图已经拿掉了，先取消这次等待。'); this.draft.portrait = null; this.markDirty(); this.render(); } break;
      case 'add-negative':
        if (!this.draft) return;
        this.negativeExpanded = true;
        this.render();
        this.container?.querySelector<HTMLTextAreaElement>('[data-anchor-field="negative"]')?.focus();
        break;
      case 'remove-negative':
        if (!this.draft) return;
        if (this.draft.negative) {
          this.cancelPortrait('负面词已经删了，先取消这次等待。');
          this.draft.negative = '';
          this.markDirty();
        }
        this.negativeExpanded = false;
        this.render();
        this.container?.querySelector<HTMLButtonElement>('[data-anchor-action="add-negative"]')?.focus();
        break;
      case 'add-outfit': this.addOutfit(); break;
      case 'toggle-shared-picker':
        this.sharedPickerOpen = !this.sharedPickerOpen;
        this.refreshSharedOutfits();
        this.render();
        this.container?.querySelector<HTMLElement>(this.sharedPickerOpen ? '[data-shared-outfit-search]' : '[data-anchor-action="toggle-shared-picker"]')?.focus({ preventScroll: true });
        break;
      case 'import-shared-outfits': this.importSharedOutfits(); break;
      case 'remove-outfit': {
        if (!this.draft) return;
        const id = button.closest<HTMLElement>('[data-outfit]')?.dataset.outfit;
        if (this.draft.selectedOutfitId === id) this.cancelPortrait('当前选的衣服已经删了，先取消这次等待。');
        this.draft.outfits = this.draft.outfits.filter(item => item.id !== id);
        if (this.draft.selectedOutfitId === id) this.draft.selectedOutfitId = '';
        this.markDirty(); this.render(); break;
      }
      case 'pick-tags': {
        if (!this.draft) return;
        const tags = selectableTags(this.draft.appearance);
        if (!tags.length) { this.message('先把外貌 tag 填进去，或者从图片带入。', true); return; }
        if (tags.length > 512) { this.message('tag 太长了，直接去上面的输入框里改吧。', true); return; }
        this.picker = tags.map(tag => ({ tag, keep: true })); this.render(); break;
      }
      case 'select-none': this.picker?.forEach(item => { item.keep = false; }); this.render(); break;
      case 'apply-tags':
        if (!this.draft || !this.picker) return;
        if (!this.picker.some(item => item.keep)) { this.message('至少得留一个外貌 tag。', true); return; }
        this.cancelPortrait('刚改了外貌 tag，这次生成已经停下了。');
        this.draft.appearance = this.picker.filter(item => item.keep).map(item => item.tag).join(', ');
        this.picker = null; this.markDirty(); this.render(); break;
      case 'close-picker': this.picker = null; this.render(); break;
      case 'save': await this.commit(); break;
      case 'delete': this.deleting = true; this.render(); break;
      case 'cancel-delete': this.deleting = false; this.render(); break;
      case 'confirm-delete': await this.commit(true); break;
    }
  }
}
