// Release dates use Asia/Shanghai. Historical entries follow the local repository log.
const updates = [
    {
        date: '2026-10-24', title: '本次更新',
        changes: [
            '角色别名：多个称呼可指向同一角色，共用固定外貌与当前服装。',
            '使用偏好：新增更新历史，按日期查看功能变化。',
        ],
    },
    {
        date: '2026-10-23', title: '世界资料与图片管理',
        changes: [
            '世界书：支持上传 JSON、多书挂载和条目查看；蓝灯常驻，绿灯按本次正文的关键词激活。',
            '预设与分享：调整条目发送顺序，按全部配置、画师串、预设或世界书导出；导入前先预览确认。',
            '标签锚定与画框：保存角色外貌、独立服装库与生成的角色图；画框支持折叠，图片历史保存在浏览器，可全屏查看、下载与删除。',
            '正文配图：AI 按行间位置插入配图，支持多组标记；生图请求依次排队，改善图片显示。',
        ],
    },
    {
        date: '2026-10-22', title: '画匣初版',
        changes: [
            '加入可拖动悬浮球与引导页面，配置 NAI 生图和模型 API，支持画师串、预设导入及常用图片尺寸。',
        ],
    },
];
export function updateHistoryView() {
    return `<section class="image-settings update-history" aria-labelledby="update-history-heading">
    <header class="section-heading"><span class="section-index" aria-hidden="true">03</span>
      <h2 class="section-title" id="update-history-heading">更新历史</h2>
      <p class="section-description">看看画匣最近添了哪些功能。点击日期可展开或收起。</p></header>
    ${updates.map((update, index) => `<details class="update-history-group"${index === 0 ? ' open' : ''}>
      <summary><time datetime="${update.date}">${update.date}</time><span class="update-history-label">${update.title}</span></summary>
      <ul class="update-history-list">${update.changes.map(change => `<li>${change}</li>`).join('')}</ul>
    </details>`).join('')}
  </section>`;
}
