---
description: "让 agent 读取或更改其 Session 工作目录，而不移动现有进程或改变权限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-working-directory

[English](README.md) | 中文

## 概述

让 agent（智能体）查看当前目录，或为后续操作选择现有目录。相对路径基于 Session 当前目录解析。变更会持久化并进入后续模型上下文；正在运行的进程和权限根目录保持不变。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此插件与工具注册表及[工作目录服务](../working-directory/README.zh.md)一起挂载；后者需要文件系统、Session 投影及系统提示词服务。

```yaml
- name: '@deepseek-ai/dsh-tool-working-directory'
```

此插件没有配置字段。调用 `working_directory` 时不传 `cd` 可校验并读取当前目录，传入 `cd` 则更改目录。两者均返回 `{ cwd }`，向模型渲染为绝对目录。空路径以及并非现有目录的目标会失败。如果此前选择的目录消失，读取会在原始项目可用时恢复到原始项目；如果原始项目也不可用，请显式选择有效的绝对目录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

此工具将校验、串行化、取消及持久变更委托给目录服务。它要求调用方具有 Agent Session，并使用该 Agent 的身份与取消信号。工具 schema 与结果渲染器见[实现](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作目录服务](../working-directory/README.zh.md) — 持久化、回退与不可变的项目权限依据。
- [工具注册表](../../core/tools/README.zh.md) — 限定作用域的执行与工具输出。
- [Session 参考](../../../docs/subsystems/session.zh.md) — 必读事件与重放。

-----

<a id="model-experience"></a>
## 模型体验

### 读取或更改目录

#### 模型看到什么

`working_directory` 工具描述为 `Read the current working directory, or change it with cd. Relative paths use the current directory. Existing shells and running processes keep their own directories.`。工具结果以文本形式包含绝对目录。服务提供必需的当前目录上下文，并在实际变更或恢复时排入记录到日志的转换通知。

#### Token 影响

工具 schema 和每次结果会增加 token。目录未变的读取不会添加转换通知；变更会添加服务的简短通知。

#### KV Cache 影响

工具结果追加到历史。目录变更还会改变服务的当前目录上下文；由该服务负责由此产生的可复用前缀影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

目录选择不会改变进程状态或访问策略。

- 现有 shell、终端及正在运行的进程保留其启动目录。
- 目录变更不会授予现有沙箱权限以外的访问能力。
- 不带 Agent Session 的调用会失败。

<a id="dev-note"></a>
### 开发备注

无。
