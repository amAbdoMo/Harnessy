# Agent Note: 可选 Workspace 会话

Status: implemented

[English](2026-09-12-optional-workspace-sessions.md) | 中文

## Problem

全局 New Session 操作会继承当前或最近活跃的 Workspace。没有 Workspace 时，空 composer 会要求先选择目录才能输入提示词。以浏览器为主的工作（例如管理 WordPress 网站）因此会在每个新会话中遇到无关的项目文件夹决定。

## Decision

全局 New Session 操作会创建或复用一条未归档、未分组的空白 Session。创建 Session 时同时省略 `workspaceId` 与 `cwd`，由 Host 提供已配置的默认工作目录，不显示文件夹提示。并发的全局请求共享同一次创建，并打开同一条临时 Session。

Workspace 作用域操作继续传入 Workspace id，并保留每个 Workspace 的空白 Session 复用行为。应用启动导航仍可重新打开最近使用的 Workspace；改为未分组默认值的是显式的全局 New Session 操作。

未分组的空白 Session 会在可交互的 Workspace 选择器中显示**无项目**，并保持 composer 可输入。用户可以立即发送以浏览器为主的任务，也可以在首条提示词前选择现有 Workspace 或新文件夹。

## Alternatives considered

- **始终打开目录选择器** — 放弃，因为浏览器专属任务不应被迫作出本地文件系统决定。
- **继承当前或最近的 Workspace** — 放弃，因为无关代码项目会静默地给下一个任务提供误导性的工作上下文。
- **从 New Session 完全移除 Workspace 选择** — 放弃，因为本地开发仍是主要工作流，需要保留显式项目选择。

## Consequences

以浏览器为主的 Session 可以一键开始，并在选择项目之前显示在 Ungrouped 下。本地编码工作通过现有选择器或 Workspace 作用域操作多做一次显式项目选择。Host 仍为每个 agent 分配有效工作目录，因此要求绝对 `cwd` 的 provider 与工具保持现有约定。

聚焦的 Workspace service 测试覆盖空白复用、排除已归档和 Workspace 所有的 Session、并发创建以及显式目标。Conversation 测试覆盖可输入的未分组 hero 与可选项目选择器。
