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
      <div><strong>先逛逛莉露的画匣</strong><p>连接服务、找到功能，再按你的习惯布置画匣。点击下面的节点即可前往。</p></div>
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
function connectionView(page) {
    return `
    <nav class="subnav" aria-label="接口类型">
      ${['image-api', 'model-api'].map(id => `
        <button type="button" data-page="${id}" ${id === page ? 'aria-current="page"' : ''}>${pages[id].title}</button>
      `).join('')}
    </nav>
    <div class="empty-state">
      <span class="status">尚未配置</span>
      <h3>${page === 'image-api' ? '生图服务' : '模型服务'}</h3>
      <p>${pages[page].description}</p>
      <p class="muted">连接设置暂未开放。</p>
    </div>`;
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
export function pageView(page, settings) {
    const heading = `<header class="page-heading">
    <p class="eyebrow">${page === 'guide' ? '从这里开始' : pluginName}</p>
    <h2>${pages[page].title}</h2><p>${pages[page].description}</p>
  </header>`;
    switch (page) {
        case 'guide': return heading + guideView();
        case 'image-api':
        case 'model-api': return heading + connectionView(page);
        case 'features': return heading + `
      <div class="empty-state"><h3>功能将在这里集合</h3><p>目前还没有开放的功能。</p></div>`;
        case 'preferences': return heading + preferencesView(settings);
    }
}
