---
kind: upgrade-guide
description: "Session 提示词取消在 inbox 插入前始终有效，而非仅在准入开始前有效。"
---
# 准入期间取消提示词

[English](guide.md) | 中文

## 变更

`session.prompt` 在异步解析 Agent 和附件之后，以及 inbox 插入之前，检查调用方取消状态。已取消的请求不能插入新提示词，也不能返回已有请求的接受结果。插入之后取消不会移除提示词或停止 Agent。

响应确认的是内存 inbox 准入，不是持久化检查点或任务完成。响应丢失或 PC 崩溃可能导致投递状态无法确定。

## 迁移

1. 直接 Host 调用需提供第二个参数：`ctx.sessionController.prompt(request, controller.signal)`。准入仍在等待时，保持该 `AbortSignal` 有效。RPC 仅传递请求 JSON，使用请求拥有的取消信号。中止可以拒绝已经开始解析 Session 的请求。
2. 处理 `gateway/cancelled` 时，不要自动再次提交提示词。投递状态不确定时检查 Session；不要把传输失败解释为请求肯定未获准入。
3. 验收时，在 Agent 或附件解析等待期间取消请求，并确认没有新的 inbox 条目出现。确认插入之后取消不会改变已准入的提示词。
