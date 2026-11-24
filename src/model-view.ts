import { imageProviderName } from './image-settings.js';
import type { ModelSettings, PromptEntry } from './model-settings.js';
import { listFeatureLayers } from './feature-layers.js';
import type { WorldbookSourceEntry } from './worldbook-source.js';
import { getHostStore } from './host-storage.js';
import { imageSizeEntryMode } from './image-size-mode.js';

export const PRESET_PAGE_SIZE = 100;

export interface ModelViewState {
  saved: boolean;
  saving?: boolean;
  refreshing: boolean;
  importNotice?: string;
  importError?: boolean;
  selectedKey?: string;
  presetPage?: number;
  layerPreview?: { key: string; text: string; loading: boolean; error?: string };
  worldbook?: {
    names: string[];
    book: string;
    entries: WorldbookSourceEntry[];
    loading: boolean;
    error: string;
    previewId?: string;
    busy?: boolean;
    pickerOpen?: boolean;
    editor?: { id: string; content: string; status: string; error: boolean };
  };
  filterStatus?: { enabled: boolean; active: boolean; error: string };
}

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function options(items: { value: string; label: string }[], selected: string): string {
  return items.map(item => `<option value="${escape(item.value)}"${item.value === selected ? ' selected' : ''}>${escape(item.label)}</option>`).join('');
}

function promptEditor(entry: PromptEntry): string {
  return `<div class="preset-editor-fields" data-entry-id="${escape(entry.id)}">
    <div class="preset-entry-fields">
      <label class="config-field"><span>条目名称</span><input type="text" data-prompt-field="name" value="${escape(entry.name)}" maxlength="256"></label>
      <label class="config-field"><span>消息角色</span><select data-prompt-field="role">${options([
        { value: 'system', label: '系统 · system' },
        { value: 'user', label: '用户 · user' },
        { value: 'assistant', label: '助手 · assistant' },
      ], entry.role)}</select></label>
    </div>
    <label class="config-field preset-content"><span>提示词内容</span><textarea data-prompt-field="content" rows="15" maxlength="65536" spellcheck="false">${escape(entry.content)}</textarea></label>
    ${entry.marker ? '<p class="config-status">这是酒馆的占位标记，留在这里给你对位子看，请求时不会发出去。</p>' : ''}
  </div>`;
}

function keywordSummary(keys: string[]): string {
  const present = keys.map(key => key.trim()).filter(Boolean);
  if (!present.length) return '未设置';
  const summary = present.slice(0, 3).map(key => key.length > 48 ? `${key.slice(0, 48)}…` : key).join('、');
  return present.length > 3 ? `${summary}等 ${present.length} 项` : summary;
}

function worldbookActivationView(entry: WorldbookSourceEntry): string {
  const activation = entry.activation;
  if (!activation) return '<small class="worldbook-activation" data-mode="unknown">缺了触发规则 · 把原世界书重导一次就好</small>';
  const secondaryLogic = ['至少命中一项', '至少一项不匹配', '全部不匹配', '全部匹配'][activation.selectiveLogic];
  const hasKeys = activation.keys.some(key => key.trim());
  const secondary = activation.secondaryKeys.length
    ? `${keywordSummary(activation.secondaryKeys)} · ${activation.selective ? secondaryLogic : '未启用次关键词条件'}`
    : '未设置';
  return `<small class="worldbook-activation" data-mode="${activation.constant ? 'constant' : 'keyword'}">${activation.constant ? '蓝灯 · 常驻' : '绿灯 · 匹配本次正文'}</small>
    <small class="worldbook-keywords">主关键词：${escape(keywordSummary(activation.keys))}${!activation.constant && !hasKeys ? '，不会触发' : ''}</small>
    <small class="worldbook-keywords">次关键词：${escape(secondary)}</small>`;
}

