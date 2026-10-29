import { navigation, pages, pluginName } from './pages.js';
import { updateHistoryView } from './update-history.js';
import { getHostStore, isTauriHost } from './host-storage.js';
import { getSyncApiKeys } from './host-settings.js';
const guideLinks = {
    imageConnection: { label: '密钥配置', page: 'image-api', selector: '[aria-labelledby="connection-heading"]' },
    imageParameters: { label: '生图配置', page: 'image-api', selector: '[aria-labelledby="parameters-heading"]' },
    artists: { label: '画师工坊', page: 'image-api', selector: '[aria-labelledby="artist-heading"]' },
    modelConnection: { label: '模型连接', page: 'model-api', selector: '[aria-labelledby="model-connection-heading"]' },
    presets: { label: '预设编排', page: 'model-api', selector: '[aria-labelledby="model-prompts-heading"]' },
    markers: { label: '标记与隐藏', page: 'model-api', selector: '.marker-settings' },
    round: { label: '本轮生图', page: 'features', featureTab: 'anchors', anchorTab: 'round' },
    anchors: { label: '锚定配置', page: 'features', featureTab: 'anchors', anchorTab: 'anchors' },
    outfits: { label: '通用服装库', page: 'features', featureTab: 'anchors', anchorTab: 'shared-outfits' },
    worldbookUpload: { label: '上传世界书', page: 'features', featureTab: 'worldbook', selector: '[data-worldbook-file]' },
    worldbookMount: { label: '挂载条目', page: 'features', featureTab: 'worldbook', selector: '[data-worldbook-mount]' },
    currentImages: { label: '当前角色卡', page: 'review', reviewScope: 'current' },
    allImages: { label: '全部角色卡', page: 'review', reviewScope: 'all' },
    habits: { label: '配图与留存', page: 'preferences', selector: '[aria-labelledby="image-habits-heading"]' },
    autoImages: { label: '自动生图', page: 'preferences', selector: '[name="autoGenerateImages"]' },
    retention: { label: '自动清理', page: 'preferences', selector: '[name="imageRetentionDays"]' },
    tia: { label: '桌宠缇娅', page: 'preferences', selector: '[aria-labelledby="pet-heading"]' },
    exportConfig: { label: '导出配置', page: 'preferences', selector: '[data-config-transfer] .config-section' },
    importConfig: { label: '导入配置', page: 'preferences', selector: '[data-transfer-file]' },
    updates: { label: '更新历史', page: 'preferences', selector: '[aria-labelledby="update-history-heading"]' },
};
export function guideDestination(key) {
    return key && Object.hasOwn(guideLinks, key) ? guideLinks[key] : undefined;
}
function guideLeaf(link, title, description, tags) {
    return `<div class="map-leaf">
    <button type="button" class="map-leaf-link" data-guide-target="${link}"><strong>${title}</strong><span>${description}</span></button>
    <nav class="map-tags" aria-label="${title}快捷索引">${tags.map(key => `<button type="button" data-guide-target="${key}">${guideLinks[key].label}</button>`).join('')}</nav>
  </div>`;
}
// 每个板块一格画匣颜料（取自 box_paint 的 8 格）；选中板块的颜色即面板主色
export const navigationPaints = {
    guide: '#EBA63A', connections: '#E6872A', features: '#C8A04C', review: '#8C6649', preferences: '#5C3D2A',
};
export function navigationView(page) {
    return `<i class="wash-mark" aria-hidden="true"></i>` + navigation.map((item, index) => `
    <button type="button" class="nav-item" data-page="${item.page}" style="--c:${navigationPaints[item.group]};--i:${index}"
      ${pages[page].group === item.group ? 'aria-current="page"' : ''}>
      <i class="nav-well" aria-hidden="true"></i><span class="nav-number" aria-hidden="true">0${index + 1}</span><span>${item.title}</span>
    </button>`).join('');
}
function node(page) {
    return `<button type="button" class="map-node" data-page="${page}">
    <strong>${pages[page].title}</strong><span>${pages[page].description}</span>
  </button>`;
}
function guideView() {
    return `
    <div class="next-step">
      <div><strong>先逛逛${pluginName}</strong><p>连接服务、找到功能，再按你的习惯布置画匣。点击板块进入，标签可直达具体设置。</p></div>
      <button type="button" class="primary" data-page="image-api">查看接口配置</button>
    </div>
    <section class="map" aria-label="插件功能系谱图，从上向下展示各板块">
      <div class="map-root"><div class="map-node"><strong>${pluginName}</strong><span>每一张图，都是一次小魔法</span></div></div>
      <div class="map-branches">
        <div class="map-branch">
          <button type="button" class="map-node" data-page="image-api">
            <strong>接口配置</strong><span>管理服务连接</span>
          </button>
          <div class="map-leaves">
            ${guideLeaf('imageConnection', pages['image-api'].title, pages['image-api'].description, ['imageConnection', 'imageParameters', 'artists'])}
            ${guideLeaf('modelConnection', pages['model-api'].title, pages['model-api'].description, ['modelConnection', 'presets', 'markers'])}
          </div>
        </div>
        <div class="map-branch">${node('features')}
          <div class="map-leaves">
            ${guideLeaf('round', '标签锚定', '固定角色外貌与服装', ['round', 'anchors', 'outfits'])}
            ${guideLeaf('worldbookUpload', '世界书', '上传并挂载参考条目', ['worldbookUpload', 'worldbookMount'])}
            ${guideLeaf('currentImages', pages.review.title, pages.review.description, ['currentImages', 'allImages'])}
          </div>
        </div>
        <div class="map-branch">${node('preferences')}
          <div class="map-leaves">
            ${guideLeaf('habits', '使用习惯', '安排配图留存，调整缇娅的陪伴', ['autoImages', 'retention', 'tia', 'updates'])}
            ${guideLeaf('exportConfig', '配置迁移与分享', '选择配置范围，迁移或分享', ['exportConfig', 'importConfig'])}
          </div>
        </div>
      </div>
    </section>
    <section class="guide-flow" aria-labelledby="guide-flow-heading">
      <h3 id="guide-flow-heading">从正文到配图</h3>
      <ol class="guide-steps">
        <li><span class="guide-step-number" aria-hidden="true">01</span><div><h4>连接接口，导入预设</h4><p>选择 NAI 或 GPT，配置两类 API，再导入对应服务的预设。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">02</span><div><h4>补充角色与世界资料</h4><p>按需要配置标签锚定、上传世界书，并勾选要挂载的条目。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">03</span><div><h4>让 AI 处理最新回复</h4><p>打开悬浮球菜单，点击“AI生图”，为正文插入配图位置。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">04</span><div><h4>在楼层中生成图片</h4><p>点击“生成图片”，或在使用偏好开启自动生图。已保存图片可在生图回顾中翻看。</p></div></li>
      </ol>
    </section>
    <section class="guide-transfer" aria-labelledby="guide-transfer-heading">
      <div><h3 id="guide-transfer-heading">把配置带走，也分享喜欢的内容</h3><p>点击按钮选择全部配置、画师串、预设或世界书。完整导出可选择是否包含 API 密钥和相应 URL；导入时先校验并展示内容，确认后才会写入。</p></div>
      <button type="button" class="secondary" data-page="preferences" data-section="config-transfer">配置迁移与分享 →</button>
    </section>`;
}
function hostSyncView() {
    if (!isTauriHost())
        return '';
    if (!getHostStore())
        return '<p class="config-status">当前 TT 版本未提供完整的扩展数据存储，配置仍保存在本机。更新 TT 后重新打开画匣即可迁移。</p>';
    return `<section class="image-settings" aria-label="TauriTavern 配置同步">
    <header class="section-heading section-heading--plain"><h2 class="section-title">TauriTavern 同步</h2>
      <p class="section-description">配置已接入 TT 扩展数据。同步时勾选“扩展数据”；页面记忆与悬浮球位置随酒馆设置同步。</p></header>
    <p class="config-status">包含接口参数、预设、画师串、角色与服装库、角色图、世界书及挂载选择。生成图片历史仍保存在本机。</p>
    <label class="preference-row"><span><strong>同时同步 API 密钥</strong><span>默认关闭，接收设备需自行填写密钥。开启后，已保存的生图与模型 API 密钥会写入 TT 扩展数据并参与同步。</span></span>
      <input type="checkbox" name="syncApiKeys" ${getSyncApiKeys() ? 'checked' : ''}></label>
    <p class="config-status" data-host-sync-status role="status">${getSyncApiKeys() ? 'API 密钥会随 TT 扩展数据同步。' : 'API 密钥仅保留在本机。'}</p>
  </section>`;
}
function preferencesView(settings) {
    return `
    <section class="preference-section" aria-labelledby="image-habits-heading">
      <header class="section-heading section-heading--plain"><h3 id="image-habits-heading" class="section-title">配图与留存</h3><p class="section-description">安排自动绘制，给本机画匣留出空间。</p></header>
      <label class="preference-row"><span><strong>自动清理生图</strong><span>按生成时间清理所有角色卡的本机图片历史；角色锚定图保留。开启后立即清理，关闭酒馆期间的过期图片会在下次打开时清理。</span></span>
        <select name="imageRetentionDays" aria-label="图片保留时间">${[[0, '关闭'], [1, '保留 1 天'], [3, '保留 3 天'], [7, '保留 7 天']].map(([value, label]) => `<option value="${value}"${settings.imageRetentionDays === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="config-status" data-cleanup-status role="status"></p>
      <label class="preference-row"><span><strong>自动生图</strong><span>仅限最新一楼。AI 回复结束、提示词稳定 1 秒后，按正文顺序依次绘制。会消耗生图额度；已有图片跳过，失败不自动重试，打开聊天或开启功能时不补跑历史标记。</span></span><input type="checkbox" name="autoGenerateImages" ${settings.autoGenerateImages ? 'checked' : ''}></label>
    </section>
    <section class="preference-section" aria-labelledby="pet-heading">
      <header class="section-heading section-heading--plain"><div class="pet-heading-line"><h3 id="pet-heading" class="section-title">桌宠缇娅</h3><small class="pet-credit">由 <strong>Lovéthia</strong> 宝宝制作，无比感谢！</small></div><p class="section-description">调整缇娅的大小、台词与动作；人物和画匣会一起缩放。</p></header>
      <div class="preference-row pet-size-row">
        <span><label for="pet-scale"><strong>缇娅的大小</strong></label><span id="pet-scale-description">50%～150%，拖动即时生效并自动保存。画匣同步缩放，菜单与台词文字大小不变。</span></span>
        <div class="pet-size-controls">
          <input id="pet-scale" name="petScale" type="range" min="50" max="150" step="1" value="${Math.round(settings.petScale * 100)}" aria-describedby="pet-scale-description" aria-valuetext="${Math.round(settings.petScale * 100)}%">
          <output for="pet-scale" data-pet-scale-value>${Math.round(settings.petScale * 100)}%</output>
          <button type="button" class="secondary" data-action="reset-pet-scale">恢复默认</button>
        </div>
      </div>
      <label class="preference-row"><span><strong>缇娅的台词</strong><span>仅在操作或有结果时触发，相同台词有冷却时间。关闭后不再说话，出错时仍显示报错文字。</span></span><input type="checkbox" name="petLines" ${settings.petLines ? 'checked' : ''}></label>
      <label class="preference-row"><span><strong>缇娅的动作</strong><span>关闭后仅保留呼吸和眨眼，取消走动、摆动及图片飞入楼层的动画。系统开启“减少动态效果”时同样生效。</span></span><input type="checkbox" name="petMotion" ${settings.petMotion ? 'checked' : ''}></label>
    </section>
    <label class="preference-row">
      <span><strong>回到上次页面</strong><span>再次打开时继续上次的位置；关闭后每次进入“开始使用”。</span></span>
      <input type="checkbox" name="rememberPage" ${settings.rememberPage ? 'checked' : ''}>
    </label>
    <label class="preference-row">
      <span><strong>记住悬浮球位置</strong><span>下次进入酒馆时，保留你拖动后的位置。</span></span>
      <input type="checkbox" name="rememberPosition" ${settings.rememberPosition ? 'checked' : ''}>
    </label>
    <div class="actions">
      <button type="button" class="secondary" data-action="reset-preferences">恢复默认偏好</button>
      <p class="muted" role="status" data-feedback>更改会自动保存。</p>
    </div>
    ${hostSyncView()}
    <div data-config-transfer></div>
    ${updateHistoryView()}`;
}
function featureView(tab) {
    return `<div class="image-settings feature-settings">
    <header class="section-heading"><span class="section-index" aria-hidden="true">01</span>
      <nav class="feature-tabs" aria-label="插件功能">
        <button type="button" data-feature-tab="anchors" aria-pressed="${tab === 'anchors'}">标签锚定</button>
        <button type="button" data-feature-tab="worldbook" aria-pressed="${tab === 'worldbook'}">世界书</button>
      </nav>
      <p class="section-description">${tab === 'anchors' ? '把喜欢的外貌留下，为角色搭配不同服装。' : '上传世界书，将需要的条目挂入生图预设。'}</p>
    </header>
    ${tab === 'anchors'
        ? '<div data-anchor-settings></div><details class="feature-provider-settings"><summary>预设功能接入</summary><div data-model-settings></div></details>'
        : '<div data-model-settings></div>'}
  </div>`;
}
export function pageView(page, settings, featureTab = 'anchors') {
    const heading = `<header class="page-heading">
    <p class="eyebrow">${page === 'guide' ? '从这里开始' : pluginName}</p>
    <h2>${pages[page].title}</h2><p>${pages[page].description}</p>
  </header>`;
    switch (page) {
        case 'guide': return heading + guideView();
        case 'image-api': return '<div data-image-settings></div>';
        case 'model-api': return '<div data-model-settings></div>';
        case 'features': return featureView(featureTab);
        case 'review': return heading + '<div data-image-review></div>';
        case 'preferences': return heading + preferencesView(settings);
    }
}
