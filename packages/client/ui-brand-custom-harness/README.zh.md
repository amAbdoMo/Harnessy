---
description: "Harnessy 浏览器身份、主题 token、About 行与 provider 账户管理器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

[English](README.md) | 中文

## 概述

本包填充通用侧栏与会话首屏品牌 slot，在新会话标题下方添加简短的本地化说明，应用可逆的明暗配色与字体层，在通用设置中添加共享技能控制和本地化 About 行，向 Models footer 贡献 Harnessy 账户管理器，并提供 MCP Servers 设置页面。它只在浏览器以 `custom-harness` 客户端 profile 构建时激活，因此共享 Web 组合在其他构建中仍可保留原有身份。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

通过 [`dsh-custom-harness`](../../bundle/custom-harness/README.zh.md) 组合本包，并运行 `pnpm run build:custom-harness` 构建仓库。产品名称、项目链接与支持链接来自集中管理的构建环境；缺少值时会明确失败，避免混合身份。

提供的透明 Harnessy 标志会在海洋渐变底框上适配宿主控制的图标尺寸。深海军蓝、青色与亮青色配色通过现有语义 token 同时作用于明暗模式，并保留标准的成功、警告与错误语义。About 行显示构建版本和项目入口，不保留运行时状态。

共享技能文件夹行绑定 `harnessy-shared-skills` 设置命名空间，显示已解析的绝对目录，并通过标准设置与原生目录选择器 service 路由启用、选择文件夹和重置操作。它只拥有展示；文件系统 skill provider 拥有发现、监视、优先级和 provider 替换。

侧边栏底部显示当前 Codex 身份、大写方案名称以及紧凑的 `5h` 与 `7d` 用量条，而不是直接打开 Settings。Harnessy 会在启动时刷新这些用量条；填充从零开始动画，在接近耗尽时使用警示颜色，并尊重 reduced-motion 偏好。选择底部区域会打开一个紧凑菜单，其中包含相同的账户摘要与 Settings 操作。账户操作会在 Settings 面板保持隐藏时打开 Codex、GLM、Kimi、OpenCode 与 Claude Code 的独占 provider 管理器；关闭对话框会同时关闭两个视图。provider rail 会以紧凑 badge 显示每个非零的已保存账户总数。manager 会导入 Harnessy 中已激活的账户，支持额外 browser 或 API-key 账户，并通过注入的 Host callback 切换 canonical provider 身份。每次打开对话框都会请求最新 Codex 用量快照。没有受支持用量数据的 provider 会显示明确 unavailable 状态。界面直接显示 Remote 拒绝消息，不会检查凭据内容。

MCP Servers 区域为每个已保存服务器显示紧凑状态轨道，包括连接状态、endpoint、transport、是否已保存认证以及已发现工具名称。单一 staged editor 支持远程 HTTPS 与本地 stdio profile。保存后的 secret 不会重新渲染到表单；secret 字段留空会保留受保护值，显式控制可清除它。测试、启用、编辑与移除操作只通过注入的 Host callback 执行，页面打开期间会刷新状态。

<a id="model-experience"></a>
## 模型体验

无，因为本包不构造提示词或模型请求；账户激活只会要求 Host 启用 provider route，而 MCP 页面只会要求 Host 通过普通工具注册表注册已发现工具。

#### KV Cache 影响

无直接影响；所选 provider 与 model 负责组装请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **受构建 profile 门控**——切换身份需要重新构建浏览器，而不是修改运行时设置。
- **产品浏览器范围**——可执行文件和安装程序资源由[桌面应用](../../../apps/desktop/README.zh.md)负责；本包负责它们所显示的 renderer 身份和产品设置控件。
- **状态轮询**——MCP Settings 页面挂载期间每三秒刷新一次状态；它不是推送通知流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 每个可见值都来自命名产品构建，释放时会移除全部 slot 填充与 token 覆盖。

不发布运行时不变式 companion；跨事件 slot 与主题关系由宿主注册表拥有，本展示适配器不保留持久状态。
