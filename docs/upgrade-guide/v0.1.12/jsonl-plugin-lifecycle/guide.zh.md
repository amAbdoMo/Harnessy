---
kind: upgrade-guide
description: "JSONL 持久化要求使用命名空间插件导入；直接构造服务类与类类型标注必须改用持久化服务。"
---

# 通过插件挂载 JSONL 持久化

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-persistence-jsonl` 将默认服务类导出替换为具名的 `name`、`Config` 和 `apply` 函数插件导出，不再提供默认导出。默认导入、直接构造、继承、`instanceof` 与类类型标注均受影响。移除此提供方触发消费者卸载时，插件会保留监听器与句柄直到这些消费者完成卸载；根作用域的并发卸载仍不保证顺序。`sessionPersistence` 服务 API、现有 YAML 配置与存储文件保持不变。

## 迁移

1. 将默认导入替换为 `import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`。现有 `ctx.plugin(JsonlSessionPersistence, config)` 调用仍然有效；将直接构造替换为此挂载调用。动态导入使用 `await import(...)` 返回的模块命名空间，而非其 `.default`。消费者声明 `inject: ['sessionPersistence']` 并访问 `ctx.sessionPersistence`。
2. 服务类型标注使用 `@deepseek-ai/dsh-session-persistence` 导出的 `SessionPersistence` 类型。将具体类的 `instanceof` 检查与子类替换为该服务的消费者；具体 JSONL 类为私有实现。
3. 等待插件启动，确认可以创建、刷新并重新打开会话。在注入 `sessionPersistence` 的作用域中注册异步消费者清理，使后端卸载等待该清理完成。
