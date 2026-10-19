---
description: "在重放后保留每个 Session 的当前工作目录，并在执行前校验目录变更。"
kind: "package-reference"
---

# @deepseek-ai/dsh-working-directory

[English](README.md) | 中文

## 概述

让 Session 的当前目录独立于原始项目和其他 Session。变更持久化到 Session 日志，并出现在后续模型上下文中。当前目录消失时，如果原始项目仍存在，就恢复到原始项目；原始项目也不可用时则明确失败。现有进程和权限根目录保持不变。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

共享 base profile 挂载此服务。使用支持当前目录的文件系统或 shell 工具的自定义组合，必须同时挂载文件系统提供方、Session 投影和系统提示词服务。

```yaml
- name: '@deepseek-ai/dsh-working-directory'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultDirectory` | 启动目录 | 没有原始项目的 Session 使用的执行环境绝对目录。 |

`get(session)` 不访问文件系统或修改状态，直接读取有效目录。`ensure(agent, signal)` 校验该目录，并在已变更的选择消失时恢复到原始项目；没有头部目录的 Session 则使用部署回退目录。`set(agent, path, signal)` 在提交变更前校验新的绝对或相对目录。目录检查使用注入到本服务的文件系统，因此 Agent 上下文无需单独注入文件系统。

`Session.header.cwd` 仍是不可变的原始项目目录，用于设置、工作区关联及沙箱权限依据。只有实际变更或恢复才追加必读的 `working-directory/change` 事件；回退读取、首次组装或列表查询不会追加初始值，也不会仅为记录回退值而迁移 Session。不识别该必读事件的旧构建必须拒绝日志，而不是在错误目录中执行。头部和历史文件均不会被重写或移动。

`working-directory/before-change` 是针对拟选目录的同步授权瀑布，包括尚未创建的路径。预检期间可以检查策略，发布前会立即重新检查。允许变更的策略均调用 `next()` 委派；拒绝时保留目录，且不增加事件或通知。[Auto-review 集成](../../experimental/auto-review/README.zh.md#known-limitations-and-deferred-work)会在其预设启用时限制目录切换。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Session 投影折叠已提交的目录变更，同时保留不可变的项目元数据。同一个 Session 的变更串行执行，不同 Session 相互独立。提交前取消或释放 Agent 会阻止发布。服务释放时会取消并等待其持有的操作结束。通知注入失败会保留已提交状态，并发出警告。

参阅[实现](src/index.ts)与[行为测试](tests/working-directory.spec.ts)。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Session 投影](../session-projection/README.zh.md) — 重放状态与线协议观察。
- [文件系统服务](../../fs/fs/README.zh.md) — 执行环境中的路径解析。
- [系统提示词](../../core/system-prompt/README.zh.md) — 必需的用户上下文。

<a id="model-experience"></a>
## 模型体验

### 当前目录

#### 模型看到什么

即使关闭可选运行时上下文，必需用户上下文仍包含 `Current working directory: "<absolute directory>".`。组装还会刷新旧有的 `{{cwd}}` 模板变量，而不替换自定义提示词文本。已提交的变更和恢复会排入一条用户角色通知；被接纳的上下文与通知会记录到日志，以便重建模型历史。Session 头部保留原始项目目录。

#### Token 影响

每次组装均包含目录句子。变更会添加简短的转换通知；目录未变的读取不会添加转换通知。

#### KV Cache 影响

目录变更会修改对应的上下文文本，并追加转换通知。可复用前缀在第一个变化的上下文 token 处结束。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

目录变更只应用于后续操作。

- 正在运行的进程保留其现有目录。
- 当前目录变更不会扩展权限根目录。
- 当前目录与原始项目都不可用时，恢复会失败；显式切换到有效目录可恢复 Session。

<a id="dev-note"></a>
### 开发备注

无。
