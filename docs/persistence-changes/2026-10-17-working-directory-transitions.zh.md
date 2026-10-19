---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-17-working-directory-transitions

[English](2026-10-17-working-directory-transitions.md) | 中文

## 概述

记录会话有效工作目录的切换，并标明其排队模型通知的来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-working-directory-transitions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "9a36727716d0e73f681f3b725e7f28f89417c68174c8af0ff2b1ef52b08326a0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "ba5b10ea77d68f4a29439a9bd2a14f6a560acf55731749d57237757cc72fbc06"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-16-title-prepared-call-config"
    after: "6e6e023b36eeb36b153cf1734fbced73c082c68175a0c1e87c23572ab8a09406"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "2ace3b8059b82b6d9837fed518ca97a99eb37c4482df7aad0e71c85489428ade"
    decision: same-version
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增的 working-directory/change 事件在读取时是必需的：不认识该事件的旧构建必须拒绝已切换目录的会话，而不能在过时目录执行。working-directory 消息来源类型仅用于归因。已有日志和不可变会话头保持不变；读取、列举及旧会话首次未切换目录的请求不会追加初始目录事件或发布迁移。执行目录不会替代原有工作区、设置或沙箱权限根目录。分类器不要求提高结构性写入版本。

<a id="verification"></a>
## 验证

源码检查：47 个目录、SDK 关闭和封存运行时兼容性测试通过；8 个定向持久化用例通过，包括必需事件回放、无效目录拒绝及前代文件字节保持不变；68 个单次子代理驱动、继承策略、预设、结构化输出和调度测试通过。TypeScript SDK 目录协议测试通过。Python 文件语法检查通过，但随附 Python 缺少 pytest 和 pydantic，运行测试暂缓。未构建应用、请求真实账户、迁移用户数据、重启、安装或推送。此前的持久化组合测试出现工作进程退出；随后 JSONL 文件在配置的独立进程项目中完整通过 184 个测试。组合运行退出未再次复现，也未确认已修复。

<a id="dev-note"></a>
## 开发备注

无。
