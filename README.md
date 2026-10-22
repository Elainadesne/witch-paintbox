# 魔女画匣

每次生图，都是魔女看板娘施展的一次绘图魔法。

独立的 SillyTavern 前端扩展，提供可拖动悬浮球、四个主板块、从上向下展开的金字塔系谱图，以及使用偏好的保存。

生图 API 已接入 NovelAI，配置页采用下划线与留白分区；生图 API / 模型 API 在窗口右上角切换。模型 API 与插件功能尚待实现。

看板娘的姓名、性格、外观与具体施法表现待讨论确定。本版尚未加入立绘或动画。

## 生图配置

- **密钥配置**：选择官方或自定义渠道，在“配置”收纳盒中选择或命名连接，填写密钥后保存。保存后下划线连成粗线，保存按钮变灰；重新打开时密钥仍保留，默认隐藏，可点击“显示”查看。
- **生图配置**：选择 NAI V5、V4.5、V4 或 V3，以及尺寸、步数、引导强度、采样器、种子、噪声调度、CFG Rescale 和 SMEA。界面会禁用所选模型不支持的选项；种子 `-1` 表示随机。
- **画师工坊**：填写正面、负面提示词，保存为命名配置，支持切换、更新和删除。提示词原样发送，不自动补充质量词或负面词。
- **生成图片**：点击底部生成区，完成后可预览并保存图片。每次点击只发起一次请求，失败不自动重试；“取消等待”会停止本地请求，服务端任务可能仍在进行。

密钥、连接配置、参数和提示词保存在当前酒馆站点的浏览器 `localStorage`，不随 Git 发布，也不跨浏览器或设备同步。密钥隐藏仅控制显示；浏览器存储中保存的是原值。清除站点数据会移除这些配置，专门的清除入口留待使用偏好设计。

自定义渠道需兼容 NovelAI 生图协议并允许浏览器跨域访问。仅填写域名时自动使用 `/ai/generate-image`；含路径的 URL 按完整接口地址使用。浏览器需支持 `DecompressionStream('deflate-raw')`，用于解压接口返回的 PNG 压缩包。

## 开发

```sh
npm install
npm run build
```

只有 TypeScript 编译依赖，没有额外运行时依赖。扩展使用酒馆提供的 jQuery 初始化和 `SillyTavern.getContext()` 保存偏好。

```text
manifest.json       酒馆扩展安装清单
src/index.ts        挂载、导航、窗口生命周期
src/launcher.ts     悬浮球拖动与边界处理
src/pages.ts        页面定义及导航分组
src/views.ts        四个板块及系谱图
src/settings.ts     偏好结构与宿主存储
src/image-config.ts 生图配置交互与生成流程
src/image-view.ts   无边框配置页模板
src/image-settings.ts 浏览器本地配置存储
src/novelai.ts      NAI 模型、参数和请求
src/image-response.ts PNG / ZIP 响应读取
style.css           隔离在 Shadow DOM 内的样式
dist/               TypeScript 编译产物，随 Git 发布
```

新增功能时，在 `src/pages.ts` 登记页面，在 `src/views.ts` 添加页面内容与对应系谱图入口。

## Git 发布与安装

将**本目录内容**作为独立仓库的根目录，确保 `manifest.json` 位于仓库根。每次修改 TypeScript 后执行构建，并一同提交 `dist/` 和 `style.css`；用户安装时不需要编译。

仓库发布后，用户在酒馆“扩展 → 安装扩展”中填写该 Git 仓库地址，然后刷新页面，通过右下角“绘”悬浮球进入。

此目录不依赖角色卡工程、MVU 或酒馆助手。

参考：[SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)、[NovelAI 模型说明](https://docs.novelai.net/en/image/models/)、[NovelAI 生图接口](https://image.novelai.net/docs/doc.json)。
