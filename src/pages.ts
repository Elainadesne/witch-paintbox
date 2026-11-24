export const pluginName = '魔女画匣';

export const pages = {
  guide: { title: '开始使用', description: '先看一眼画匣怎么用，各个入口都在哪。', group: 'guide' },
  'image-api': { title: '生图 API', description: '接上你的画图接口、画幅参数和画师串。', group: 'connections' },
  'model-api': { title: '模型 API', description: '负责看懂剧情、写好场景词并插进楼层，再交给生图 API 来画。', group: 'connections' },
  features: { title: '插件功能', description: '把角色长相、衣柜和世界书一起带进配图里。', group: 'features' },
  'image-workflow': { title: '出图与生图', description: '定好自动出图的时机、一次并发几张，以及本机留几天图。', group: 'preferences' },
  review: { title: '生图回顾', description: '翻一翻这台设备上存下来的画。', group: 'review' },
  preferences: { title: '使用偏好', description: '调顺手使用习惯，或者把配置打包带走、分享给别人。', group: 'preferences' },
} as const;

export type PageId = keyof typeof pages;

export interface NavigationItem {
  group: string;
  page: PageId;
  title: string;
  children?: readonly NavigationItem[];
}

export const navigation = [
  { group: 'guide', page: 'guide', title: '开始使用' },
  { group: 'connections', page: 'image-api', title: '接口配置' },
  { group: 'features', page: 'features', title: '插件功能' },
  { group: 'review', page: 'review', title: '生图回顾' },
  { group: 'preferences', page: 'preferences', title: '使用偏好', children: [
    { group: 'preferences', page: 'image-workflow', title: '出图与生图' },
  ] },
] as const satisfies readonly NavigationItem[];

export function isPageId(value: unknown): value is PageId {
  return typeof value === 'string' && Object.hasOwn(pages, value);
}
