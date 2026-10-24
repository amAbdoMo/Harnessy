---
kind: upgrade-guide
description: "普通 Session 分叉不再发出子代理启动通知，并可通过普通会话入口恢复。"
---

# 普通分叉与子代理分别分类

[English](guide.md) | 中文

## 变更

SDK 的 `subagent.started` 通知仅标识 `origin` 为 `subagent` 且具有直接创建者的 Session。普通分叉不再发出此通知。ACP 可列出和恢复普通分叉；无头运行器在工作目录、所有权和预设检查通过后也接受它们。客户端谱系缩进和 Harnessy 通知通过 `origin` 区分普通分叉与子代理。

Harnessy 保留普通分叉已保存的来源关联、复制的历史、种子边界、标题、Workspace 归属，以及手动排序中紧邻来源的位置。现有 Session 文件不会被重写，存储格式不变。仅有父级 id 既不能判定子代理身份，也不授予继续执行权限。

## 迁移

1. 外部消费者若将所有具有 `parentSession` 或 `parentSessionId` 的会话视为子代理，应改为检查 `origin === 'subagent'`。来源追踪与子代理分类须分别处理。
2. 通过普通 Session 生命周期事件观察普通分叉，不再依赖 `subagent.started`。子代理继续执行检查仍须依据其自身有效的继续执行描述符。
3. 确认普通分叉可在已记录的工作目录中恢复，且不会发出 `subagent.started`；同时确认真正的子代理保留其创建者和通知。无需手动迁移 Session 文件。
