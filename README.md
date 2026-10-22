# 魔女画匣

每次生图，都是魔女看板娘施展的一次绘图魔法。

独立的 SillyTavern 前端扩展。当前提供可拖动悬浮球、四个主板块、从上向下展开的金字塔系谱图，以及使用偏好的保存。

生图 API、模型 API 和插件功能目前为页面入口，尚未接入服务或生成请求。

看板娘的姓名、性格、外观与具体施法表现待讨论确定。本版尚未加入立绘或动画。

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
style.css           隔离在 Shadow DOM 内的样式
dist/               TypeScript 编译产物，随 Git 发布
```

新增功能时，在 `src/pages.ts` 登记页面，在 `src/views.ts` 添加页面内容与对应系谱图入口。配置接入逻辑待服务协议确定后添加。

## Git 发布与安装

将**本目录内容**作为独立仓库的根目录，确保 `manifest.json` 位于仓库根。每次修改 TypeScript 后执行构建，并一同提交 `dist/` 和 `style.css`；用户安装时不需要编译。

仓库发布后，用户在酒馆“扩展 → 安装扩展”中填写该 Git 仓库地址，然后刷新页面，通过右下角“绘”悬浮球进入。

此目录不依赖角色卡工程、MVU 或酒馆助手。

参考：[SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。
