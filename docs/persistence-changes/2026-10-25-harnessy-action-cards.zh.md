---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-25-harnessy-action-cards

[English](2026-10-25-harnessy-action-cards.md) | 中文

## 概述

记录可选操作卡片的决定，以及状态通知的来源标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-harnessy-action-cards
baseline: false
changes:
  - root: "event:action-cards/decision"
    previous: null
    after: "2674d6b95e5c88c081dd62be78a6cdcf4e4f746dca5f773a764e6e1d62672534"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-working-directory-transitions"
    after: "8bb390b6c0253c96c5d662283f991fa300b782ec2f8ee273878741d0500757f0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-working-directory-transitions"
    after: "9540b08d13054131e1a46841e053d0562d7606629ebb5e1b4f35ff258e96e6fd"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-working-directory-transitions"
    after: "c9688568fc407aa5f53ba7c673bd4d7cfdf5aba12858d609fef69d2e669960ec"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-working-directory-transitions"
    after: "5e14827226c65146fd32a67d4efe02b224e0b9f7b190ac197e383ff0b62fd72c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件继续有效。新增 action-cards/decision 事件始终写入 ignorable:true，未安装可选插件的读取方可以跳过。action-cards 消息来源仅标记普通已记录通知文本，旧读取方保留其内容。不移动或覆盖任何已提交的会话代次，写入版本保持不变。

<a id="verification"></a>
## 验证

七个推荐包的 Vitest 回放通过 183 项测试，另有一项按主机能力跳过的符号链接测试。投影、状态上下文、取消、恢复、在线根会话准入以及真实 Loader/HMR 测试均通过。这些证据不代表主应用已经更新。

<a id="dev-note"></a>
## 开发备注

无。
