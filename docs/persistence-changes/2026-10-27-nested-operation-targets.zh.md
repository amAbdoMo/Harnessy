---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-nested-operation-targets

[English](2026-10-27-nested-operation-targets.md) | 中文

## 概述

为嵌套 PTC 工具结果添加可选、可回放的展示元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-nested-operation-targets
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-16-session-format-v4"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选的 meta 字段承载可安全序列化为 JSON 的操作目标，与程序值和模型内容独立。缺少此字段的已有日志仍然有效。两个 SDK 均保留事件数据与通知。这是同版本的增量变更，不改变 Session 的结构版本或原始工作区权限。

<a id="verification"></a>
## 验证

分类器报告一项 optional-property-added 变更，无需提升版本。针对嵌套展示投影的回归测试和两个 SDK 客户端投影检查均已通过。在此次确认记录中，POSIX 会话记录及 SDK 写入结果验证仍待执行。

<a id="dev-note"></a>
## 开发备注

无。