export function worldbookSettingsView(settings: ModelSettings, state: ModelViewState['worldbook'], manage = false): string {
  const book = state?.book ?? '';
  const selected = settings.worldbooks.find(item => item.name === book)?.entries ?? [];
  const entries = state?.entries ?? [];
  const names = [...new Set(state?.names ?? [])];
  const attached = settings.worldbooks.filter(item => item.entries.length);
  const attachedNames = new Set(attached.map(item => item.name));
  const stale = !state?.loading && !state?.error ? selected.filter(id => !entries.some(entry => entry.id === id)) : [];
  const count = settings.worldbooks.reduce((total, item) => total + item.entries.length, 0);
  const unavailable = state?.loading || state?.busy;
  const preview = entries.find(entry => entry.id === state?.previewId);
  const editor = state?.editor?.id === preview?.id ? state?.editor : undefined;
  return `<div class="worldbook-settings" data-worldbook-settings>
    <div class="worldbook-picker">
      <div class="worldbook-picker-heading"><button type="button" class="worldbook-picker-toggle" data-model-action="toggle-worldbook-picker" aria-expanded="${Boolean(state?.pickerOpen)}"><span>世界书挂载</span><small>${state?.pickerOpen ? '收起列表' : '展开选择'}</small><span aria-hidden="true">${state?.pickerOpen ? '⌃' : '⌄'}</span></button>
        <button type="button" class="text-button" data-model-action="refresh-worldbooks"${unavailable ? ' disabled' : ''}>${state?.loading ? '读取中…' : '刷新'}</button></div>
      <div class="worldbook-attached" aria-label="已挂载的世界书">
        ${attached.map(item => `<span class="worldbook-chip"><button type="button" data-model-action="choose-worldbook" data-book-name="${escape(item.name)}" aria-pressed="${item.name === book}" title="查看${escape(item.name)}的条目"${state?.busy ? ' disabled' : ''}>${escape(item.name)}</button><button type="button" class="worldbook-detach" data-model-action="detach-worldbook" data-book-name="${escape(item.name)}" aria-label="取消挂载${escape(item.name)}" title="仅取消挂载，不删除世界书"${state?.busy ? ' disabled' : ''}>×</button></span>`).join('')}
        ${attached.length ? '' : '<p class="config-status">还没挂世界书呢，点开上面列表就能挑，一次多挂几本也行。</p>'}
      </div>
      <div class="worldbook-picker-body"${state?.pickerOpen ? '' : ' hidden'}>
        <p class="config-status">点一下书名就会把里面能用的条目全挂上；已经挂上的书，点一下就能在下面单条微调。</p>
        <div class="worldbook-picker-list" aria-label="已上传的世界书">${names.map(name => {
          const isAttached = attachedNames.has(name);
          return `<button type="button" data-model-action="${isAttached ? 'choose-worldbook' : 'attach-worldbook'}" data-book-name="${escape(name)}" aria-pressed="${name === book}"${state?.busy || (!isAttached && state?.loading) ? ' disabled' : ''}><span>${escape(name)}</span><small>${isAttached ? '已挂载' : '点击挂载'}</small></button>`;
        }).join('')}${names.length ? '' : `<p class="config-status">${state?.loading ? '正翻着书单呢…' : '还没传过世界书进来。'}</p>`}</div>
      </div>
    </div>
    <p class="config-status">一共挂着 ${count} 条（来自 ${attached.length} 本书）。蓝灯每次必带，绿灯只有这一楼正文扫到关键词才亮。</p>
    ${manage ? '' : '<button type="button" class="text-button model-feature-link" data-page="features" data-feature-tab="worldbook">上传与管理世界书 →</button>'}
    ${state?.error ? `<p class="config-status is-error" role="status">${escape(state.error)}</p>` : ''}
    ${book ? `<div class="worldbook-toolbar"><span>${escape(book)}</span><button type="button" class="text-button" data-model-action="select-worldbook"${unavailable || !entries.some(entry => entry.enabled && entry.activation && entry.content.trim()) ? ' disabled' : ''}>全选可用</button><button type="button" class="text-button" data-model-action="clear-worldbook"${unavailable || !selected.length ? ' disabled' : ''}>清空挂载</button>${manage ? `<button type="button" class="text-button worldbook-danger" data-model-action="delete-worldbook"${unavailable || !state?.names.includes(book) ? ' disabled' : ''}>删除世界书</button>` : ''}</div>
    <div class="worldbook-entry-list" aria-label="世界书条目">
      ${entries.map(entry => {
        const checked = selected.includes(entry.id);
        const status = !entry.enabled ? '关着，不会发给模型' : !entry.content.trim() ? '里头是空的，不会发' : '';
        return `<div class="worldbook-entry-row"><label class="worldbook-entry"><input type="checkbox" data-worldbook-entry="${escape(entry.id)}" data-worldbook-name="${escape(book)}"${checked ? ' checked' : ''}${unavailable || ((!entry.enabled || !entry.activation || !entry.content.trim()) && !checked) ? ' disabled' : ''}><span>${escape(entry.name || '未命名条目')}${worldbookActivationView(entry)}<small data-worldbook-entry-status${status ? '' : ' hidden'}>${status}</small></span></label>${manage ? `<button type="button" class="text-button" data-model-action="preview-worldbook-entry" data-entry-id="${escape(entry.id)}" aria-label="查看${escape(entry.name)}内容" aria-pressed="${preview?.id === entry.id}"${unavailable ? ' disabled' : ''}>查看</button>` : ''}</div>`;
      }).join('')}
      ${stale.map(id => `<label class="worldbook-entry is-unavailable"><input type="checkbox" data-worldbook-entry="${escape(id)}" data-worldbook-name="${escape(book)}" checked${state?.busy ? ' disabled' : ''}><span>条目 ${escape(id)}<small>已失效，可取消挂载</small></span></label>`).join('')}
      ${entries.length || stale.length ? '' : `<p class="config-status">${state?.loading ? '正在读条目…' : state?.error ? '读出来以后会列在这里。' : '这本书里头空空如也，没有能挂的条目。'}</p>`}
    </div>` : ''}
    ${manage && preview ? `<div class="worldbook-preview"><h3 class="subsection-title">${escape(preview.name)}</h3><textarea class="preset-layer-preview" rows="9" data-worldbook-content="${escape(preview.id)}" data-worldbook-name="${escape(book)}" aria-label="世界书条目内容" aria-describedby="worldbook-content-status" spellcheck="false"${state?.busy ? ' disabled' : ''}>${escape(editor?.content ?? preview.content)}</textarea><p id="worldbook-content-status" class="config-status${editor?.error ? ' is-error' : ''}" data-worldbook-content-status role="status">${escape(editor?.status ?? '点进框里就能改，鼠标点到别处就自动存上。')}</p></div>` : ''}
    <p class="config-status">挑完书和条目会自动存好。</p>
  </div>`;
}

