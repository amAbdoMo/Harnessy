---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-16-title-prepared-call-config

[English](2026-10-16-title-prepared-call-config.md) | 中文

## 概述

在新写入的会话标题辅助请求记录中添加精确的预备生成控制参数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-16-title-prepared-call-config
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "a0b6c6652e4e6b18abc8ac04882bedefad08ec4185ea8af75612ab95bd5353bc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

config 属性在读取时可省略，因此已有请求记录仍然有效，列出会话不会重写或迁移它们。新标题调用会在分发前写入预备的 provider、model 和控制参数，包括受支持的推理强度。现有路由、提示词、来源序列和输出上限继续保留；旧记录缺少 config 不代表采用任何特定推理强度。权威分类器接受此可选属性新增，无需提升 Session 写入版本。

<a id="verification"></a>
## 验证

仅源码 Vitest 覆盖 session-title-llm 请求策略、两种标题提供方及其真实 Loader 组合：20 个测试通过。策略回归在多种受支持推理强度下比较日志 config 与实际分发的控制参数。未打开或迁移真实用户会话文件；运行时与浏览器验收仍需离线完成。

<a id="dev-note"></a>
## 开发备注

无。
