# Agent Note: Custom Harness 禁用逐消息反馈

Status: implemented

[English](2026-09-08-custom-harness-message-feedback-disablement.md) | 中文

## 问题

共享 Web 组合会在每条助手消息上提供“Good response”“Bad response”和“Add a note”操作。Custom Harness 有意省略这一产品表层，但仅隐藏按钮仍会让旧客户端或直接请求调用其 Host Remote。删除共享反馈实现也会改变原有 Web 产品，并可能把消息批注与独立的会话级反馈及安全控制混为一谈。

## 决策

`custom-harness` profile 在 `packages/bundle/custom-harness/cordis.patch.yml` 中禁用 `message-feedback` Host 行与 `ui-message-feedback` 客户端行。因此客户端不会贡献逐消息控件，Host 也不会注册 `messageFeedback/list`、`messageFeedback/put` 或 `messageFeedback/delete` Remote 处理器。经过身份验证的网关对这些无人接管的路径返回 HTTP 404。

逐消息反馈从未拥有模型工具，因此此 profile 不引入工具别名、墓碑或替代 schema。现有会话日志保持兼容，因为评分和备注使用独立 sidecar，而非会话事件。此 profile 不迁移或删除该 sidecar。

`/feedback` 命令、遥测反馈门控、身份验证、审批、权限预设、沙箱和文件系统策略仍然保留在组合中。它们是独立的运行、隐私或安全控制，并非逐消息批注的替代路径。

## 验证

Web 组合覆盖会启动自定义 overlay、检查 Host 服务缺失、向三个 Remote 路径发送经过身份验证的请求，并在重启后再次确认相同的拒绝组合。已构建客户端冒烟测试会检查反馈 UI 插件缺失、冷启动打开现有会话时没有反馈控件，并保留“Copy”操作。组合覆盖还保留 `read` 工具与独立的 `/feedback` 命令。

## 考虑过的替代方案

**只隐藏客户端控件。** 这会让旧客户端和手工请求继续访问 Host Remote，因此没有端到端禁用该能力。

**删除或更改共享反馈包。** 原有 Web profile 仍然支持这些包。产品专属的省略应位于下游 profile 层，这也使该变更易于撤销，而不会扰动共享代码。

**同时禁用 `/feedback` 命令或遥测反馈门控。** 它们的会话级作用和隐私作用独立于逐消息评分与备注。移除它们会扩大本决策范围，并削弱保留的运行控制。

**清除现有反馈 sidecar。** 禁用访问无需破坏性清理，而且在没有迁移要求时这样做会丢弃用户数据。

## 结果

Custom Harness 用户无法对单条消息评分或添加备注，包括通过直接调用 Remote 的旧客户端。现有会话历史仍可正常重放，已存储的批注数据不会被重写。原有 Web profile 继续保留该功能。若要重新引入逐消息反馈，必须明确重新启用两个 profile 行，并将拒绝覆盖恢复为功能正向覆盖。

## 相关内容

独立产品身份记录在 [Custom Harness 品牌身份](../feature/2026-09-08-custom-harness-brand-identity.zh.md) 中。
