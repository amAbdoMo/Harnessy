---
description: "面向启动独立品牌 Web profile 的用户与维护者，说明 Harnessy 产品 patch 层。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-custom-harness`

[English](README.md) | 中文

## 概述

本包是随附 `custom-harness` profile 在 `dsh-base` 和 `dsh-web-app` 之后应用的窄产品层。它替换原有品牌、禁用逐消息评分与备注、为 OpenAI 账户登录启用中立 authorization service、添加有界只读 Workspace Brief 操作，并添加 Command Code 委派与子代理角色目录；两者唯一的设置界面是 **子代理** 页面，它既编辑角色目录，也在其旁报告 Command Code 后端。此过程不会重命名共享框架包、模型提供方名称、协议或兼容性表层。

## 目录

- [使用本包](#use-this-package)
- [已禁用的逐消息反馈](#disabled-per-message-feedback)
- [Workspace Brief](#workspace-brief)
- [Command Code 委派](#command-code-delegation)
- [子代理](#subagents)
- [OpenAI 账户登录](#openai-account-login)
- [共享技能文件夹](#shared-skills-folder)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

先运行一次 `pnpm run build:custom-harness`，再通过 `pnpm run custom-harness -- --no-open` 启动产品。启动器会选择 `dsh --profile custom-harness`，并用 Harnessy 数据目录中的产品专属 home 替换环境里可能存在的原有 `DSH_HOME`。

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

<a id="command-code-delegation"></a>
## Command Code 委派

此 profile 挂载 `commandcode-delegation` 宿主行。它为本 profile 中的每个 agent 添加一个 token 稳定的 `commandcode_delegate` 工具与一个 `list_commandcode_lanes` 发现工具，以及一个保存具名通道与运行上限的实时 `commandcode-delegation` 设置分区。该分区没有自己的设置页面：**子代理** 页面会读取该行的 `commandcode` Remote 命名空间，以获取后端安装状态，以及其角色选择路由所用的模型目录。

每个通道固定了精确的 Command Code 模型、推理强度与访问级别，因此被委派的任务无法选择或扩大其中任何一项。用户自己安装并登录的 CLI 是唯一的后端：此 profile 不内置任何 Command Code 包、不保存任何 Command Code 凭据，也不回退到任何其他产品、模型或可执行文件。加载该行不会启动任何 Command Code 进程。禁用它会移除这两个工具、该分区，以及子代理页面本会报告的后端状态，且不影响其他任何产品配置档。

通道设置分区与统一角色目录并存挂载，因此在用户转向角色目录期间，`commandcode_delegate` 与 `list_commandcode_lanes` 仍可继续通过它工作。

<a id="subagents"></a>
## 子代理

此 profile 挂载 `subagent-roster` 宿主行与 `ui-settings-subagents` 客户端行。两者共同添加设置中的顶层 **子代理** 页面及其背后的角色目录：`subagent-roster` 设置分区，每个已存角色一张卡片——涵盖其模型与推理强度、沙箱访问级别、调用方式、工具范围与固定指令——以及按工作区的覆盖层与 Agent 选择模型时所要解析的自动路由授权。

宿主行会为本 profile 中的每个 agent 添加一个 token 稳定的 `delegate` 工具与一个 `list_subagents` 发现工具，因此两套委派工具并存。它在加载时注册这些工具，且不启动任何子进程。

在首次发现已存通道配置的加载中，宿主行还会把该配置一次性写入 `subagent-roster` 文档。`commandcode-delegation` 分区、其按工作区的 `projects` 覆盖层，以及 `subagent-model-selection` 分区都原样保留，用户可查看或回退；用户已自行编辑过的角色目录绝不会被替换。

客户端行仅负责呈现：它读取 Host 角色目录插件的 `subagentRoster` Remote 命名空间、Host 的全局模型目录，并在挂载了 Command Code 行时读取该行的 `commandcode` 命名空间以获取后端自有角色的路由，同时写入 `subagent-roster` 设置分区。因此它自身不强制执行任何策略，也不启动任何进程。

<a id="openai-account-login"></a>
## OpenAI 账户登录

该 profile 挂载 `@deepseek-ai/dsh-authorization`。因此继承的 dormant `llm-pi-ai` adapter 会在 provider route 尚不存在时注册其 `openai-codex` OAuth flow，而 Harnessy brand client 会在 Settings > Models 放置 **Sign in with OpenAI**。Host 在默认浏览器中打开 HTTPS 授权页面；provider flow 直接把产生的 grant 写入本地 credential store，controller 只在 authorization service 确认该写入后启用对应 provider route。

退出登录会删除本地 grant 并移除对应 route。token 不会跨越 Remote 响应，也不会进入 settings 或 session log。上游账户登录行为请参阅[官方 Codex authentication 文档](https://learn.chatgpt.com/docs/auth)。

<a id="shared-skills-folder"></a>
## 共享技能文件夹

此 profile 挂载一个全局文件系统 skill provider，默认根目录为 `%USERPROFILE%\.agents\skills`。Harnessy 的私有运行时与凭据 home 仍位于 `%LOCALAPPDATA%\CustomHarness`；只有明确选择的 skill 目录会被共享。Settings > General 提供实时启用开关和原生文件夹选择器，重置该字段会恢复常规 `.agents\skills` 位置。provider 会监视所选目录，因此目录新增、重命名及 frontmatter 更改无需重启应用。

全局共享根目录会与各 preset 的作用域文件系统 provider 组合。项目 `.dsh\skills` 与 `.agents\skills` 条目保留更高优先级，因此项目可以有意覆盖同名个人 skill。

<a id="model-experience"></a>
## 模型体验

间接影响来自继承的 base 与 Web 组合。OpenAI 登录可以启用已安装的 Codex model catalog；本 profile 添加的工具由所挂载的委派行拥有，此 patch 层自身不注册 prompt 或工具 schema，Workspace Brief 也保持为仅人类可用的日志事件。

#### KV Cache 影响

除所选 base 与 Web 组合外没有影响，唯一的例外是所挂载角色目录行贡献的稳定 `delegate` 与 `list_subagents` schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Bundle 范围**——本包提供产品 profile 和仓库启动器；可执行文件与安装程序由[桌面应用](../../../apps/desktop/README.zh.md)负责。
- **默认状态独立**——Session、设置和凭据保持隔离；只有用户选定的 skill 文件夹会共享，启动器不会复制其他原有状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 本 bundle 只修补产品自有行，并保持所有共享 API 与包标识不变。

不发布运行时不变式 companion；本包是静态产品 patch 层，插入行各自拥有其运行时关系与不变式 companion。
