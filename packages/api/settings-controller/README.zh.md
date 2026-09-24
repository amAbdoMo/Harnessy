---
description: "settings、凭据与 Harnessy provider 账户管理的 Host Remote owner。"
kind: "package-reference"
---
# Settings Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-settings-controller` 为浏览器配置界面提供生成的 `ctx.remote.settings` 与 `ctx.remote.credentials` namespace。它返回脱敏的 settings 与凭据元数据，支持 settings 与凭据写入而不返回机密值，并在 Host 桌面打开由提供方持有的 settings 或 Agent preset 位置。提供方缺失时，namespace 仍会注册，并返回可操作的配置错误。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包作为 Loader entry 挂载到提供浏览器配置的 profile 中。本 entry 不依赖提供方是否存在而注册两个 namespace，因此缺少提供方会在调用时产生具名配置错误。它生成的 descriptor 进入严格 Typert 注册表，而 settings 与凭据 Definition 仍是普通 Cordis 服务，自身不承担任何 wire 义务。

`describe(refs)` 以请求的名字为键返回一份 map，因此设置页描述其各行携带的全部引用时，这些行会一起落定。单次调用最多接受 64 个名字，无效名字或空写入值报告为 `bad-request`，并逐字段复制每个答案——提供方返回超出 `CredentialInfo` 声明的内容也无法扩大跨越 wire 的字段。有效的 `set(ref, value)` 与 `unset(ref)` 调用把提供方拒绝报告为 `credential-rejected`，携带提供方的消息，details 中只有该引用。机密值只在这个方向跨越 wire：这里没有任何方法会返回它。

`settings.describe()` 返回部署信息，以及在 `redactSecrets: true` 下读取的所有 namespace。`settings.update`、`settings.replace` 与 `settings.mutate` 暴露 settings 服务的三种写入操作，并返回该 namespace 的新脱敏视图；陈旧写入使用 `settings-conflict`，其他提供方拒绝使用 `settings-rejected`。

`settings.openSettingsDocument()` 准备提供方持有的文档，并用原生文本编辑器打开；该方法不接受浏览器提供的文件系统目标。

`openAIAccount.describe()` 返回可用、已配置、进行中与可写标志，不包含任何 token 字段。`openAIAccount.signIn()` 选择已安装的 `llm-pi-ai/openai-codex` OAuth flow，只接受 HTTPS 授权目标，在 Host 桌面的默认浏览器中打开它，并等待 provider 的本地回调。成功后，授权 flow 自己写入 grant，并把 `llm-pi-ai.providers.openai-codex` 加入 settings。`openAIAccount.signOut()` 删除该 grant 并移除依赖它的 route。浏览器打开失败使用 `openai-account/browser-failed`；组合缺失或 URL 不安全使用 `openai-account/unavailable`。

`accounts.describe()` 把已有 canonical provider credential 导入受保护、仅 Host 可见的多账户 vault，并且只返回 provider 标签、账户身份标签、激活状态、用量快照与 Codex 自动切换偏好。Codex、Kimi 与 Claude Code 使用已安装的 OAuth flow；GLM 与 OpenCode 接受本地保存的 API key。添加、激活、重命名与移除操作会让 provider 的 canonical `llm-pi-ai/<provider>` credential 与所选 vault entry 保持同步，因此模型请求会立即切换。`accounts.refreshUsage()` 在需要时刷新 Codex OAuth 并读取支持的 quota window；启用可选的自动切换后，如果当前账户的 `5h` 或 `7d` 窗口用量达到 95%，它会提升一个所有标准窗口均低于该阈值的已刷新账户。同一检查也会在下一个 Codex 调用解析凭据前的 `agent/request` 中执行。provider 确认额度耗尽后，Host 会再次刷新用量，并且仅在该刷新确实完成账户切换时重试当前轮次。每次已提交的提升都会发出不含秘密的 `accounts/auto-switched` 事件。Workspace 账户会留在同一 ChatGPT workspace，唯一例外是同一所有者的 Personal/Workspace 配对；Personal 账户可以使用另一个 Personal membership。没有受支持用量服务的 provider 会报告限制，而不会猜测数值；请求前用量检查失败不会阻止模型调用。

`mcpManager.describe()` 返回 Harnessy 全局保存的 MCP profile、实时连接状态与已发现工具名称，但不返回认证值。`save`、`setEnabled`、`reconnect` 与 `deleteServer` 通过 credential provider 串行保存变更，并立即协调受监督的连接。`openConfigurationFile()` 打开专用的 `$DSH_HOME/mcp-servers.json` 文档；页面下一次刷新状态时会验证并采用其中的修改，界面写入也会同步该文档。该文档仅供本机所有者使用，但为了直接编辑而刻意保持可读，因此可能包含 MCP 认证信息，不应共享。远程服务必须使用 HTTPS，本机 loopback HTTP 除外；本地 stdio 条目直接启动可执行文件，不经过 shell 插值。启用的服务器与声明式 MCP client 条目共享公共 namespace 预留，因此重复 namespace 会安全失败，不影响先前连接。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-settings-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 settings 与凭据配置属于浏览器和 Host 状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；读取或写入这些配置值不会改变已经在途的模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 批量上限固定为 64 个引用，不是可按部署配置的字段。
- OpenAI 账户界面有意只支持桌面浏览器登录；底层 authorization seam 仍支持 headless device-code 与 manual-code 展示，但这里不暴露。
- 只有存在稳定、认证用量服务时才暴露 provider 用量。当前 manager 报告 Codex window；GLM、Kimi、OpenCode 与 Claude Code 账户仍可切换，但不会生成虚构 quota 数据。
- MCP 状态目前通过短间隔浏览器轮询更新，而不是推送 Remote event。重连期间可能仍显示最后已知工具列表，但服务器恢复前调用会失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。settings 与凭据 seam 负责存储和更新事件，本包只把它们的方法投影到 wire。
