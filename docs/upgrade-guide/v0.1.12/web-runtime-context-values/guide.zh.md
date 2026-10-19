---
kind: upgrade-guide
description: "Web 提示词段落不再内嵌 checkout 路径与 GUI URL；这些取值改为 runtime context，且 @deepseek-ai/dsh-app-boot 不再导出 addHarnessSourceSection。"
---

# 将 Web 提示词取值留在 runtime context

[English](guide.md) | 中文

## 变更

`dsh web` 过去把实现 checkout 与公告 GUI URL 写进 `harness:source` 与 `app:web-surface` 提示词段落。这两个取值在不同进程间会变化，因此重启后恢复的会话会看到不同的请求前缀，其早期轮次的签名思考随之失效。现在这两个段落不含取值，checkout 路径与 GUI URL 作为 runtime context 送达，由会话按请求读取。已经接纳过旧版带值段落的会话会原样保留它们，其请求前缀完全不变。`@deepseek-ai/dsh-app-boot` 不再导出 `addHarnessSourceSection` 与 `HARNESS_SOURCE_SECTION`；Web bundle 现在拥有这两个段落、它们的 runtime context，以及保留已接纳段落的投影。`surfaceContext` 配置、`DSH_WEB_URL` 环境变量与 Web 组合本身保持不变。

## 迁移

1. 从 `@deepseek-ai/dsh-app-boot` 移除 `addHarnessSourceSection` 与 `HARNESS_SOURCE_SECTION` 导入。需要同样段落的组合改为挂载 `@deepseek-ai/dsh-web-app`；自行注册 `harness:source` 段落的组合可保留该名称与自有文本。
2. 模型现在在 runtime-context 快照而非系统提示词中收到 checkout 路径与 GUI URL。断言系统提示词文本的脚本需改为读取 runtime-context 快照。
3. 打开一个在本次变更之前开始的会话，确认其系统提示词仍原样携带旧版段落。
