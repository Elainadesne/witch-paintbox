import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULES, NAI_SIZE_PRESETS } from './novelai.js';
import { getHostStore } from './host-storage.js';
import { getSyncApiKeys } from './host-settings.js';
import { OPENAI_IMAGE_QUALITIES } from './openai-image.js';
export const OPENAI_SIZE_PRESETS = [
    { value: 'portrait', label: '竖图 (1024×1536)', width: 1024, height: 1536 },
    { value: 'landscape', label: '横图 (1536×1024)', width: 1536, height: 1024 },
    { value: 'square', label: '方图 (1024×1024)', width: 1024, height: 1024 },
];
function escape(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}
function options(items, selected) {
    return items.map(item => `<option value="${escape(item.value)}"${item.value === selected ? ' selected' : ''}>${escape(item.label)}</option>`).join('');
}
function numberField(name, label, value, min, max, step = 1, title = '') {
    return `<label class="config-field"${title ? ` title="${escape(title)}"` : ''}>
    <span>${label}</span><input type="number" data-parameter="${name}" value="${escape(value)}" min="${min}" max="${max}" step="${step}" required>
  </label>`;
}
export function imageSettingsView(settings, state) {
    const { connection, parameters } = settings;
    const openai = settings.provider === 'openai';
    const dimensions = openai ? settings.openaiParameters : parameters;
    const sizePresets = openai ? OPENAI_SIZE_PRESETS : NAI_SIZE_PRESETS;
    const sizePreset = sizePresets.find(item => item.width === dimensions.width && item.height === dimensions.height)?.value ?? 'custom';
    return `<div class="image-settings">
    <div class="feature-tabs image-provider-switch" aria-label="生图接口类型">
      <button type="button" data-action="switch-provider" data-provider="novelai" aria-pressed="${!openai}">NAI</button>
      <button type="button" data-action="switch-provider" data-provider="openai" aria-pressed="${openai}">GPT（OpenAI 兼容）</button>
    </div>
    <section class="config-section" aria-labelledby="connection-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">01</span>
        <h2 class="section-title" id="connection-heading">密钥配置</h2><p class="section-description">选择绘图服务，保存可复用的连接。</p></header>
      <div class="connection-fields">
        <label class="config-field channel-field"><span>渠道</span>
          <select data-connection="channel">${options([{ value: 'official', label: '官方' }, { value: 'custom', label: '自定义' }], connection.channel)}</select>
        </label>
        <label class="config-field" data-custom-url${connection.channel === 'custom' ? '' : ' hidden'}><span>服务 URL</span>
          <input type="url" data-connection="url" value="${escape(connection.url)}" placeholder="请输入 URL" maxlength="8192" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div class="credential-line" data-saved="${state.connectionSaved}">
        <details class="connection-box">
          <summary>配置</summary>
          <div class="connection-drawer">
            <label class="config-field"><span>已存配置</span>
              <select data-field="connectionProfile"><option value="">新配置</option>${options(settings.connectionProfiles.map(item => ({ value: item.id, label: item.name })), settings.activeConnectionId)}</select>
            </label>
            <label class="config-field"><span>配置名称</span>
              <input type="text" data-field="connectionName" value="${escape(state.connectionName)}" maxlength="128" autocomplete="off">
            </label>
          </div>
        </details>
        <label class="key-field"><span>密钥</span><input type="password" data-connection="key" value="${escape(connection.key)}" maxlength="16384" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
        <button type="button" class="text-button key-toggle" data-action="toggle-key" aria-pressed="false">显示</button>
        <button type="button" class="text-button" data-action="save-connection"${state.connectionSaved ? ' disabled' : ''}>保存</button>
      </div>
      <p class="config-status" data-connection-status role="status">${getHostStore()
        ? `${state.connectionSaved ? '配置已保存到 TT 扩展数据。' : '点击保存后，配置会写入 TT 扩展数据。'}${getSyncApiKeys() ? '密钥参与同步。' : '密钥仅保存在本机。'}`
        : state.connectionSaved ? '已保存在当前浏览器。' : '点击保存后，密钥会保存在当前浏览器。'}</p>
    </section>

    <section class="config-section" aria-labelledby="parameters-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">02</span>
        <h2 class="section-title" id="parameters-heading">生图配置</h2><p class="section-description">${openai ? '填写或获取模型，再调整画幅与质量。' : '选定模型，再调整画幅与采样。'}</p></header>
      ${openai ? `<div class="model-choice-line">
        <label class="config-field prominent-field"><span>生图模型</span>
          <input type="text" data-parameter="model" value="${escape(settings.openaiParameters.model)}" list="witch-image-model-options" maxlength="512" placeholder="选择或填写生图模型名称" autocomplete="off" spellcheck="false">
          <datalist id="witch-image-model-options">${settings.models.map(model => `<option value="${escape(model)}"></option>`).join('')}</datalist>
        </label>
        <button type="button" class="text-button" data-action="refresh-models"${state.refreshing ? ' disabled' : ''}>${state.refreshing ? '刷新中…' : '刷新列表'}</button>
      </div><p class="config-status" data-model-list-status role="status"></p>`
        : `<label class="config-field prominent-field"><span>生图模型</span><select data-parameter="model">${options(NAI_MODELS, parameters.model)}</select></label>`}
      <div class="parameter-group"><h3 class="subsection-title">画幅</h3><div class="parameter-grid">
        <label class="config-field"><span>预设尺寸</span><select data-field="sizePreset">${options([...sizePresets, { value: 'custom', label: '自定义' }], sizePreset)}</select></label>
        ${numberField('width', '宽度', dimensions.width, 64, 4096, openai ? 16 : 64, `图片宽度，单位为像素，使用 ${openai ? 16 : 64} 的倍数。`)}
        ${numberField('height', '高度', dimensions.height, 64, 4096, openai ? 16 : 64, `图片高度，单位为像素，使用 ${openai ? 16 : 64} 的倍数。`)}
      </div></div>
      ${openai ? `<div class="parameter-group"><h3 class="subsection-title">质量</h3>
        <label class="config-field"><span>生成质量</span><select data-parameter="quality">${options(OPENAI_IMAGE_QUALITIES.map(value => ({ value, label: value === 'auto' ? '自动 · auto' : value })), settings.openaiParameters.quality)}</select></label>
        <p class="config-status">可用尺寸和质量由所选模型与服务决定。</p>
      </div>` : `<div class="parameter-group"><h3 class="subsection-title">采样</h3><div class="parameter-grid sampling-grid">
        ${numberField('steps', '步数', parameters.steps, 1, 50, 1, '生成时的采样步数。')}
        ${numberField('scale', '提示词引导强度', parameters.scale, 0, 100, 0.1, '控制生成结果遵循提示词的程度。')}
        <label class="config-field"><span>采样器</span><select data-parameter="sampler">${options(NAI_SAMPLERS, parameters.sampler)}</select></label>
        ${numberField('seed', '随机种子', parameters.seed, -1, 4294967295, 1, '填 -1 时每次使用新的随机种子。')}
      </div></div>
      <details class="advanced-parameters">
        <summary>更多参数</summary>
        <div class="parameter-grid">
          <label class="config-field"><span>噪声调度</span><select data-parameter="noiseSchedule">${options(NAI_SCHEDULES, parameters.noiseSchedule)}</select></label>
          ${numberField('cfgRescale', '引导重缩放', parameters.cfgRescale, 0, 1, 0.01, 'CFG Rescale，用于调整高引导强度带来的变化。')}
          <div class="parameter-toggles">
            <label><input type="checkbox" data-parameter="sm"${parameters.sm ? ' checked' : ''}>SMEA</label>
            <label><input type="checkbox" data-parameter="smDyn"${parameters.smDyn ? ' checked' : ''}>SMEA DYN</label>
          </div>
        </div>
      </details>`}
      <p class="config-status" data-settings-status role="status"></p>
    </section>

    <section class="config-section" aria-labelledby="artist-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">03</span>
        <h2 class="section-title" id="artist-heading">画师工坊</h2><p class="section-description">${openai ? '保存常用的画风描述，和每个场景的提示词一起使用。' : '统一画风与排除内容，和每个场景的提示词一起使用。'}</p></header>
      <div class="artist-fields">
        <label class="config-field"><span>正面提示词</span><textarea data-field="positive" rows="3" maxlength="65536" spellcheck="false">${escape(settings.positive)}</textarea></label>
        ${openai ? '<p class="config-status">GPT 生图不提供独立负面栏；需要排除的内容请在自己的预设中描述。</p>'
        : `<label class="config-field"><span>负面提示词</span><textarea data-field="negative" rows="3" maxlength="65536" spellcheck="false">${escape(settings.negative)}</textarea></label>`}
      </div>
      <div class="artist-presets">
        <label class="config-field"><span>画师配置</span><select data-field="artistPreset"><option value="">草稿</option>${options(settings.artists.map(item => ({ value: item.id, label: item.name })), settings.activeArtistId)}</select></label>
        <label class="config-field"><span>配置名称</span><input type="text" data-field="artistName" value="${escape(state.artistName)}" maxlength="128" autocomplete="off"></label>
      </div>
      <div class="artist-actions">
        <button type="button" class="text-button" data-action="save-artist">保存</button>
        <button type="button" class="text-button" data-action="update-artist"${settings.activeArtistId ? '' : ' disabled'}>更新</button>
        <button type="button" class="text-button" data-action="delete-artist"${settings.activeArtistId ? '' : ' disabled'}>删除</button>
      </div>
      <p class="config-status" data-artist-status role="status"></p>
    </section>

    <section class="generation-area" aria-label="生成图片">
      <button type="button" class="generation-trigger" data-action="generate">
        <strong>点击生成图片</strong><span>使用当前配置连接 ${openai ? 'GPT 生图服务' : 'NAI'}</span>
      </button>
      <div data-output></div>
      <div class="generation-actions"><button type="button" class="text-button" data-action="cancel-generation" hidden>取消等待</button></div>
      <p class="config-status" data-generation-status role="status"></p>
    </section>
  </div>`;
}
