function escape(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}
function options(items, selected) {
    return items.map(item => `<option value="${escape(item.value)}"${item.value === selected ? ' selected' : ''}>${escape(item.label)}</option>`).join('');
}
function promptSection(section, title, entries, offset = 0) {
    return `<details class="prompt-section" data-section="${section}">
    <summary><span>${title}</span><span class="prompt-count">${entries.length} 条</span></summary>
    <div class="prompt-list">
      ${entries.map((entry, index) => `<div class="prompt-entry" data-entry-id="${escape(entry.id)}" data-section="${section}">
        <label class="config-field"><span>第 ${offset + index + 1} 条 · 名称</span><textarea data-prompt-field="name" rows="1" maxlength="256">${escape(entry.name)}</textarea></label>
        <div class="prompt-entry-toolbar">
          <label class="config-field"><span>角色</span>
            <select data-prompt-field="role">${options([
        { value: 'system', label: '系统 · system' },
        { value: 'user', label: '用户 · user' },
        { value: 'assistant', label: '助手 · assistant' },
    ], entry.role)}</select>
          </label>
          <label class="prompt-enable"><input type="checkbox" data-prompt-field="enabled"${entry.enabled ? ' checked' : ''}${entry.marker ? ' disabled' : ''}>启用</label>
          <button type="button" class="text-button" data-model-action="remove-entry" data-entry-id="${escape(entry.id)}" data-section="${section}" aria-label="删除${title}第 ${index + 1} 条">删除</button>
        </div>
        <label class="config-field"><span>正文</span><textarea data-prompt-field="content" rows="4" maxlength="65536" spellcheck="false">${escape(entry.content)}</textarea></label>
        ${entry.marker ? '<p class="config-status">酒馆占位标记，保留供查看，不会发送。</p>' : ''}
      </div>`).join('')}
      ${entries.length ? '' : '<p class="config-status">暂未添加，可留空。</p>'}
      <button type="button" class="text-button prompt-add" data-model-action="add-${section}">添加条目</button>
    </div>
  </details>`;
}
export function modelSettingsView(settings, state) {
    const entries = [...settings.head, ...settings.tail];
    return `<div class="image-settings model-settings">
    <section class="config-section" aria-labelledby="model-connection-heading">
      <h2 class="section-title" id="model-connection-heading">模型连接</h2>
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
      <div class="parameter-grid model-parameters">
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
      </div>
    </section>

    <section class="config-section" aria-labelledby="model-prompts-heading">
      <h2 class="section-title" id="model-prompts-heading">预设编排</h2>
      <div class="artist-fields">
        <label class="config-field"><span>导入 JSON 预设</span><input type="file" data-preset-file accept=".json,application/json"></label>
        <p class="config-status${state.importError ? ' is-error' : ''}" data-preset-status role="status">${escape(state.importNotice ?? '导入后替换当前预设草稿，点击保存配置才会保留。')}</p>
        <label class="config-field"><span>预设名称</span><textarea data-model-field="presetName" rows="1" maxlength="256">${escape(settings.presetName)}</textarea></label>
        <label class="config-field"><span>功能层插入位置</span>
          <select data-insertion-index>${Array.from({ length: entries.length + 1 }, (_, index) => `<option value="${index}"${index === settings.head.length ? ' selected' : ''}>${index === 0 ? '0 · 全部条目之前' : escape(`${index} · 第 ${index} 条之后：${entries[index - 1].name || entries[index - 1].id}`)}</option>`).join('')}</select>
        </label>
        <label class="prompt-enable"><input type="checkbox" data-model-field="parseImageMarkers"${settings.parseImageMarkers ? ' checked' : ''}>解析配图标记</label>
        <p class="config-status">每个标记按以下四行格式闭合；此处说明不会发送给模型。</p>
        <code class="marker-format">&lt;img&gt;\n[图片内容概括]\n该场景的生图提示词\n&lt;/img&gt;</code>
      </div>
      <div class="prompt-sections">
        ${promptSection('head', '头部', settings.head)}
        <details class="prompt-section prompt-middle">
          <summary><span>中部 · 功能层</span><span class="prompt-count">${settings.enabledLayers.length} 项启用</span></summary>
          <p class="config-status">此处放入已启用的功能层内容和本次待处理原文。</p>
        </details>
        ${promptSection('tail', '尾部', settings.tail, settings.head.length)}
      </div>
      <button type="button" class="text-button model-feature-link" data-page="features">前往功能层配置 →</button>
    </section>

    <div class="model-save-line" data-saved="${state.saved}">
      <button type="button" class="text-button" data-model-action="save-model"${state.saved ? ' disabled' : ''}>保存配置</button>
      <p class="config-status" data-model-status role="status">${state.saved ? '已保存在当前浏览器。' : ''}</p>
    </div>
  </div>`;
}
