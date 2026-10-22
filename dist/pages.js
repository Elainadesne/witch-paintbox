export const pluginName = '莉露的画匣';
export const pages = {
    guide: { title: '开始使用', description: '认识插件，找到你需要的入口。', group: 'guide' },
    'image-api': { title: '生图 API', description: '管理用于生成图片的服务连接。', group: 'connections' },
    'model-api': { title: '模型 API', description: '为需要模型能力的功能配置服务。', group: 'connections' },
    features: { title: '插件功能', description: '从这里进入插件提供的各项功能。', group: 'features' },
    preferences: { title: '使用偏好', description: '让插件按照你的习惯打开和显示。', group: 'preferences' },
};
export const navigation = [
    { group: 'guide', page: 'guide', title: '开始使用' },
    { group: 'connections', page: 'image-api', title: '接口配置' },
    { group: 'features', page: 'features', title: '插件功能' },
    { group: 'preferences', page: 'preferences', title: '使用偏好' },
];
export function isPageId(value) {
    return typeof value === 'string' && Object.hasOwn(pages, value);
}
