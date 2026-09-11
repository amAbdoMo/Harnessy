---
description: "Harnessy 浏览器操作与持久 Markdown 卡片，用于创建、重试和查看所选工作区的有界 Workspace Brief。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-brief

[English](README.md) | 中文

## 概述

本包在已打开会话的标题栏中添加“Create workspace brief”操作，并为生成的 `/workspace-brief` 命令生命周期提供专用卡片。该操作显示加载、成功和可处理的失败状态，防止重复的进行中请求，并允许显式重试。卡片渲染宿主命令持久化的 Markdown，因此重新加载和重连会使用已记录数据，而不会再次运行仓库检查。浏览器绝不直接读取工作区文件。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Harnessy bundle 将此浏览器插件与宿主 Workspace Brief 命令一并挂载。打开一个关联到工作区的会话，然后在会话标题栏选择“Create workspace brief”；会话打开前该按钮保持禁用。

该操作发送准确的无参数 `/workspace-brief` 命令。如需包含 Git 状态，请通过普通命令输入键入 `/workspace-brief --git`。传输与命令失败显示在操作旁边并保持可重试；持久命令卡片会独立显示已记录的运行中、成功或失败状态。

### 最小组合

在 locale、Remote、chat、conversation、renderer 和 session UI 包之后，把此行挂载到客户端组合。Harnessy bundle 会提供该依赖图。

```yaml
- id: ui-workspace-brief
  name: '@deepseek-ai/dsh-client-ui-workspace-brief'
```

本包不接受配置字段。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部机制——点击展开</summary>

插件贡献一个有序的 `conversation.session.header.actions` 条目，以及一个以 `workspace-brief` 为键的 `conversation.chat.commandview` 条目。操作对每次接受的点击调用一次 `ctx.remote.commands.execute`；宿主命令拥有验证、观察、取消与持久事件。两个 slot 注册和 locale 字典均由 effect 拥有，并随插件 fiber 一起消失。

| 文件 | 职责 |
|---|---|
| [`src/client/WorkspaceBriefAction.tsx`](src/client/WorkspaceBriefAction.tsx) | 打开会话门控、进行中去重、瞬时状态与显式重试 |
| [`src/client/WorkspaceBriefCard.tsx`](src/client/WorkspaceBriefCard.tsx) | 持久的加载、Markdown 成功与错误渲染 |
| [`src/client/index.ts`](src/client/index.ts) | Locales、Remote 适配器与 effect 所拥有的 slot 注册 |
| [`tests/browser-plugin.client.spec.tsx`](tests/browser-plugin.client.spec.tsx) | 组件、分派、失败、禁用与重新加载覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Brief 宿主命令](../../workspace/workspace-brief/README.zh.md)——拥有安全上限、失败与持久输出。
- [UI conversation](../ui-conversation/README.zh.md)——声明会话标题操作 slot。
- [UI chat](../ui-chat/README.zh.md)——声明带键命令卡片渲染与通用后备。
- [客户端包地图](../README.zh.md)——相邻浏览器包。
- [Workspace Brief 决策](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.zh.md)——记录产品边界与生命周期选择。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器插件只分派一个人类命令，而该命令的仅日志生命周期与简报输出都排除在模型历史之外。

#### KV Cache 影响

无；操作状态与卡片渲染绝不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束使浏览器适配器保持小巧且可预测。

- **按钮生成默认简报**——标题操作不提供 Git 状态开关；需要时用户键入已记录的 `--git` 命令。
- **仅已打开会话**——Draft、正在打开、正在关闭或已关闭的会话不能分派该操作。
- **不自动刷新**——重连和重新加载会渲染已记录命令事件，绝不会再次检查工作区。
- **Chat 展示**——专用 Markdown 卡片属于 Chat 命令 renderer；其他投影可以显示其通用命令生命周期视图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布 companion。插件拥有两个 slot 注册和一个 locale 注册，其测试证明释放会在干净重新加载之前撤销两个产品位置。
