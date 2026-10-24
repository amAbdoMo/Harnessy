---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-harnessy-search-thinking

[English](2026-10-24-harnessy-search-thinking.md) | 中文

## 概述

允许辅助 DeepSeek 搜索请求记录显式关闭思考的选项。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-harnessy-search-thinking
baseline: false
changes:
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-09-11-initial"
    after: "0c556c9b9f2a96238a6b9bbb99e748206cbff2ed6203041c9571f04ae5802f52"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

thinking 字段为可选字段。缺少此字段的现有请求事件仍然有效，事件封装和 Session 写入版本保持不变。新的辅助请求记录与发送到 Messages API 相同的关闭思考值。

<a id="verification"></a>
## 验证

聚焦的 Web 提供方、Web 工具和 Web Search 设置测试共 12 个文件、311 项通过。deepseek-fetch 无密钥场景生成独立的当前 profile 请求头旁文件后通过。未执行真实 API 调用或已安装应用更新。

<a id="dev-note"></a>
## 开发备注

无。
