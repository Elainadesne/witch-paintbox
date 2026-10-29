import { NAI_MODELS, NAI_SAMPLERS, NAI_SCHEDULES, NAI_SIZE_PRESETS } from './novelai.js';
import { getHostStore } from './host-storage.js';
import { getSyncApiKeys } from './host-settings.js';
import { OPENAI_IMAGE_QUALITIES } from './openai-image.js';
import { GEMINI_ASPECT_RATIOS, GEMINI_IMAGE_SIZES, GEMINI_MODELS, GROK_ASPECT_RATIOS, GROK_DEFAULT_MODEL, GROK_QUALITIES, GROK_RESOLUTIONS, geminiExpectedSize, geminiFixedTier, grokExpectedSize, } from './aspect-image.js';
export const OPENAI_SIZE_PRESETS = [
    { value: 'portrait', label: '竖图 (1024×1536)', width: 1024, height: 1536 },
    { value: 'landscape', label: '横图 (1536×1024)', width: 1536, height: 1024 },
    { value: 'square', label: '方图 (1024×1024)', width: 1024, height: 1024 },
];
const RATIO_NAMES = {
    auto: '自动', '1:1': '方图', '2:3': '竖图', '3:2': '横图', '3:4': '微竖', '4:3': '微横', '4:5': '微竖', '5:4': '微横',
    '9:16': '高竖', '16:9': '宽横', '2:1': '宽幅', '1:2': '长幅', '19.5:9': '手机横屏', '9:19.5': '手机竖屏', '20:9': '超宽', '9:20': '超高', '21:9': '电影宽幅', '5:2': '全景',
};
const ratioOptions = (ratios) => ratios.map(value => ({ value, label: `${value} · ${RATIO_NAMES[value] ?? ''}` }));
function providerSwitch(provider, moreOpen) {
    const open = moreOpen || provider === 'gemini' || provider === 'grok';
    const tab = (value, label, extra = '') => `<button type="button" data-action="switch-provider" data-provider="${value}" aria-pressed="${provider === value}"${extra}>${label}</button>`;
    return `<div class="feature-tabs image-provider-switch" role="group" aria-label="生图接口类型" data-more-open="${open}">
      ${tab('novelai', 'NAI')}
      ${tab('openai', 'GPT（OpenAI 兼容）')}
      <button type="button" class="provider-more-toggle" data-action="toggle-more-providers" aria-expanded="${open}" aria-controls="witch-provider-more"${provider === 'gemini' || provider === 'grok' ? ' aria-disabled="true" title="当前正在使用其中的画笔，纸条保持展开"' : ''}>
        <span class="provider-more-label">${open ? '收起' : '更多画笔'}</span><span class="provider-more-fold" aria-hidden="true"></span>
      </button>
      <div class="provider-more-strip" id="witch-provider-more"${open ? '' : ' hidden'}>
        ${tab('gemini', 'Gemini', open ? '' : ' tabindex="-1"')}
        ${tab('grok', 'Grok', open ? '' : ' tabindex="-1"')}
      </div>
    </div>`;
}
function suffixHint(provider, protocol) {
    if (provider === 'novelai')
        return '/ai/generate-image';
    if (provider === 'gemini' && protocol === 'interactions')
        return '/v1beta/interactions';
    if (provider === 'gemini' && protocol === 'generateContent')
        return '/v1beta/models/{模型}:generateContent';
    return '/images/generations（仅填域名时补 /v1/images/generations）';
}
export function aspectParameters(settings) {
    const gemini = settings.provider === 'gemini';
    if (gemini) {
        const p = settings.geminiParameters;
        const tier = geminiFixedTier(p.model);
        const size = geminiExpectedSize(p.model, p.aspectRatio, p.imageSize);
        return `<div class="parameter-grid aspect-grid">
        <label class="config-field"><span data-size-selection-label>画面比例</span><select data-parameter="aspectRatio">${options(ratioOptions(GEMINI_ASPECT_RATIOS), p.aspectRatio)}</select></label>
        <label class="config-field"><span>分辨率</span><select data-parameter="imageSize"${tier ? ' disabled' : ''}>${options(GEMINI_IMAGE_SIZES.map(value => ({ value, label: value })), tier === 'omit' ? '1K' : tier ?? p.imageSize)}</select></label>
      </div>
      <p class="config-status" data-aspect-hint>预计约 ${size.width} × ${size.height}${tier ? '；该模型只出默认档位' : ''}。实际尺寸以返回图片为准。</p>`;
    }
    const p = settings.grokParameters;
    const size = grokExpectedSize(p.aspectRatio, p.resolution);
    return `<div class="parameter-grid aspect-grid">
        <label class="config-field"><span data-size-selection-label>画面比例</span><select data-parameter="aspectRatio">${options(ratioOptions(GROK_ASPECT_RATIOS), p.aspectRatio)}</select></label>
        <label class="config-field"><span>分辨率</span><select data-parameter="resolution">${options(GROK_RESOLUTIONS.map(value => ({ value, label: value.toUpperCase() })), p.resolution)}</select></label>
        <label class="config-field"><span>生成质量</span><select data-parameter="quality">${options(GROK_QUALITIES.map(value => ({ value, label: value === 'auto' ? '自动 · auto' : value })), p.quality)}</select></label>
      </div>
      <p class="config-status" data-aspect-hint>预计长边约 ${Math.max(size.width, size.height)} 像素${p.protocol === 'openai' ? '；兼容协议会把比例换成 size 发送' : ''}。实际尺寸以返回图片为准。</p>`;
}
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
    const kind = settings.provider;
    const aspect = kind === 'gemini' || kind === 'grok';
    const openai = kind === 'openai';
    const natural = kind !== 'novelai';
    const protocol = kind === 'gemini' ? settings.geminiParameters.protocol : kind === 'grok' ? settings.grokParameters.protocol : '';
    const modelValue = kind === 'gemini' ? settings.geminiParameters.model : kind === 'grok' ? settings.grokParameters.model : settings.openaiParameters.model;
    const suggested = kind === 'gemini' ? [...GEMINI_MODELS] : kind === 'grok' ? [GROK_DEFAULT_MODEL] : [];
    const modelList = [...new Set([...suggested, ...settings.models])];
    const serviceName = { novelai: 'NAI', openai: 'GPT 生图服务', gemini: 'Gemini', grok: 'Grok' }[kind];
    const dimensions = openai ? settings.openaiParameters : parameters;
    const sizePresets = openai ? OPENAI_SIZE_PRESETS : NAI_SIZE_PRESETS;
    const sizePreset = sizePresets.find(item => item.width === dimensions.width && item.height === dimensions.height)?.value ?? 'custom';
    return `<div class="image-settings">
    ${providerSwitch(kind, state.moreOpen)}
    <section class="config-section" aria-labelledby="connection-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">01</span>
        <h2 class="section-title" id="connection-heading">密钥配置</h2><p class="section-description">选择绘图服务，保存可复用的连接。</p></header>
      <div class="connection-fields">
        ${aspect ? `<label class="config-field channel-field"><span>接口协议</span>
          <select data-parameter="protocol">${options(kind === 'gemini'
        ? [{ value: 'interactions', label: 'Interactions（官方，推荐）' }, { value: 'generateContent', label: 'generateContent（原生 / 中转）' }, { value: 'openai', label: 'OpenAI 兼容（中转站）' }]
        : [{ value: 'xai', label: 'xAI 原生（官方，推荐）' }, { value: 'openai', label: 'OpenAI 兼容（中转站）' }], protocol)}</select>
        </label>` : ''}
        <label class="config-field channel-field"><span>渠道</span>
          <select data-connection="channel">${options([{ value: 'official', label: '官方' }, { value: 'custom', label: '自定义' }], connection.channel)}</select>
        </label>
        <div data-custom-url${connection.channel === 'custom' ? '' : ' hidden'}>
          <label class="config-field"><span>服务 URL</span>
            <input type="url" data-connection="url" value="${escape(connection.url)}" placeholder="请输入 URL" maxlength="8192" autocomplete="off" spellcheck="false">
          </label>
          <div class="parameter-toggles"><label><input type="checkbox" data-connection="appendSuffix" aria-describedby="image-url-hint"${connection.appendSuffix ? ' checked' : ''}>自动拼接接口后缀</label></div>
          <p class="config-status" id="image-url-hint">开启后补齐 ${suffixHint(kind, protocol)}，已有后缀不重复添加；关闭后按填写的完整 URL 请求。</p>
        </div>
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
        <h2 class="section-title" id="parameters-heading">生图配置</h2><p class="section-description">${aspect ? '填写或获取模型，再定比例与分辨率。' : openai ? '填写或获取模型，再调整画幅与质量。' : '选定模型，再调整画幅与采样。'}</p></header>
      ${natural ? `<div class="model-choice-line">
        <label class="config-field prominent-field"><span>生图模型</span>
          <input type="text" data-parameter="model" value="${escape(modelValue)}" list="witch-image-model-options" maxlength="512" placeholder="选择或填写生图模型名称" autocomplete="off" spellcheck="false">
          <datalist id="witch-image-model-options">${modelList.map(model => `<option value="${escape(model)}"></option>`).join('')}</datalist>
        </label>
        <button type="button" class="text-button" data-action="refresh-models"${state.refreshing ? ' disabled' : ''}>${state.refreshing ? '刷新中…' : '刷新列表'}</button>
      </div><p class="config-status" data-model-list-status role="status"></p>`
        : `<label class="config-field prominent-field"><span>生图模型</span><select data-parameter="model">${options(NAI_MODELS, parameters.model)}</select></label>`}
      <div class="parameter-group"><h3 class="subsection-title">画幅</h3>
        <div class="feature-tabs image-size-switch" aria-label="画幅选择方式">
          <button type="button" data-action="select-size-mode" data-size-mode="fixed" aria-pressed="true">固定画幅</button>
          <button type="button" data-action="select-size-mode" data-size-mode="ai" aria-pressed="false">AI 动态画幅</button>
        </div>
        <p class="config-status" data-size-mode-status role="status"></p>
        ${aspect ? `<div data-aspect-block>${aspectParameters(settings)}</div>` : `<div class="parameter-grid">
        <label class="config-field"><span data-size-selection-label>预设尺寸</span><select data-field="sizePreset">${options([...sizePresets, { value: 'custom', label: '自定义' }], sizePreset)}</select></label>
        ${numberField('width', '宽度', dimensions.width, 64, 4096, openai ? 16 : 64, `图片宽度，单位为像素，使用 ${openai ? 16 : 64} 的倍数。`)}
        ${numberField('height', '高度', dimensions.height, 64, 4096, openai ? 16 : 64, `图片高度，单位为像素，使用 ${openai ? 16 : 64} 的倍数。`)}
      </div>`}</div>
      ${aspect ? '' : openai ? `<div class="parameter-group"><h3 class="subsection-title">质量</h3>
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

    ${natural ? '' : `<div class="advanced-features" data-open="${Boolean(state.advancedOpen)}">
      <div class="advanced-toggle-line"><button type="button" class="advanced-toggle" data-action="toggle-advanced" aria-expanded="${Boolean(state.advancedOpen)}" aria-controls="witch-advanced-panel">
        <span>高级功能</span><span class="advanced-chevron" aria-hidden="true"></span></button></div>
      <section class="config-section advanced-panel" id="witch-advanced-panel" aria-labelledby="vibe-heading"${state.advancedOpen ? '' : ' hidden'}>
        <header class="section-heading"><span class="section-index" aria-hidden="true">✦</span>
          <h2 class="section-title" id="vibe-heading">氛围参考</h2><p class="section-description">上传参考图，让画风、色调和笔触向它靠拢（NAI Vibe Transfer）。</p></header>
        <div data-vibe-host></div>
      </section>
    </div>`}
    <section class="config-section" aria-labelledby="artist-heading">
      <header class="section-heading"><span class="section-index" aria-hidden="true">03</span>
        <h2 class="section-title" id="artist-heading">画师工坊</h2><p class="section-description">${natural ? '保存常用的画风描述，和每个场景的提示词一起使用。' : '统一画风与排除内容，和每个场景的提示词一起使用。'}</p></header>
      <div class="artist-fields">
        <label class="config-field"><span>正面提示词</span><textarea data-field="positive" rows="3" maxlength="65536" spellcheck="false">${escape(settings.positive)}</textarea></label>
        ${natural ? `<p class="config-status">${serviceName.replace(' 生图服务', '')} 生图不提供独立负面栏；需要排除的内容请在预设或正面描述里用自然语言写明。</p>`
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
        <strong>点击生成图片</strong><span>使用当前配置连接 ${serviceName}</span>
      </button>
      <div data-output></div>
      <div class="generation-actions"><button type="button" class="text-button" data-action="cancel-generation" hidden>取消等待</button></div>
      <p class="config-status" data-generation-status role="status"></p>
    </section>
  </div>`;
}
