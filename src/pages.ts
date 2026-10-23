export const pluginName = '魔女画匣';

export const pages = {
  guide: { title: '开始使用', description: '认识插件，找到你需要的入口。', group: 'guide' },
  'image-api': { title: '生图 API', description: '管理用于生成图片的服务连接。', group: 'connections' },
  'model-api': { title: '模型 API', description: '连接 AI、导入预设与编排条目。', group: 'connections' },
  features: { title: '插件功能', description: '让角色与世界资料参与配图。', group: 'features' },
  preferences: { title: '使用偏好', description: '调整使用习惯，迁移或分享配置。', group: 'preferences' },
} as const;

export type PageId = keyof typeof pages;

export const navigation = [
  { group: 'guide', page: 'guide', title: '开始使用' },
  { group: 'connections', page: 'image-api', title: '接口配置' },
  { group: 'features', page: 'features', title: '插件功能' },
  { group: 'preferences', page: 'preferences', title: '使用偏好' },
] as const;

export function isPageId(value: unknown): value is PageId {
  return typeof value === 'string' && Object.hasOwn(pages, value);
}