export function presetIndexView(settings: ModelSettings, state: ModelViewState): string {
  const entries = new Map([...settings.head, ...settings.tail].map(entry => [`prompt:${entry.id}`, entry]));
  const layers = new Map(listFeatureLayers().map(layer => [`layer:${layer.id}`, layer.title]));
  const selected = settings.promptOrder.includes(state.selectedKey ?? '') ? state.selectedKey! : settings.promptOrder[0];
  const pages = Math.max(1, Math.ceil(settings.promptOrder.length / PRESET_PAGE_SIZE));
  const page = Math.min(Math.max(0, state.presetPage ?? 0), pages - 1);
  const start = page * PRESET_PAGE_SIZE;
  return `<div class="preset-index">
    <div class="preset-index-heading"><h3>条目顺序</h3><button type="button" class="text-button" data-model-action="add-entry">＋ 新增条目</button></div>
    <ol class="preset-entry-list" data-preset-list aria-label="预设发送顺序" start="${start + 1}">${settings.promptOrder.slice(start, start + PRESET_PAGE_SIZE).map((key, offset) => {
      const index = start + offset;
      const entry = entries.get(key);
      const sizeProtocol = entry && imageSizeEntryMode(entry);
      const enabled = entry ? entry.enabled : key === 'input' || settings.enabledLayers.includes(key.slice(6));
      const title = entry ? entry.name || '未命名条目' : key === 'input' ? '最新正文' : layers.get(key) ?? '这个功能层眼下用不了';
      return `<li class="preset-row${selected === key ? ' is-selected' : ''}" data-preset-key="${escape(key)}">
        <button type="button" class="preset-select" data-model-action="select-preset" data-preset-key="${escape(key)}" aria-pressed="${selected === key}" title="${escape(title)}"><span class="preset-number">${String(index + 1).padStart(2, '0')}</span><span class="preset-entry-name"><span data-preset-title="${escape(key)}">${escape(title)}</span>${entry ? '' : `<small>${key === 'input' ? '自动读取' : '功能层'}</small>`}</span></button>
        <div class="preset-row-actions">
          <label title="${enabled ? '关掉' : '打开'}${escape(title)}${sizeProtocol ? '（切了会立刻同步画幅模式并保存）' : ''}"><input type="checkbox" data-preset-enabled="${escape(key)}" aria-label="启用${escape(title)}"${enabled ? ' checked' : ''}${entry?.marker || key === 'input' || (sizeProtocol && state.saving) ? ' disabled' : ''}></label>
          <button type="button" data-model-action="move-up" data-preset-key="${escape(key)}" aria-label="上移${escape(title)}"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-model-action="move-down" data-preset-key="${escape(key)}" aria-label="下移${escape(title)}"${index === settings.promptOrder.length - 1 ? ' disabled' : ''}>↓</button>
          ${entry ? `<button type="button" data-model-action="remove-entry" data-preset-key="${escape(key)}" aria-label="删除${escape(title)}">×</button>` : '<span class="preset-action-spacer" aria-hidden="true"></span>'}
        </div>
      </li>`;
    }).join('')}</ol>
    ${pages > 1 ? `<div class="preset-index-heading" aria-label="预设列表分页"><button type="button" class="text-button" data-model-action="preset-page-previous"${page === 0 ? ' disabled' : ''}>上一页</button><span class="config-status">${page + 1} / ${pages} 页 · 共 ${settings.promptOrder.length} 条</span><button type="button" class="text-button" data-model-action="preset-page-next"${page === pages - 1 ? ' disabled' : ''}>下一页</button></div>` : ''}
  </div>`;
}

