import { navigation, pages, pluginName } from './pages.js';
export function navigationView(page) {
    return navigation.map((item, index) => `
    <button type="button" class="nav-item" data-page="${item.page}"
      ${pages[page].group === item.group ? 'aria-current="page"' : ''}>
      <span class="nav-number" aria-hidden="true">0${index + 1}</span><span>${item.title}</span>
    </button>`).join('');
}
function node(page, className = 'map-node') {
    return `<button type="button" class="${className}" data-page="${page}">
    <strong>${pages[page].title}</strong><span>${pages[page].description}</span>
  </button>`;
}
function guideView() {
    return `
    <div class="next-step">
      <div><strong>先逛逛${pluginName}</strong><p>连接服务、找到功能，再按你的习惯布置画匣。点击下面的节点即可前往。</p></div>
      <button type="button" class="primary" data-page="image-api">查看接口配置</button>
    </div>
    <section class="map" aria-label="插件功能系谱图，从上向下展示各板块">
      <div class="map-root"><div class="map-node"><strong>${pluginName}</strong><span>每一张图，都是一次小魔法</span></div></div>
      <div class="map-branches">
        <div class="map-branch">
          <button type="button" class="map-node" data-page="image-api">
            <strong>接口配置</strong><span>管理服务连接</span>
          </button>
          <div class="map-leaves">${node('image-api', 'map-leaf')}${node('model-api', 'map-leaf')}</div>
        </div>
        <div class="map-branch">${node('features')}</div>
        <div class="map-branch">${node('preferences')}</div>
      </div>
    </section>`;
}
function preferencesView(settings) {
    return `
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
    </div>`;
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
        case 'preferences': return heading + preferencesView(settings);
    }
}
