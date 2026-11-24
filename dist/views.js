import { navigation, pages, pluginName } from './pages.js';
import { MAX_AUTO_IMAGE_DELAY, MAX_IMAGE_CONCURRENCY } from './settings.js';
import { updateHistoryView } from './update-history.js';
import { getHostStore, isTauriHost } from './host-storage.js';
import { getSyncApiKeys } from './host-settings.js';
import { loadImageSettings } from './image-settings.js';
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
    habits: { label: '出图与生图', page: 'image-workflow', selector: '[aria-labelledby="image-habits-heading"]' },
    autoProcess: { label: '回复后自动写 Tag', page: 'image-workflow', selector: '[name="autoProcessReplies"]' },
    autoImages: { label: '新标记自动出图', page: 'image-workflow', selector: '[name="autoGenerateImages"]' },
    retention: { label: '自动清理', page: 'image-workflow', selector: '[name="imageRetentionDays"]' },
    concurrency: { label: '并发生图', page: 'image-workflow', selector: '[name="imageConcurrency"]' },
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
    function branch(items, depth = 0) {
        return items.map((item, index) => {
            const children = item.children?.length ? branch(item.children, depth + 1) : '';
            return `<div class="nav-branch${depth ? ' nav-branch--child' : ''}">
        <button type="button" class="nav-item${depth ? ' nav-item--child' : ''}${children && pages[page].group === item.group ? ' has-active-child' : ''}"
          data-page="${item.page}" style="--c:${navigationPaints[item.group]};--i:${index}"
          ${page === item.page || !children && !depth && pages[page].group === item.group ? 'aria-current="page"' : ''}>
          <i class="nav-well" aria-hidden="true"></i><span class="nav-number" aria-hidden="true">0${index + 1}</span><span>${item.title}</span>
        </button>
        ${children ? `<div class="nav-children" role="group" aria-label="${item.title}子页面">${children}</div>` : ''}
      </div>`;
        }).join('');
    }
    return `<i class="wash-mark" aria-hidden="true"></i>` + branch(navigation);
}
function node(page) {
    return `<button type="button" class="map-node" data-page="${page}">
    <strong>${pages[page].title}</strong><span>${pages[page].description}</span>
  </button>`;
}
// 引导页由缇娅出面：按生图接口是否已有密钥换一句话和下一步。
function tiaGuide() {
    let ready = false;
    try {
        const { connection } = loadImageSettings();
        ready = Boolean(connection.key.trim()) || (connection.channel === 'custom' && Boolean(connection.url.trim()));
    }
    catch {
        ready = false;
    }
    return ready
        ? `<div class="tia-note" data-face="happy">
      <i class="tia-face" aria-hidden="true"></i>
      <div><p class="tia-say">画笔已经接上啦。点我身边的画匣选「AI生图」，我就替最新一楼挑画面。想让角色不走样，先去给她们锁定外貌吧。</p>
      <button type="button" class="tia-next" data-page="features">去标签锚定</button></div>
    </div>`
        : `<div class="tia-note" data-face="talk">
      <i class="tia-face" aria-hidden="true"></i>
      <div><p class="tia-say">画匣已经支好了。还差一支能落笔的画笔——先去接上生图服务吧？</p>
      <button type="button" class="tia-next" data-page="image-api">去接口配置</button></div>
    </div>`;
}
function guideView() {
    return `
    ${tiaGuide()}
    <section class="map" aria-label="插件功能系谱图，从上向下展示各板块">
      <div class="map-root"><div class="map-node"><strong>${pluginName}</strong><span>每一张图，都是一次小魔法</span></div></div>
      <div class="map-branches">
        <div class="map-branch">
          <button type="button" class="map-node" data-page="image-api">
            <strong>接口配置</strong><span>把画图和写词接口接上</span>
          </button>
          <div class="map-leaves">
            ${guideLeaf('imageConnection', pages['image-api'].title, pages['image-api'].description, ['imageConnection', 'imageParameters', 'artists'])}
            ${guideLeaf('modelConnection', pages['model-api'].title, pages['model-api'].description, ['modelConnection', 'presets', 'markers'])}
          </div>
        </div>
        <div class="map-branch">${node('features')}
          <div class="map-leaves">
            ${guideLeaf('round', '标签锚定', '锁定角色长相和衣柜', ['round', 'anchors', 'outfits'])}
            ${guideLeaf('worldbookUpload', '世界书', '导入并挑出要带的设定条目', ['worldbookUpload', 'worldbookMount'])}
            ${guideLeaf('currentImages', pages.review.title, pages.review.description, ['currentImages', 'allImages'])}
          </div>
        </div>
        <div class="map-branch">${node('preferences')}
          <div class="map-leaves">
            ${guideLeaf('habits', pages['image-workflow'].title, pages['image-workflow'].description, ['autoProcess', 'autoImages', 'concurrency', 'retention'])}
            ${guideLeaf('tia', '使用习惯', '调调桌宠缇娅和外观，或者看看更新记录', ['tia', 'updates'])}
            ${guideLeaf('exportConfig', '配置迁移与分享', '挑选需要的部分导出带走或分享', ['exportConfig', 'importConfig'])}
          </div>
        </div>
      </div>
    </section>
    <section class="guide-flow" aria-labelledby="guide-flow-heading">
      <h3 id="guide-flow-heading">从正文到配图</h3>
      <ol class="guide-steps">
        <li><span class="guide-step-number" aria-hidden="true">01</span><div><h4>接好接口，导入预设</h4><p>选一个你要用的画图服务（NAI、GPT、Gemini 或 Grok 都支持），把生图 API 和模型 API 配上，再导入对应的预设。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">02</span><div><h4>记下角色和世界设定</h4><p>需要固定人物长相或带入世界观的话，去标签锚定建档，或者上传世界书勾出要用的条目。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">03</span><div><h4>替最新正文写好画面位置</h4><p>点悬浮球菜单里的“AI生图”，让模型替最新一楼选好该画哪里；想省事的话，也可以在“出图与生图”打开“回复后自动写 Tag”，以后每楼写完自动处理。</p></div></li>
        <li><span class="guide-step-number" aria-hidden="true">04</span><div><h4>在楼层里画出插图</h4><p>点楼层里的“生成图片”，或者在“出图与生图”打开“新标记自动出图”让它自己开画。画好的图之后都能在“生图回顾”里翻看。</p></div></li>
      </ol>
    </section>
    <section class="guide-transfer" aria-labelledby="guide-transfer-heading">
      <div><h3 id="guide-transfer-heading">把配置带走，也分享喜欢的内容</h3><p>点下面可以只挑画师串、预设、世界书导出，或者整套配置打包带走。导出完整包时可以自己勾选带不带 API 密钥和地址；导入前会先亮出清单给你核对，点头确认才会覆写。</p></div>
      <button type="button" class="secondary" data-page="preferences" data-section="config-transfer">配置迁移与分享 →</button>
    </section>`;
}
function hostSyncView() {
    if (!isTauriHost())
        return '';
    if (!getHostStore())
        return '<p class="config-status">现在这个版本的 TT 还没给全扩展数据存储接口，配置还是先存在本机。把 TT 升到新版再打开画匣，就能自动迁过去。</p>';
    return `<section class="image-settings" aria-label="TauriTavern 配置同步">
    <header class="section-heading section-heading--plain"><h2 class="section-title">TauriTavern 同步</h2>
      <p class="section-description">配置已经接到 TT 的扩展数据里，同步时记得勾上“扩展数据”；上次停在哪页和悬浮球位置会跟酒馆自己的设置走。</p></header>
    <p class="config-status">这里包括接口参数、预设、画师串、角色外貌和衣柜、角色图，还有世界书和挂载勾选；以前生成的图片历史还是留在各自本机里。</p>
    <label class="preference-row"><span><strong>连着 API 密钥一起同步</strong><span>默认关着（换设备要自己补填密钥）；打开后，你存的生图和模型 API 密钥也会一起写进 TT 扩展数据同步出去。</span></span>
      <input type="checkbox" name="syncApiKeys" ${getSyncApiKeys() ? 'checked' : ''}></label>
    <p class="config-status" data-host-sync-status role="status">${getSyncApiKeys() ? 'API 密钥现在会跟着 TT 扩展数据一起同步。' : 'API 密钥眼下只留在这台设备上。'}</p>
  </section>`;
}
function imageWorkflowView(settings) {
    return `
    <section class="preference-section" aria-labelledby="image-habits-heading">
      <header class="section-heading section-heading--plain"><h3 id="image-habits-heading" class="section-title">自动配图</h3><p class="section-description">正文写完 → 模型写 Tag → 画匣出图，这两步可以分开开关。</p></header>
      <label class="preference-row"><span><strong>回复后自动写 Tag</strong><span>（以前叫“自动 AI 生图”）等新正文和酒馆助手手头的事情都跑完、页面稳住 3 秒后，自动调模型 API 按预设替这楼插好配图标记。只开这一项时不自动画图，等你自己点按钮再画；会消耗一次模型 API 额度。</span></span><input type="checkbox" name="autoProcessReplies" ${settings.autoProcessReplies ? 'checked' : ''}></label>
      <label class="preference-row"><span><strong>新标记自动出图</strong><span>（以前叫“自动点击生图”）盯着最新一楼刚冒出来的新配图标记，自动排队开画；和上一项一起开就是全自动配图。已经有图的会跳过，失败了不会自作主张重试；刚打开聊天或刚打开开关时也不会去补画旧楼层。会消耗生图额度。</span></span><input type="checkbox" name="autoGenerateImages" ${settings.autoGenerateImages ? 'checked' : ''}></label>
      <p class="config-status" data-workflow-status role="status">${workflowStatus(settings)}</p>
      <label class="preference-row"><span><strong>自动出图等待与间隔</strong><span>正文停稳后先等这么多秒再动手；一张张画时每画完一张也喘口气等这么久；并发时有空位也会隔这么久再补新单。填 0 就不等直接接上，默认 1 秒，最多 ${MAX_AUTO_IMAGE_DELAY} 秒。</span></span>
        <span class="preference-number"><input type="number" name="autoImageDelay" min="0" max="${MAX_AUTO_IMAGE_DELAY}" step="0.1" inputmode="decimal" value="${settings.autoImageDelay}" aria-label="自动出图等待与间隔（秒）">秒</span></label>
    </section>
    <section class="preference-section" aria-labelledby="image-queue-heading">
      <header class="section-heading section-heading--plain"><h3 id="image-queue-heading" class="section-title">并发与队列</h3><p class="section-description">楼里配图、重画、设置页试绘还有画角色图都在同一条队伍里排队，谁先点就谁先画。</p></header>
      <label class="preference-row"><span><strong>最大同时生图数</strong><span>默认一次 1 张，最多调到 ${MAX_IMAGE_CONCURRENCY} 张。往低调时，正在画的不会中途掐断，等后面的新任务按新上限走；模型写 Tag 每次还是只处理一条回复。照着你用的生图接口能承受的并发来调就好。</span></span>
        <select name="imageConcurrency" aria-label="最大同时生图数">${Array.from({ length: MAX_IMAGE_CONCURRENCY }, (_, i) => i + 1).map(value => `<option value="${value}"${settings.imageConcurrency === value ? ' selected' : ''}>${value} 张</option>`).join('')}</select></label>
      <p class="config-status" data-image-queue-status role="status"></p>
    </section>
    <section class="preference-section" aria-labelledby="image-retention-heading">
      <header class="section-heading section-heading--plain"><h3 id="image-retention-heading" class="section-title">图片留存</h3><p class="section-description">管一管这台设备上越积越多的本地出图历史。</p></header>
      <label class="preference-row"><span><strong>自动清理生图</strong><span>按出图时间把所有角色卡下的本地旧图清掉，不过锚定页里的角色图会一直留着。一选天数就会立刻清一次，酒馆关着那会儿过期的图，下次打开时会接着清掉。</span></span>
        <select name="imageRetentionDays" aria-label="图片保留时间">${[[0, '关闭'], [1, '保留 1 天'], [3, '保留 3 天'], [7, '保留 7 天']].map(([value, label]) => `<option value="${value}"${settings.imageRetentionDays === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <p class="config-status" data-cleanup-status role="status"></p>
      <button type="button" class="secondary" data-page="review">打开生图回顾 →</button>
    </section>
    <div class="actions"><button type="button" class="secondary" data-action="reset-image-workflow">恢复默认生图设置</button><p class="muted" role="status" data-feedback>改完就会自动存好。</p></div>`;
}
export function workflowStatus(settings) {
    if (settings.autoProcessReplies && settings.autoGenerateImages)
        return '现在这套流程：正文写完 → 模型写 Tag → 直接自动画图。';
    if (settings.autoProcessReplies)
        return '现在这套流程：正文写完 → 模型写 Tag → 等你手动点生成。';
    if (settings.autoGenerateImages)
        return '现在这套流程：楼里一出现新配图标记 → 直接自动画图。';
    return '自动配图关着呢，想画哪一楼就从缇娅菜单里手点“AI生图”或“指定插图”。';
}
function preferencesView(settings) {
    return `
    <section class="preference-section" aria-labelledby="pet-heading">
      <header class="section-heading section-heading--plain"><div class="pet-heading-line"><h3 id="pet-heading" class="section-title">桌宠缇娅</h3><small class="pet-credit">由 <strong>Lovéthia</strong> 宝宝制作，无比感谢！</small></div><p class="section-description">调一调缇娅的个头大小、台词和动作；调大小时小人和画匣会一起缩放。</p></header>
      <div class="preference-row pet-size-row">
        <span><label for="pet-scale"><strong>缇娅的大小</strong></label><span id="pet-scale-description">50%～150% 随便拉，松手就生效并自动存好。画匣会跟着一起缩放，菜单和台词字号不变。</span></span>
        <div class="pet-size-controls">
          <input id="pet-scale" name="petScale" type="range" min="50" max="150" step="1" value="${Math.round(settings.petScale * 100)}" aria-describedby="pet-scale-description" aria-valuetext="${Math.round(settings.petScale * 100)}%">
          <output for="pet-scale" data-pet-scale-value>${Math.round(settings.petScale * 100)}%</output>
          <button type="button" class="secondary" data-action="reset-pet-scale">恢复默认</button>
        </div>
      </div>
      <label class="preference-row"><span><strong>缇娅的台词</strong><span>平时只在动手操作或画完出结果时搭话，同一句不会连着刷屏。关掉后她就安静干活，真出错了还是会冒出报错提示。</span></span><input type="checkbox" name="petLines" ${settings.petLines ? 'checked' : ''}></label>
      <label class="preference-row"><span><strong>缇娅的动作</strong><span>关掉之后她就只留着呼吸和眨眼，不再满屏幕溜达、晃悠，也没有图片飞进楼层的动画了（如果系统开了减少动态效果也会跟着关掉）。</span></span><input type="checkbox" name="petMotion" ${settings.petMotion ? 'checked' : ''}></label>
    </section>
    <label class="preference-row">
      <span><strong>画匣色调</strong><span>夜间会换成胡桃木色的暗纸页；选“跟随酒馆”就跟着酒馆主题的明暗自动换。</span></span>
      <select name="paintboxTheme" aria-label="画匣色调">${[['auto', '跟随酒馆'], ['day', '日间'], ['night', '夜间']].map(([value, label]) => `<option value="${value}"${settings.paintboxTheme === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
    </label>
    <label class="preference-row">
      <span><strong>回到上次页面</strong><span>下次打开画匣接着上次那一页继续看；关掉的话每次都回到“开始使用”。</span></span>
      <input type="checkbox" name="rememberPage" ${settings.rememberPage ? 'checked' : ''}>
    </label>
    <label class="preference-row">
      <span><strong>记住悬浮球位置</strong><span>你把它拖到屏幕哪个角落，下次进酒馆还待在那里。</span></span>
      <input type="checkbox" name="rememberPosition" ${settings.rememberPosition ? 'checked' : ''}>
    </label>
    <div class="actions">
      <button type="button" class="secondary" data-action="reset-preferences">恢复默认使用偏好</button>
      <p class="muted" role="status" data-feedback>改完就会自动存好。</p>
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
      <p class="section-description">${tab === 'anchors' ? '把角色固定长相存下来，随剧情换不同的衣服。' : '传几本世界书进来，把要用的设定条目挂进生图预设。'}</p>
    </header>
    ${tab === 'anchors'
        ? '<div data-anchor-settings></div><details class="feature-provider-settings"><summary>预设功能接入</summary><div data-model-settings></div></details>'
        : '<div data-model-settings></div>'}
  </div>`;
}
export function pageView(page, settings, featureTab = 'anchors') {
    const heading = `<header class="page-heading">
    <p class="eyebrow">${page === 'guide' ? '从这里开始' : page === 'image-workflow' ? '使用偏好 / 出图与生图' : pluginName}</p>
    <h2>${pages[page].title}</h2><p>${pages[page].description}</p>
  </header>`;
    switch (page) {
        case 'guide': return heading + guideView();
        case 'image-api': return '<div data-image-settings></div>';
        case 'model-api': return '<div data-model-settings></div>';
        case 'features': return featureView(featureTab);
        case 'image-workflow': return heading + imageWorkflowView(settings);
        case 'review': return heading + '<div data-image-review></div>';
        case 'preferences': return heading + preferencesView(settings);
    }
}
