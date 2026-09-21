---
description: "Harnessy 浏览器身份、主题 token、About 行与 provider 账户管理器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

[English](README.md) | 中文

## 概述

本包填充通用侧栏与会话首屏品牌 slot，在新会话标题下方添加简短的本地化说明，应用可逆的明暗配色与字体层，在通用设置中添加新会话工作区、共享技能和 About 控件，向 Models footer 贡献 Harnessy 账户管理器，并提供 MCP Servers 设置页面。它只在浏览器以 `custom-harness` 客户端 profile 构建时激活，因此共享 Web 组合在其他构建中仍可保留原有身份。

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

新会话工作区行提供远程网站与 Harnessy 默认两种模式。远程网站会要求选择父文件夹，并以原子操作启用 Host 设置；之后每条未分组 Session 都会在其中获得独立子文件夹，而已保存项目始终使用自身路径。所选文件夹只保存本地临时文件和生成文件。MCP 服务器及其远程目标继续单独配置。

侧边栏底部显示当前 Codex 身份、大写方案名称以及紧凑的 `5h` 与 `7d` 用量条，而不是直接打开 Settings。Harnessy 会在启动时、窗口可见期间每分钟以及窗口回到前台时刷新这些用量条；自动触发会共享一个进行中的 refresh。填充会直接跳到最新值，在 80% 时变为黄色，在 95% 时变为红色，并尊重 reduced-motion 偏好。选择底部区域会打开一个紧凑菜单，其中包含相同的账户摘要与 Settings 操作。账户操作会在 Settings 面板保持隐藏时打开 Codex、GLM、Kimi、OpenCode 与 Claude Code 的独占 provider 管理器；关闭对话框会同时关闭两个视图。provider rail 会以紧凑 badge 显示每个非零的已保存用户总数。manager 会导入 Harnessy 中已激活的账户，支持额外 browser 或 API-key 账户，并通过注入的 Host callback 切换 canonical provider 身份。同一 ChatGPT 用户的 Codex membership 共用一张卡片；仅当 Personal 与 Workspace 两个用量上下文均已保存时才显示切换控件，所选上下文同时决定显示的额度和 Switch 的目标。membership id 同时包含 ChatGPT 用户与 workspace id，因此登录到同一 workspace 的两个用户仍是两个独立账户。可选的自动切换控件会在最新用量检查发现当前任一标准窗口达到 95% 后提升另一个符合条件的 Codex membership；额度拒绝会触发一次恢复刷新，并且仅在确实切换成功后重试，互不相关的 Business workspace 绝不会混用。Host 会在每个 Codex 模型请求绑定凭据前重复主动检查。Workspaces 搜索操作旁的铃铛会保留自动账户切换、已记录的根 Session 结果（`completed`、`stopped` 或 `failed`）、访问批准请求、问题请求和计划审核请求。同一次运行存在待处理人工操作时，会抑制重复的终止消息。子代理完成状态保留在子代理面板中，不再制造通知噪音；子代理需要用户操作时仍可通知。新活动始终触发应用内 toast；失败、停止与需要操作的事件会立即请求原生 Desktop 通知，而成功完成只在应用不处于前台时请求原生通知。只要存在未读活动，铃铛就显示一个不带数字的圆点；打开菜单会把历史标为已读，“清除历史记录”会删除保留的条目。启动后的第一个实时 snapshot 会作为静默基线，因此重新加载后不会把已有待处理工作再次报告为新活动。每次打开账户对话框都会请求最新 Codex 用量快照。没有受支持用量数据的 provider 会显示明确 unavailable 状态。界面直接显示 Remote 拒绝消息，不会检查凭据内容。

MCP Servers 区域为每个已保存服务器显示紧凑卡片，整张卡片以较暖的成功、等待或错误边框表达状态，并列出连接状态、endpoint、transport、是否已保存认证以及已发现工具名称。其页头操作只打开专用 MCP JSON 文档，而全局设置文档操作在本页隐藏。单一 staged editor 支持远程 HTTPS 与本地 stdio profile。本地编辑器可以填入可编辑的 WordPress MCP Adapter 模板，其中包含当前 endpoint 格式、命令、参数与受保护环境变量名；成对文本框保持等高，占位文字使用易读的次要文本色，连接失败则使用高对比度警告。JSON 导入接受常见的 `mcp`、`mcpServers` 与 `servers` 根节点或直接服务器映射，包括本地命令数组、命令加参数记录和远程 HTTP endpoint。保存前会显示脱敏预览、派生唯一工具命名空间、保留启用状态，并明确报告不受支持的 SSE transport、额外 header、逐服务器 timeout 与格式错误条目，而不会静默改变它们。导入的环境变量、授权 header、URL、命令与参数只保留在暂存导入记录中，不会显示在预览里。保存后的 secret 不会重新渲染到表单；secret 字段留空会保留受保护值，显式控制可清除它。测试、启用、编辑、导入与移除操作只通过注入的 Host callback 执行。每个 Session 页头都有一个带文字的紧凑 MCP 操作，即使尚未配置服务器也保持可见；其圆点按全局连接状态着色，显示实时调用数，把当前活动和失败服务器排在前面，并把服务器状态与从该 Session 最新投影派生的最多 100 条无 secret 工具调用记录组合展示。失败行可重新连接或定位到对应对话事件。最终连接失败及后续恢复会进入通知中心与原生 Desktop 通知；成功调用只保留在 MCP 活动列表中，不产生通知噪音。应用打开期间会共用一次三秒刷新，窗口回到前台时立即刷新。

<a id="model-experience"></a>
## 模型体验

无，因为本包不构造提示词或模型请求；账户激活只会要求 Host 启用 provider route，而 MCP 页面只会要求 Host 通过普通工具注册表注册已发现工具。

#### KV Cache 影响

无直接影响；所选 provider 与 model 负责组装请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **受构建 profile 门控**——切换身份需要重新构建浏览器，而不是修改运行时设置。
- **产品浏览器范围**——可执行文件和安装程序资源由[桌面应用](../../../apps/desktop/README.zh.md)负责；本包负责它们所显示的 renderer 身份和产品设置控件。
- **状态轮询**——renderer 活跃期间每三秒刷新 MCP 状态，并在窗口回到前台时刷新一次；它不是推送事件流。
- **MCP 顺序导入**——已接受的 profile 按预览顺序保存。若 Host 拒绝后续 profile，先前 profile 会保留，页面会报告导入停止的位置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 每个可见值都来自命名产品构建，释放时会移除全部 slot 填充与 token 覆盖。

不发布运行时不变式 companion；跨事件 slot 与主题关系由宿主注册表拥有，本展示适配器不保留持久状态。
