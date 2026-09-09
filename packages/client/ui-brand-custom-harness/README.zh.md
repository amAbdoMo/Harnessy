---
description: "面向独立产品 profile 用户与维护者的 Custom Harness 浏览器身份、主题 token 和 About 行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

[English](README.md) | 中文

## 概述

本包填充通用侧栏与会话首屏品牌 slot，在新会话标题下方添加简短的本地化说明，应用可逆的明暗配色与字体层，并在通用设置中添加本地化 About 行。它只在浏览器以 `custom-harness` 客户端 profile 构建时激活，因此共享 Web 组合在其他构建中仍可保留原有身份。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

通过 [`dsh-custom-harness`](../../bundle/custom-harness/README.zh.md) 组合本包，并运行 `pnpm run build:custom-harness` 构建仓库。产品名称、项目链接与支持链接来自集中管理的构建环境；缺少值时会明确失败，避免混合身份。

标志采用可缩放的矢量“穿线光圈”造型，可适配宿主决定的图标尺寸，并跟随明暗产品 token。冷紫色调通过现有语义 token 传递，同时保留共享的蓝色发送操作以及成功、警告和错误语义。About 行显示构建版本和项目入口，不保留运行时状态。

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器呈现包不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **受构建 profile 门控**——切换身份需要重新构建浏览器，而不是修改运行时设置。
- **仅浏览器呈现**——可执行文件和安装程序资源由[桌面应用](../../../apps/desktop/README.zh.md)负责；本包负责它们所显示的 renderer 身份。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 每个可见值都来自命名产品构建，释放时会移除全部 slot 填充与 token 覆盖。

不发布运行时不变式 companion；跨事件 slot 与主题关系由宿主注册表拥有，本展示适配器不保留持久状态。
