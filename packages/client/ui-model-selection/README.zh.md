---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

Web GUI 允许用户通过 `/model` 弹窗或 composer 模型控件切换既有会话使用的模型与推理（reasoning）强度。可搜索的双栏对话框会一起应用模型与推理强度；双击则只应用一项并关闭对话框。两个界面呈现同一组按提供方分组的选择；所选模型决定可用的推理强度名称与默认值。完整选择从下一次请求开始生效；运行中的步骤保留其启动时的模型与推理强度。所选模型不可用时，composer 保持停用，直到用户选择可用模型或同一模型恢复可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

DeepSeek 账号和 API Key 路由显示为独立提供方分组，各自展示相同的已配置模型目录。

未选模型文案与可用模型名使用相同的常规字重，并在既有会话与新会话中保留已保存的推理强度显示；调整推理强度需要先选择可用模型。点击未选模型控件直接打开模型列表，Escape 关闭列表。

与 `ui-conversation` 及命令包一起挂载本插件；composer 随即在待处理指示器旁显示模型位，`/model` 则以弹窗打开同一份目录。点击 composer 模型位会打开可搜索的双栏对话框，左侧按提供方分组显示模型，右侧显示所选模型的推理强度。选择模型会暂存其默认推理强度；随后选择推理强度会应用这一组合并关闭对话框。双击模型或推理强度会单独应用该项并关闭对话框。所选模型可用时，composer 显示目录中的模型名称；模型或提供方被删除时（包括账号退登），改为显示已保存的 `provider/model` ID。保存的提供方、模型和推理强度均保持不变。

对话框打开后先聚焦搜索框，将 Tab 导航限制在对话框内，可通过 Escape 或点击遮罩关闭，并把焦点还给 composer 模型位。等待任一入口发起的选择结果时，触发器以加载图标代替下拉箭头，匹配的对话框行以加载图标代替勾选标记。选择被拒绝后对话框保持打开，并通过锚定 composer 的 toast 提示失败。

### 模型与推理强度

模型按提供方分组，DeepSeek 账号排第一，DeepSeek 排第二，第三方提供方保持目录原有顺序。搜索在每个提供方分组内对模型名称的不区分大小写有序子序列匹配排序，同时保留提供方名称与标识符、模型标识符及说明的子字符串匹配。`/model` 弹窗显示提供方名称与目录说明；其中两个内置 DeepSeek 模型的说明使用当前语言，外部提供方说明保持原文。选择模型会应用其默认推理强度，对话框会列出所选模型公布的全部推理强度。适配器没有推理元数据时会显示不可用说明，而不是提供任意输入。

展开的控件无法排在同一行时，composer 将模型与推理强度文字替换为模型图标；空间足够后恢复文字。触发器的无障碍名称、提示和菜单仍提供完整选择。

### 不可路由的会话

目录可用性不会阻止使用已保存选择发送消息；请求执行负责报告凭据缺失或模型不可用。刷新及刷新失败期间保留上次显示的选择和分组。Host 重置时清空这些显示。退登后选择器隐藏账号提供方，同时保留已保存的提供方／模型 ID 和推理强度。再次登录且该模型可用时恢复目录名称。既有会话日志保持不变。

### 选择失败

当会话被其他写句柄占用时，模型选择失败提示用户退出其他正在运行的 DSH 后重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

选择器采用共享 `Modal` 与 `Input` 原语，包括焦点归属、Escape 处理、向 body 的 portal 挂载和标准平台材质。

<details>
<summary>实现细节——点击展开</summary>

composer 的 `ModelSelect` 与 `/model` 选项构建器共用[提供方排序](src/client/provider-order.ts)，两个搜索框均在每个提供方内使用 `rankByName`。命令通过 [popupSelect API](../ui-commands/README.zh.md#use-this-package) 提供可选分组与 `searchMode: 'fuzzy-label'`；两个入口均使用 `MenuGroup`，并在渲染分组变化时重建其吸顶观察器。命令弹窗撑满 composer 浮层，按钮则保留紧凑菜单。

两个入口共用一份由 `ModelDirectoryResolver`（`ctx.modelDirectories`）持有的会话级目录：`/model` popupSelect 贡献项（经 `ctx.commandUi` 注册）与 composer 的具名 `conversation.input.model` 位都经 `session.models` 加载会话的可用目录、经 `session.selectModel` 通过同一个 `ModelDirectory` 实例提交，因此任一入口所做的切换正是另一个入口接下来显示的。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果。目录把最近一次提交的选择发布为 `pending`，直到它完成或被连接重置作废；连接重置丢弃所有常驻投影，并在显示前重新拉取 Host 恢复的选择。目录按会话惰性解析，随会话作用域一并 dispose（资源释放）；已寻址 subagent 会话不公开任一入口。每份常驻目录都会直接在转发的 `llm/adapters-updated`、`settings/document-updated` 与凭据更新事件上重拉。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当仅了解模型界面还不够时，请阅读以下页面。这些页面从浏览器界面逐步深入到命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

两个入口提交的 `session.selectModel` 选择会间接影响模型：Host 会在下一次提示词组装边界为完整的 `ModelSelection` 创建快照，并负责使其对模型生效；运行中的步骤则保留已组装的选择。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前模型选择界面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent（智能体）；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——composer 仅提供确切模型由适配器公布的推理强度；适配器没有推理元数据时不显示 Effort 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
