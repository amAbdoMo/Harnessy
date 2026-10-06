---
description: "Harnessy 持久 Markdown 卡片，用于查看所选工作区的有界 Workspace Brief 命令输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-brief

[English](README.md) | 中文

## 概述

本包为 `/workspace-brief` 命令生命周期提供专用卡片。卡片渲染宿主命令持久化的 Markdown，因此重新加载和重连会使用已记录数据，而不会再次运行仓库检查。浏览器绝不直接读取工作区文件，也不贡献会话标题栏操作。

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

Harnessy bundle 将此浏览器插件与宿主 Workspace Brief 命令一并挂载。在关联到工作区的会话中，通过普通命令输入键入 `/workspace-brief`。

如需包含 Git 状态，请使用 `/workspace-brief --git`。持久命令卡片显示已记录的运行中、成功或失败状态。再次运行命令可重试失败的检查。

### 最小组合

将此行与 locale、chat 和 renderer 包一同挂载到客户端组合。Harnessy bundle 会提供该依赖图。

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

插件贡献一个以 `workspace-brief` 为键的 `conversation.chat.commandview` 条目。宿主命令拥有验证、观察、取消与持久事件。slot 注册和 locale 字典均由 effect 拥有，并随插件 fiber 一起消失。

| 文件 | 职责 |
|---|---|
| [`src/client/WorkspaceBriefCard.tsx`](src/client/WorkspaceBriefCard.tsx) | 持久的加载、Markdown 成功与错误渲染 |
| [`src/client/index.ts`](src/client/index.ts) | Locales 与 effect 所拥有的命令卡片注册 |
| [`tests/browser-plugin.client.spec.tsx`](tests/browser-plugin.client.spec.tsx) | 卡片状态、无标题栏操作、禁用与重新加载覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace Brief 宿主命令](../../workspace/workspace-brief/README.zh.md)——拥有安全上限、失败与持久输出。
- [UI chat](../ui-chat/README.zh.md)——声明带键命令卡片渲染与通用后备。
- [客户端包地图](../README.zh.md)——相邻浏览器包。
- [Workspace Brief 决策](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.zh.md)——记录产品边界与生命周期选择。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器插件只渲染一个人类命令，而该命令的仅日志生命周期与简报输出都排除在模型历史之外。

#### KV Cache 影响

无；卡片渲染绝不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束使浏览器适配器保持小巧且可预测。

- **不自动刷新**——重连和重新加载会渲染已记录命令事件，绝不会再次检查工作区。
- **Chat 展示**——专用 Markdown 卡片属于 Chat 命令 renderer；其他投影可以显示其通用命令生命周期视图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布 companion。插件拥有一个命令卡片注册和一个 locale 注册；禁用插件会撤销两者，不影响宿主命令。
