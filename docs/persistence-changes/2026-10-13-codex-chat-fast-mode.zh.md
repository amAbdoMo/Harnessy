---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-codex-chat-fast-mode

[English](2026-10-13-codex-chat-fast-mode.md) | 中文

## 概述

添加仅写入日志的 llm-pi-ai/fast-mode 事件，以 enabled 布尔值记录当前会话的选择。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-codex-chat-fast-mode
baseline: false
changes:
  - root: "event:llm-pi-ai/fast-mode"
    previous: null
    after: "37ae0f7c37ae4f1a01b65fde2ec9f3047ec2f39b1ebed3982d3d66eda5e80deb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该事件为新增事件，写入方将其标为 ignorable。不含所属插件的读取方可跳过它，而不改变模型历史。没有该事件的已有会话默认不请求优先服务。当前读取方校验持久化 enabled 值为布尔值，并从 Session 日志重建选择；分叉继承已记录前缀。写入格式保持不变。

<a id="verification"></a>
## 验证

命令与 Session 定向测试覆盖非法持久化值、分叉隔离、持久化刷新完成及拒绝，以及 ignorable 追加标记。Codex socket 测试覆盖 SSE 与 WebSocket 优先服务请求体、不变的推理等级与请求内容、发送时选择固定、辅助调用排除，以及 JSONL 关闭后重新打开并向实时会话发送优先服务请求。无需密钥的 TypeScript SDK 回放与 Python 运行时快照比较真实命令结果、通知及持久化选择。多语言斜杠菜单测试覆盖该命令的客户端展示。

<a id="dev-note"></a>
## 开发备注

无。
