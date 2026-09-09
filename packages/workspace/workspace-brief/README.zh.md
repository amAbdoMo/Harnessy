---
description: "面向检查所选 Git 工作区且不把其内容发送给模型的用户与维护者，说明有界只读 Workspace Brief 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-brief

[English](README.md) | 中文

## 概述

本包让用户为当前会话所关联的工作区创建紧凑的 Markdown 简报。简报包含已注册工作区名称、规范仓库根目录、分支、有界顶层清单和已识别 manifest 元数据；`/workspace-brief --git` 还会包含最多 20 行状态。所有观察均为只读、受大小限制，且仅限所选已注册工作区。结果使用普通命令日志，因此会话重新加载后仍然存在，但不会进入模型历史。

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

Custom Harness profile 会把此命令与浏览器操作一并挂载。需要明确控制是否包含 Git 状态时，可以直接键入命令。

| 输入 | 结果 |
|---|---|
| `/workspace-brief` | 创建不含工作树状态行的简报。 |
| `/workspace-brief --git` | 添加有界工作树状态块。 |
| 任何其他后缀 | 返回 `Usage: /workspace-brief [--git]`，且不读取工作区。 |

命令会拒绝没有所选已注册工作区的会话，以及缺失或不是 Git 仓库的工作区。文件系统拒绝、Git 沙箱拒绝、Git 执行失败和五秒超时保持为不同错误。无法读取、过大、为符号链接或无效的 `package.json` 不会丢弃有效仓库事实；结果会把该 manifest 部分标记为不完整。

### 最小组合

在命令、文件系统、沙箱策略、shell 和工作区注册表服务注入后挂载此命令。Custom Harness bundle 会提供该顺序。

```yaml
- id: workspace-brief
  name: '@deepseek-ai/dsh-workspace-brief'
```

本包不接受配置字段。它绝不接受任意路径、写入文件、打开网络连接或调用模型。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部机制——点击展开</summary>

`WorkspaceBriefRunner` 通过 `ctx.workspaceRegistry` 解析会话 cwd，通过 `ctx.fs` 列出根目录，拒绝链接形式的 `package.json`，并使用已解析的只读沙箱策略，通过 `ctx.shell` 运行一条常量 Git 命令。输入、manifest 字节、Git 输出、清单行、状态行、字段长度、Markdown 总长度和耗时都有独立上限。命令注册表拥有 `command/run` 和 `command/done`；插件释放拥有命令注销。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 严格语法、有界观察、失败分类、Markdown 组装与命令注册 |
| [`tests/workspace-brief.spec.ts`](tests/workspace-brief.spec.ts) | 成功、失败、取消、重放、幂等性与生命周期覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace 注册表](../workspace/README.zh.md)——拥有所选工作区身份与目录状态。
- [Commands 包](../../interaction/commands/README.zh.md)——拥有分派与持久的仅日志生命周期。
- [文件系统包](../../fs/fs/README.zh.md)——拥有有界路径观察与类型化失败。
- [Shell 包](../../shell/shell/README.zh.md)——拥有子进程超时、输出捕获与沙箱报告。
- [Workspace Brief 决策](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.zh.md)——记录产品边界与取舍。

-----

<a id="model-experience"></a>
## 模型体验

无，因为人类命令只记录 `command/run` 与 `command/done`，它们是排除在模型历史之外的仅日志事件；简报文本绝不会附加为用户、助手、工具或上下文消息。

#### KV Cache 影响

无；创建或重放简报不会改变任何模型请求前缀或历史尾部。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束使操作保持可预测且只读。

- **仅 Git 工作区**——已注册的非 Git 目录会得到特定错误，而不是通用文件系统摘要。
- **仅顶层包元数据**——命令识别固定的 manifest 名称集合，并且只解析常规顶层 `package.json`。
- **显式刷新**——持久卡片是某个时间点的结果；重连和重新加载绝不会自动重新运行仓库检查。
- **有界状态而非 diff**——`--git` 最多报告 20 行短状态，绝不读取文件 diff，也不读取有界 manifest 字段之外的文件内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布 companion。runner 不拥有可变状态；命令注册表持久化每次结果，插件 fiber 在释放时撤销唯一注册。
