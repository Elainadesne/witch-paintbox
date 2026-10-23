import { listFeatureLayers } from './feature-layers.js';
function escape(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}
function options(items, selected) {
    return items.map(item => `<option value="${escape(item.value)}"${item.value === selected ? ' selected' : ''}>${escape(item.label)}</option>`).join('');
}
function promptEditor(entry) {
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
    ${entry.marker ? '<p class="config-status">酒馆占位标记，保留供查看，不会发送。</p>' : ''}
  </div>`;
}
function keywordSummary(keys) {
    const present = keys.map(key => key.trim()).filter(Boolean);
    if (!present.length)
        return '未设置';
    const summary = present.slice(0, 3).map(key => key.length > 48 ? `${key.slice(0, 48)}…` : key).join('、');
    return present.length > 3 ? `${summary}等 ${present.length} 项` : summary;
}
function worldbookActivationView(entry) {
    const activation = entry.activation;
    if (!activation)
        return '<small class="worldbook-activation" data-mode="unknown">缺少规则 · 请重新导入原世界书</small>';
    const secondaryLogic = ['至少命中一项', '至少一项不匹配', '全部不匹配', '全部匹配'][activation.selectiveLogic];
    const hasKeys = activation.keys.some(key => key.trim());
    const secondary = activation.secondaryKeys.length
        ? `${keywordSummary(activation.secondaryKeys)} · ${activation.selective ? secondaryLogic : '未启用次关键词条件'}`
        : '未设置';
    return `<small class="worldbook-activation" data-mode="${activation.constant ? 'constant' : 'keyword'}">${activation.constant ? '蓝灯 · 常驻' : '绿灯 · 匹配本次正文'}</small>
    <small class="worldbook-keywords">主关键词：${escape(keywordSummary(activation.keys))}${!activation.constant && !hasKeys ? '，不会触发' : ''}</small>
    <small class="worldbook-keywords">次关键词：${escape(secondary)}</small>`;
}
export function worldbookSettingsView(settings, state, manage = false) {
    const book = state?.book ?? '';
    const selected = settings.worldbooks.find(item => item.name === book)?.entries ?? [];
    const entries = state?.entries ?? [];
    const names = [...new Set([...(state?.names ?? []), ...settings.worldbooks.map(item => item.name), ...(book ? [book] : [])])];
    const stale = !state?.loading && !state?.error ? selected.filter(id => !entries.some(entry => entry.id === id)) : [];
    const count = settings.worldbooks.reduce((total, item) => total + item.entries.length, 0);
    const unavailable = state?.loading || state?.busy;
    const preview = entries.find(entry => entry.id === state?.previewId);
    return `<div class="worldbook-settings" data-worldbook-settings>
    <div class="worldbook-choice-line">
      <label class="config-field"><span>已上传的世界书</span><select data-worldbook-name${unavailable ? ' disabled' : ''}>${options([
        { value: '', label: names.length ? '选择世界书' : '请先上传世界书' }, ...names.map(name => ({ value: name, label: name })),
    ], book)}</select></label>
      <button type="button" class="text-button" data-model-action="refresh-worldbooks"${unavailable ? ' disabled' : ''}>${state?.loading ? '读取中…' : '刷新'}</button>
    </div>
    <p class="config-status">勾选后按原世界书规则发送：蓝灯常驻，绿灯仅在本次正文命中关键词时激活。已挂载 ${count} 条，来自 ${settings.worldbooks.filter(item => item.entries.length).length} 本世界书。</p>
    ${manage ? '' : '<button type="button" class="text-button model-feature-link" data-page="features" data-feature-tab="worldbook">上传与管理世界书 →</button>'}
    ${state?.error ? `<p class="config-status is-error" role="status">${escape(state.error)}</p>` : ''}
    ${book ? `<div class="worldbook-toolbar"><span>${escape(book)}</span><button type="button" class="text-button" data-model-action="select-worldbook"${unavailable || !entries.some(entry => entry.enabled && entry.activation && entry.content.trim()) ? ' disabled' : ''}>全选可用</button><button type="button" class="text-button" data-model-action="clear-worldbook"${unavailable || !selected.length ? ' disabled' : ''}>清空挂载</button>${manage ? `<button type="button" class="text-button worldbook-danger" data-model-action="delete-worldbook"${unavailable || !state?.names.includes(book) ? ' disabled' : ''}>删除世界书</button>` : ''}</div>
    <div class="worldbook-entry-list" aria-label="世界书条目">
      ${entries.map(entry => {
        const checked = selected.includes(entry.id);
        const status = !entry.enabled ? '已禁用，不会发送' : !entry.content.trim() ? '内容为空，不会发送' : '';
        return `<div class="worldbook-entry-row"><label class="worldbook-entry"><input type="checkbox" data-worldbook-entry="${escape(entry.id)}" data-worldbook-name="${escape(book)}"${checked ? ' checked' : ''}${unavailable || ((!entry.enabled || !entry.activation || !entry.content.trim()) && !checked) ? ' disabled' : ''}><span>${escape(entry.name || '未命名条目')}${worldbookActivationView(entry)}${status ? `<small>${status}</small>` : ''}</span></label>${manage ? `<button type="button" class="text-button" data-model-action="preview-worldbook-entry" data-entry-id="${escape(entry.id)}" aria-label="查看${escape(entry.name)}内容" aria-pressed="${preview?.id === entry.id}"${unavailable ? ' disabled' : ''}>查看</button>` : ''}</div>`;
    }).join('')}
      ${stale.map(id => `<label class="worldbook-entry is-unavailable"><input type="checkbox" data-worldbook-entry="${escape(id)}" data-worldbook-name="${escape(book)}" checked${state?.busy ? ' disabled' : ''}><span>条目 ${escape(id)}<small>已失效，可取消挂载</small></span></label>`).join('')}
      ${entries.length || stale.length ? '' : `<p class="config-status">${state?.loading ? '正在读取条目…' : state?.error ? '读取成功后显示条目。' : '这本世界书暂无可用条目。'}</p>`}
    </div>` : ''}
    ${manage && preview ? `<div class="worldbook-preview"><h3 class="subsection-title">${escape(preview.name)}</h3><textarea class="preset-layer-preview" rows="9" readonly aria-label="世界书条目原文" spellcheck="false">${escape(preview.content)}</textarea></div>` : ''}
  </div>`;
}
export function presetWorkspaceView(settings, state) {
    const entries = new Map([...settings.head, ...settings.tail].map(entry => [`prompt:${entry.id}`, entry]));
    const layers = new Map(listFeatureLayers().map(layer => [`layer:${layer.id}`, layer.title]));
    const selected = settings.promptOrder.includes(state.selectedKey ?? '') ? state.selectedKey : settings.promptOrder[0];
    const titleFor = (key) => entries.has(key) ? entries.get(key).name || '未命名条目' : key === 'input' ? '最新正文' : layers.get(key) ?? '功能层暂不可用';
    const current = entries.get(selected);
    const preview = state.layerPreview?.key === selected ? state.layerPreview : undefined;
    let detail = current ? promptEditor(current) : selected === 'input'
        ? '<p class="preset-description">自动读取当前聊天的最新 AI 正文，并标注可插入配图的行间位置。正文在请求时更新，无需在这里填写。</p>'
        : `${selected === 'layer:worldbook' ? worldbookSettingsView(settings, state.worldbook) : ''}
      ${selected === 'layer:anchors' ? '<p class="preset-description">从标签锚定读取角色外貌与服装，按“人物名称{组成 tag}”展示发送内容。</p><button type="button" class="text-button model-feature-link" data-page="features" data-feature-tab="anchors">前往标签锚定配置 →</button>' : ''}
      <div class="preset-preview-heading"><h4>发送内容预览</h4><button type="button" class="text-button" data-model-action="refresh-layer"${preview?.loading ? ' disabled' : ''}>${preview?.loading ? '读取中…' : '刷新预览'}</button></div>
      <textarea class="preset-layer-preview" data-layer-preview="${escape(selected ?? '')}" aria-label="功能层发送内容预览" rows="10" readonly spellcheck="false" placeholder="${preview?.loading ? '正在读取…' : '暂无内容，可刷新预览。'}">${escape(preview?.text ?? '')}</textarea>
      ${preview?.error ? `<p class="config-status is-error" role="status">${escape(preview.error)}</p>` : '<p class="config-status">请求前会重新读取所选内容。</p>'}`;
    if (!selected)
        detail = '<p class="config-status">选择左侧条目查看内容。</p>';
    return `<div class="preset-index">
    <div class="preset-index-heading"><h3>条目顺序</h3><button type="button" class="text-button" data-model-action="add-entry">＋ 新增条目</button></div>
    <ol class="preset-entry-list" data-preset-list aria-label="预设发送顺序">${settings.promptOrder.map((key, index) => {
        const entry = entries.get(key);
        const enabled = entry ? entry.enabled : key === 'input' || settings.enabledLayers.includes(key.slice(6));
        const title = titleFor(key);
        return `<li class="preset-row${selected === key ? ' is-selected' : ''}" data-preset-key="${escape(key)}">
        <button type="button" class="preset-select" data-model-action="select-preset" data-preset-key="${escape(key)}" aria-pressed="${selected === key}" title="${escape(title)}"><span class="preset-number">${String(index + 1).padStart(2, '0')}</span><span class="preset-entry-name"><span data-preset-title="${escape(key)}">${escape(title)}</span>${entry ? '' : `<small>${key === 'input' ? '自动读取' : '功能层'}</small>`}</span></button>
        <div class="preset-row-actions">
          <label title="${enabled ? '关闭' : '启用'}${escape(title)}"><input type="checkbox" data-preset-enabled="${escape(key)}" aria-label="启用${escape(title)}"${enabled ? ' checked' : ''}${entry?.marker || key === 'input' ? ' disabled' : ''}></label>
          <button type="button" data-model-action="move-up" data-preset-key="${escape(key)}" aria-label="上移${escape(title)}"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-model-action="move-down" data-preset-key="${escape(key)}" aria-label="下移${escape(title)}"${index === settings.promptOrder.length - 1 ? ' disabled' : ''}>↓</button>
          ${entry ? `<button type="button" data-model-action="remove-entry" data-preset-key="${escape(key)}" aria-label="删除${escape(title)}">×</button>` : '<span class="preset-action-spacer" aria-hidden="true"></span>'}
        </div>
      </li>`;
    }).join('')}</ol>
  </div>
  <div class="preset-detail"><header class="preset-detail-heading"><h3>${current ? '编辑条目' : escape(titleFor(selected))}</h3>${current ? '' : '<span>自动读取</span>'}</header>${detail}</div>`;
}
export function modelSettingsView(settings, state) {
    return `<div class="image-settings model-settings">
    <section class="config-section" aria-labelledby="model-connection-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">01</span>
        <h2 class="section-title" id="model-connection-heading">模型连接</h2><p class="section-description">选择负责理解正文、编写场景提示词的 AI。</p></header>
      <label class="config-field channel-field"><span>连接方式</span>
        <select data-model-field="mode">${options([
        { value: 'tavern', label: '跟随酒馆主 API' },
        { value: 'custom', label: '自定义接口' },
    ], settings.mode)}</select>
      </label>
      <p class="config-status" data-model-tavern${settings.mode === 'tavern' ? '' : ' hidden'}>使用酒馆当前的聊天补全连接；文字补全接口请改用自定义连接。</p>
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
            <input type="text" data-model-field="model" value="${escape(settings.model)}" list="witch-model-options" maxlength="512" placeholder="选择或填写模型名称" autocomplete="off" spellcheck="false">
            <datalist id="witch-model-options">${settings.models.map(model => `<option value="${escape(model)}"></option>`).join('')}</datalist>
          </label>
          <button type="button" class="text-button" data-model-action="refresh-models"${state.refreshing ? ' disabled' : ''}>${state.refreshing ? '刷新中…' : '刷新列表'}</button>
        </div>
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
    ], settings.transport)}</select>
        </label>
      </div></div>
    </section>

    <section class="config-section" aria-labelledby="model-prompts-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">02</span>
        <h2 class="section-title" id="model-prompts-heading">预设编排</h2><p class="section-description">左侧调整发送顺序，右侧编辑内容或挂载功能层。</p></header>
      <div class="artist-fields">
        <label class="config-field"><span>导入 JSON 预设</span><input type="file" data-preset-file accept=".json,application/json"></label>
        <p class="config-status${state.importError ? ' is-error' : ''}" data-preset-status role="status">${escape(state.importNotice ?? '导入后替换当前预设草稿，点击保存配置才会保留。')}</p>
        <label class="config-field"><span>预设名称</span><textarea data-model-field="presetName" rows="1" maxlength="256">${escape(settings.presetName)}</textarea></label>
      </div>
      <div class="preset-workspace" data-preset-workspace>${presetWorkspaceView(settings, state)}</div>
      <div class="parameter-group marker-settings"><h3 class="subsection-title">标记解析</h3>
        <label class="prompt-enable"><input type="checkbox" data-model-field="parseImageMarkers"${settings.parseImageMarkers ? ' checked' : ''}>解析配图标记</label>
        <p class="config-status">完整闭合的标记会在楼层中显示为生成图片按钮。</p>
        <label class="prompt-enable"><input type="checkbox" data-model-field="hideImageContext"${settings.hideImageContext ? ' checked' : ''}>从 AI 上下文隐藏配图标记</label>
        <p class="config-status">过滤完整的 &lt;img&gt;…&lt;/img&gt; 块，仅隐藏发送给 AI 的内容，保留楼层原文和生图按钮。</p>
        <p class="config-status${state.filterStatus?.error ? ' is-error' : ''}" data-context-filter-status role="status">${escape(state.filterStatus?.error || (state.filterStatus?.active ? '上下文过滤已启用。' : ''))}</p>
        <details class="prompt-section format-reference">
          <summary><span>查看配图标记与 AI 返回格式</span></summary>
          <code class="marker-format">&lt;img&gt;\n[图片内容概括]\n该场景的生图提示词\n&lt;/img&gt;</code>
          <p class="config-status">在悬浮球菜单点击“AI生图”时，正文副本会标注【插入点 P001】等行间位置。预设负责让 AI 返回以下 JSON 数组，插件按编号插入配图，保留原文。</p>
          <code class="marker-format">[{"at":"P001","summary":"图片内容概括","prompt":"该场景的生图提示词"}]</code>
          <p class="config-status">at 填本次提供的编号；summary 为概括；prompt 只填场景提示词。此处说明不会发送给模型。</p>
        </details>
      </div>
    </section>

    <div class="model-save-line" data-saved="${state.saved}">
      <button type="button" class="text-button" data-model-action="save-model"${state.saved ? ' disabled' : ''}>保存配置</button>
      <p class="config-status" data-model-status role="status">${state.saved ? '已保存在当前浏览器。' : ''}</p>
    </div>
  </div>`;
}