export function presetWorkspaceView(settings: ModelSettings, state: ModelViewState): string {
  const entries = new Map([...settings.head, ...settings.tail].map(entry => [`prompt:${entry.id}`, entry]));
  const layers = new Map(listFeatureLayers().map(layer => [`layer:${layer.id}`, layer.title]));
  const selected = settings.promptOrder.includes(state.selectedKey ?? '') ? state.selectedKey! : settings.promptOrder[0];
  const titleFor = (key: string): string => entries.has(key) ? entries.get(key)!.name || '未命名条目' : key === 'input' ? '最新正文' : layers.get(key) ?? '这个功能层眼下用不了';
  const current = entries.get(selected);
  const preview = state.layerPreview?.key === selected ? state.layerPreview : undefined;
  let detail = current ? promptEditor(current) : selected === 'input'
    ? '<p class="preset-description">每次处理时自动把最新一楼 AI 正文抓进来，顺便标好能插图的空位。这里不用自己手填。</p>'
    : `${selected === 'layer:worldbook' ? worldbookSettingsView(settings, state.worldbook) : ''}
      ${selected === 'layer:anchors' ? '<p class="preset-description">会把每个角色的正式名、别名、固定外貌（base）、默认衣服（default）和整个衣柜按 INI 分段报给模型，通用服装单列在最底下。没选默认装的话 default 就留空。</p><p class="config-status">让模型写场景词时直接用 @角色、@角色:服装 或 #通用服装名 就行，展开和避让规则插件会自己接管；下面这段提示只是给你看的，不会发给模型。</p><button type="button" class="text-button model-feature-link" data-page="features" data-feature-tab="anchors">去配置标签锚定 →</button>' : ''}
      <div class="preset-preview-heading"><h4>发送内容预览</h4><button type="button" class="text-button" data-model-action="refresh-layer"${preview?.loading ? ' disabled' : ''}>${preview?.loading ? '读取中…' : '刷新预览'}</button></div>
      <textarea class="preset-layer-preview" data-layer-preview="${escape(selected ?? '')}" aria-label="功能层发送内容预览" rows="10" readonly spellcheck="false" placeholder="${preview?.loading ? '正在读取…' : '这会儿还是空的，点一下刷新预览看看。'}">${escape(preview?.text ?? '')}</textarea>
      ${preview?.error ? `<p class="config-status is-error" role="status">${escape(preview.error)}</p>` : '<p class="config-status">真发请求前还会重新拉一次最新内容，不用担心预览滞后。</p>'}`;
  if (!selected) detail = '<p class="config-status">点一下左边的条目，就能在这里看里面写着什么。</p>';
  return `${presetIndexView(settings, state)}
    <div class="preset-detail"><header class="preset-detail-heading"><h3>${current ? '编辑条目' : escape(titleFor(selected))}</h3>${current ? '' : '<span>自动读取</span>'}</header>${detail}</div>`;
}

