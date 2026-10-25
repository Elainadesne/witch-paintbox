import { navigation, pages, pluginName, type PageId } from './pages.js';
import type { Settings } from './settings.js';
import { updateHistoryView } from './update-history.js';
import { getHostStore, isTauriHost } from './host-storage.js';
import { getSyncApiKeys } from './host-settings.js';

export type FeatureTab = 'anchors' | 'worldbook';

export function navigationView(page: PageId): string {
  return navigation.map((item, index) => `
    <button type="button" class="nav-item" data-page="${item.page}"
      ${pages[page].group === item.group ? 'aria-current="page"' : ''}>
      <span class="nav-number" aria-hidden="true">0${index + 1}</span><span>${item.title}</span>
    </button>`).join('');
}

function node(page: PageId, className = 'map-node'): string {
  return `<button type="button" class="${className}" data-page="${page}">
    <strong>${pages[page].title}</strong><span>${pages[page].description}</span>
  </button>`;
}

function guideView(): string {
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
        <div class="map-branch">${node('features')}
          <div class="map-leaves">
            <button type="button" class="map-leaf" data-page="features" data-feature-tab="anchors"><strong>标签锚定</strong><span>固定角色外貌与服装</span></button>
            <button type="button" class="map-leaf" data-page="features" data-feature-tab="worldbook"><strong>世界书</strong><span>上传并挂载参考条目</span></button>
            ${node('review', 'map-leaf')}
          </div>
        </div>
        <div class="map-branch">${node('preferences')}
          <div class="map-leaves"><button type="button" class="map-leaf" data-page="preferences" data-section="config-transfer"><strong>配置迁移与分享</strong><span>选择配置范围，迁移或分享</span></button></div>
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

function hostSyncView(): string {
  if (!isTauriHost()) return '';
  if (!getHostStore()) return '<p class="config-status">当前 TT 版本未提供完整的扩展数据存储，配置仍保存在本机。更新 TT 后重新打开画匣即可迁移。</p>';
  return `<section class="image-settings" aria-label="TauriTavern 配置同步">
    <header class="section-heading section-heading--plain"><h2 class="section-title">TauriTavern 同步</h2>
      <p class="section-description">配置已接入 TT 扩展数据。同步时勾选“扩展数据”；页面记忆与悬浮球位置随酒馆设置同步。</p></header>
    <p class="config-status">包含接口参数、预设、画师串、角色与服装库、角色图、世界书及挂载选择。生成图片历史仍保存在本机。</p>
    <label class="preference-row"><span><strong>同时同步 API 密钥</strong><span>默认关闭，接收设备需自行填写密钥。开启后，已保存的生图与模型 API 密钥会写入 TT 扩展数据并参与同步。</span></span>
      <input type="checkbox" name="syncApiKeys" ${getSyncApiKeys() ? 'checked' : ''}></label>
    <p class="config-status" data-host-sync-status role="status">${getSyncApiKeys() ? 'API 密钥会随 TT 扩展数据同步。' : 'API 密钥仅保留在本机。'}</p>
  </section>`;
}

function preferencesView(settings: Settings): string {
  return `
    <section class="preference-section" aria-labelledby="image-habits-heading">
      <header class="section-heading section-heading--plain"><h3 id="image-habits-heading" class="section-title">配图与留存</h3><p class="section-description">安排自动绘制，给本机画匣留出空间。</p></header>
      <label class="preference-row"><span><strong>自动清理生图</strong><span>按生成时间清理所有角色卡的本机图片历史；角色锚定图保留。开启后立即清理，关闭酒馆期间的过期图片会在下次打开时清理。</span></span>
        <select name="imageRetentionDays" aria-label="图片保留时间">${[[0, '关闭'], [1, '保留 1 天'], [3, '保留 3 天'], [7, '保留 7 天']].map(([value, label]) => `<option value="${value}"${settings.imageRetentionDays === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="config-status" data-cleanup-status role="status"></p>
      <label class="preference-row"><span><strong>自动生图</strong><span>AI 回复结束、提示词稳定 1 秒后，按正文顺序依次绘制。会消耗生图额度；已有图片跳过，失败不自动重试。</span></span><input type="checkbox" name="autoGenerateImages" ${settings.autoGenerateImages ? 'checked' : ''}></label>
      <label class="preference-row"><span><strong>仅限最新一楼</strong><span>关闭后也处理本次打开聊天后其他楼层新增的配图标记。打开聊天或开启功能时，不补跑已有标记。</span></span><input type="checkbox" name="autoGenerateLatestOnly" ${settings.autoGenerateLatestOnly ? 'checked' : ''}></label>
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

function featureView(tab: FeatureTab): string {
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

export function pageView(page: PageId, settings: Settings, featureTab: FeatureTab = 'anchors'): string {
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
