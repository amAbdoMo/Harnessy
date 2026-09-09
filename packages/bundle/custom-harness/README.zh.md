---
description: "面向启动独立品牌 Web profile 的用户与维护者，说明 Custom Harness 产品 patch 层。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-custom-harness`

[English](README.md) | 中文

## 概述

本包是随附 `custom-harness` profile 在 `dsh-base` 和 `dsh-web-app` 之后应用的窄产品层。它替换原有品牌、禁用逐消息评分与备注、为 OpenAI 账户登录启用中立 authorization service，并添加有界只读 Workspace Brief 操作，不会重命名共享框架包、模型提供方名称、协议或兼容性表层。

## 目录

- [使用本包](#use-this-package)
- [已禁用的逐消息反馈](#disabled-per-message-feedback)
- [Workspace Brief](#workspace-brief)
- [OpenAI 账户登录](#openai-account-login)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

先运行一次 `pnpm run build:custom-harness`，再通过 `pnpm run custom-harness -- --no-open` 启动产品。启动器会选择 `dsh --profile custom-harness`，并用 Custom Harness 数据目录中的产品专属 home 替换环境里可能存在的原有 `DSH_HOME`。

Windows 默认位置为 `%LOCALAPPDATA%\CustomHarness\Harness`、`%LOCALAPPDATA%\CustomHarness\Logs` 和 `%LOCALAPPDATA%\CustomHarness\Cache`。测试或托管部署可以使用产品专属的 `CUSTOM_HARNESS_*` 变量重定向这些目录；启动器不会自动导入原有状态。

<a id="disabled-per-message-feedback"></a>
## 已禁用的逐消息反馈

此 profile 同时禁用 `message-feedback` Host 行与 `ui-message-feedback` 客户端行。因此浏览器不会提供“Good response”“Bad response”或“Add a note”操作，直接发送的 `messageFeedback/list`、`messageFeedback/put` 和 `messageFeedback/delete` Remote 请求无人接管，并返回 HTTP 404。

逐消息反馈没有模型工具，因此工具列表不需要兼容别名或墓碑。现有会话日志仍可打开，因为评分与备注存放在独立 sidecar 中，而非会话事件流。此 profile 不迁移或删除该 sidecar。

会话级 `/feedback` 命令仍然可用。遥测反馈门控、身份验证、审批、权限预设、沙箱和文件系统策略也保持不变；它们属于独立的运行、隐私和安全控制。

<a id="workspace-brief"></a>
## Workspace Brief

此 profile 插入 `workspace-brief` 宿主行与 `ui-workspace-brief` 客户端行。已打开会话可以为其所选已注册 Git 工作区创建有界 Markdown 摘要；键入 `/workspace-brief --git` 会添加有界短状态行。该命令不接受任意路径、不写入文件、不执行网络或模型请求，并通过普通命令日志持久化其结果。

禁用任一行会移除体验的对应一半，而不改变已存储会话。缺少专用客户端行时，已记录简报仍可通过通用命令 renderer 阅读；重连和重新启动绝不会自动重新运行仓库检查。

<a id="openai-account-login"></a>
## OpenAI 账户登录

该 profile 挂载 `@deepseek-ai/dsh-authorization`。因此继承的 dormant `llm-pi-ai` adapter 会在 provider route 尚不存在时注册其 `openai-codex` OAuth flow，而 Custom Harness brand client 会在 Settings > Models 放置 **Sign in with OpenAI**。Host 在默认浏览器中打开 HTTPS 授权页面；provider flow 直接把产生的 grant 写入本地 credential store，controller 只在 authorization service 确认该写入后启用对应 provider route。

退出登录会删除本地 grant 并移除对应 route。token 不会跨越 Remote 响应，也不会进入 settings 或 session log。上游账户登录行为请参阅[官方 Codex authentication 文档](https://learn.chatgpt.com/docs/auth)。

<a id="model-experience"></a>
## 模型体验

间接影响来自继承的 base 与 Web 组合。OpenAI 登录可以启用已安装的 Codex model catalog；此 patch 层自身不注册 prompt 或工具 schema，Workspace Brief 也保持为仅人类可用的日志事件。

#### KV Cache 影响

除所选 base 与 Web 组合外没有影响；本 patch 仅更改浏览器行。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Bundle 范围**——本包提供产品 profile 和仓库启动器；可执行文件与安装程序由[桌面应用](../../../apps/desktop/README.zh.md)负责。
- **默认状态独立**——需要原有状态时，用户必须明确迁移所选内容；启动器从不自动复制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 本 bundle 只修补产品自有行，并保持所有共享 API 与包标识不变。

不发布运行时不变式 companion；本包是静态产品 patch 层，插入行各自拥有其运行时关系与不变式 companion。
