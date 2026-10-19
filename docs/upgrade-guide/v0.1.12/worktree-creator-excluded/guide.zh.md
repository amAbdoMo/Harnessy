---
kind: upgrade-guide
description: "可选的实验性 worktree 提供方与工具包不可用，必须从自定义组合中移除。"
---

# 从组合中移除可选的 worktree 创建器

[English](guide.md) | 中文

## 变更

本次 Harnessy 交付排除 `@deepseek-ai/dsh-experimental-worktree` 和 `@deepseek-ai/dsh-experimental-tool-worktree`。启用这些可选包的自定义组合无法加载它们。其破坏性 Git 操作仍可能在检查后因目标目录或管理目录被替换而重定向。移除这些包不会更改现有 checkout 目录或 Git 元数据。

## 迁移

1. 从自定义 `cordis.yml` 文件和 overlay 中移除引用任一包的条目，并移除针对这些条目的 patch override。不提供替代创建器。
2. 保留现有 checkout 及其 Git 元数据；无需迁移或删除已存储数据。可以按照通常的 workspace 与 sandbox 规则，将现有 checkout 选为新 Session 的目录。
3. 确认组合不再报告任一包缺失，且常规的基于目录的工具仍然可用。