export function modelChoicesView(settings: ModelSettings, query = ''): string {
  const search = query.trim().toLowerCase();
  const models = settings.models.filter(model => !search || model.toLowerCase().includes(search));
  return `<p class="config-status" role="status">${search ? `筛出来 ${models.length} / ${settings.models.length} 个模型` : `一共 ${models.length} 个模型`}${models.length ? '，点名字直接用。' : '，换个关键词搜，或者干脆自己手填吧。'}</p>
    <div class="model-picker-list" aria-label="模型列表">${models.map(model => `<button type="button" class="text-button" data-model-action="choose-model" data-model-name="${escape(model)}" aria-pressed="${model === settings.model}">${escape(model)}</button>`).join('')}</div>`;
}

export function modelPickerView(settings: ModelSettings): string {
  return settings.models.length ? `<details class="prompt-section model-picker" data-model-picker>
    <summary>浏览全部模型 · ${settings.models.length}</summary>
    <label class="config-field"><span>搜索模型</span><input type="search" data-model-search placeholder="输入关键词筛选模型" autocomplete="off" spellcheck="false"></label>
    <div data-model-choices>${modelChoicesView(settings)}</div>
  </details>` : '';
}

export function modelSettingsView(settings: ModelSettings, state: ModelViewState): string {
  const providerName = imageProviderName(settings.presetProvider);
  return `<div class="image-settings model-settings">
    <section class="config-section" aria-labelledby="model-connection-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">01</span>
        <h2 class="section-title" id="model-connection-heading">模型连接</h2><p class="section-description">让这个模型看懂正文、写好场景词并插进楼里，再交由生图 API 出图。接口和回复参数是四套生图通道共用的。</p></header>
      <label class="config-field channel-field"><span>连接方式</span>
        <select data-model-field="mode">${options([
          { value: 'tavern', label: '跟随酒馆主 API' },
          { value: 'custom', label: '自定义接口' },
        ], settings.mode)}</select>
      </label>
      <p class="config-status" data-model-tavern${settings.mode === 'tavern' ? '' : ' hidden'}>直接蹭酒馆现在连着的聊天补全接口；如果你用的是 Text Completion（文字补全），请切去“自定义接口”。</p>
      <div class="model-custom-fields" data-model-custom${settings.mode === 'custom' ? '' : ' hidden'}>
        <label class="config-field"><span>服务 URL</span>
          <input type="url" data-model-field="url" value="${escape(settings.url)}" maxlength="8192" placeholder="请输入 URL" autocomplete="off" spellcheck="false">
        </label>
        <div class="model-key-line">
          <label class="config-field"><span>API Key</span>
            <input type="password" data-model-field="key" value="${escape(settings.key)}" maxlength="16384" autocomplete="off" spellcheck="false" autocapitalize="off">
          </label>
          <button type="button" class="text-button" data-model-action="toggle-key" aria-pressed="false">显示</button>
        </div>
        <div class="model-choice-line">
          <label class="config-field"><span>模型</span>
            <input type="text" data-model-field="model" value="${escape(settings.model)}" maxlength="512" placeholder="填写模型名称，或从下方列表选择" autocomplete="off" spellcheck="false">
          </label>
          <button type="button" class="text-button" data-model-action="refresh-models"${state.refreshing ? ' disabled' : ''}>${state.refreshing ? '刷新中…' : '刷新列表'}</button>
        </div>
        <div data-model-picker-host${settings.models.length ? '' : ' hidden'}>${modelPickerView(settings)}</div>
      </div>
      <div class="parameter-group"><h3 class="subsection-title">回复参数</h3><div class="parameter-grid model-parameters">
        <label class="config-field"><span>最大回复长度 · max tokens</span>
          <input type="number" data-model-field="maxTokens" value="${escape(settings.maxTokens)}" min="1" max="65536" step="1" required>
        </label>
        <label class="config-field"><span>温度</span>
          <input type="number" data-model-field="temperature" value="${escape(settings.temperature)}" min="0" max="2" step="0.1" required>
        </label>
        <label class="config-field"><span>请求方式</span>
          <select data-model-field="transport">${options([
            { value: 'nonstream', label: '非流式' },
            { value: 'stream', label: '流式' },
            { value: 'compatible', label: '假流兼容' },
            { value: 'toolcall', label: 'ToolCall 结构化' },
          ], settings.transport)}</select>
        </label>
      </div></div>
    </section>

    <section class="config-section" aria-labelledby="model-prompts-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">02</span>
        <h2 class="section-title" id="model-prompts-heading">${providerName} 预设编排</h2><p class="section-description">现在调的是 ${providerName} 用的预设，切去别的生图服务时也会跟着换、各自单独保存。左边排顺序，右边改正文或挂功能层。</p></header>
      <div class="artist-fields">
        <label class="config-field"><span>导入 JSON 预设</span><input type="file" data-preset-file accept=".json,application/json"></label>
        <p class="config-status${state.importError ? ' is-error' : ''}" data-preset-status role="status">${escape(state.importNotice ?? `导进来就会换掉现在这套 ${providerName} 预设，并且自动存好。`)}</p>
        <div class="model-save-line preset-save-line" data-saved="${state.saved}">
          <label class="config-field"><span>${providerName} 预设名称</span><textarea data-model-field="presetName" rows="1" maxlength="256">${escape(settings.presetName)}</textarea></label>
          <p class="config-status" data-model-status role="status">${state.saving ? '正在存进去…' : state.saved ? getHostStore() ? '已经自动存进 TT 扩展数据了。' : '已经自动存在这台浏览器里了。' : ''}</p>
        </div>
      </div>
      <div class="preset-workspace" data-preset-workspace>${presetWorkspaceView(settings, state)}</div>
      <details class="prompt-section format-reference">
        <summary><span>预设变量 · setvar / getvar</span></summary>
        <p class="config-status">可以在格式条目里写 {{getvar::生图数量要求}}，另开一条写 {{setvar::生图数量要求::3}} 来定死数量，写成多行规则也行。</p>
        <p class="config-status">画匣会先扫一遍这次开启的所有条目把变量值收齐，再去替换各处引用，所以把定义条目放后面也照样读得到。撞名字以后面那条为准；定义条目自身发请求时会剥掉，也不碰酒馆原生变量。这里只做一遍文本展开，不会套娃递归。</p>
      </details>
      <div class="parameter-group marker-settings"><h3 class="subsection-title">标记解析</h3>
        <label class="prompt-enable"><input type="checkbox" data-model-field="parseImageMarkers"${settings.parseImageMarkers ? ' checked' : ''}>解析配图标记</label>
        <p class="config-status">只要正文里有完整闭合的配图标记，楼层里就会冒出“生成图片”的按钮。</p>
        <label class="prompt-enable"><input type="checkbox" data-model-field="hideImageContext"${settings.hideImageContext ? ' checked' : ''}>从 AI 上下文隐藏配图标记</label>
        <p class="config-status">发消息给主 AI 时把完整的 &lt;img&gt;…&lt;/img&gt; 块遮掉，你自己在楼层里看到的图文和按钮都还好好留着。</p>
        <p class="config-status${state.filterStatus?.error ? ' is-error' : ''}" data-context-filter-status role="status">${escape(state.filterStatus?.error || (state.filterStatus?.active ? '上下文遮蔽已经在干活了。' : ''))}</p>
        <details class="prompt-section format-reference">
          <summary><span>查看配图标记与 AI 返回格式</span></summary>
          <code class="marker-format">&lt;img&gt;\n[图片内容概括]\n该场景的生图提示词\n&lt;/img&gt;</code>
          <p class="config-status">点悬浮球里的“AI生图”时，画匣会把正文标上【插入点 P001】这种空位传过去；你写的预设只要让模型按下面格式吐回 JSON 数组，画匣就会照编号把图嵌回去，原文一字不改。</p>
          <code class="marker-format">[{"at":"P001","summary":"图片内容概括","prompt":"该场景的生图提示词"}]</code>
          <p class="config-status">at 写这次给的编号，summary 写一句话概括，prompt 只写这一幕的生图提示词；开着 AI 动态画幅时还能加一个 size 字段（比如 "size":"832x1216"），没给或者写错尺寸就按设置里的兜底画幅走。这一段说明只是给你看的，不会发给模型。</p>
        </details>
      </div>
    </section>

  </div>`;
}
