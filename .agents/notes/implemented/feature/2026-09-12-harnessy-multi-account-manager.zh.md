# Agent Note: Harnessy 多账户管理器

Status: implemented

[English](2026-09-12-harnessy-multi-account-manager.md) | 中文

## Problem

Harnessy 可以授权一个 OpenAI 账户，但切换身份需要退出登录并替换唯一 canonical credential。拥有多个个人 provider 账户的用户无法查看当前身份、在本地保留另一个身份，或在切换前比较受支持的 quota window。假设所有 provider 都暴露相同 subscription usage API 也会产生误导数据。

## Decision

本决定部分取代 [Custom Harness OpenAI account login](2026-09-09-custom-harness-openai-account-login.zh.md) 中的单账户展示。其窄 `openAIAccount` compatibility namespace 仍然存在，而 Models settings seat 现在使用多 provider manager。

`dsh-api-settings-controller` 拥有 `accounts` Remote namespace 和版本化 `account-manager/accounts` credential record。该 record 是仅 Host 可见的 vault，包含 provider-owned credential record、本地标签、每个 provider 的一个 active account id，以及脱敏用量快照。canonical `llm-pi-ai/<provider>` record 仍是模型请求使用的 credential。激活账户会把 credential 从 vault 复制到该 canonical 地址，并启用对应 settings route。

第一组受管理 provider 包含 Codex (`openai-codex`)、GLM (`zai`)、Kimi (`kimi-coding`)、OpenCode (`opencode`) 和 Claude Code (`anthropic`)。Codex、Kimi 与 Claude Code 复用已安装 OAuth flow 和 HTTPS native-browser opening。GLM 与 OpenCode 直接把 API key 写入 credential provider。首次 describe 时会导入已有 canonical credential，因此不要求重新登录。

仓库对 pi-ai 的 loopback OAuth 结果页面应用 patch，使受支持的浏览器回调显示 Harnessy 标记、青绿色配色与产品文案。provider 授权、回调验证和 token exchange 行为仍由已安装的 provider flow 负责，此展示层不会更改这些行为。

Models footer 通过 settings section 的独占模态框 presenter 打开 manager。manager 的 body portal 可见期间，settings 外壳保持分区挂载但隐藏其界面框架；manager 完成时会关闭底层 Settings 面板。OAuth 等待界面使用同一套可见模态框所有权，因此 manager 与等待界面不会叠加。

当前只有 Codex 声明用量可用。每次打开 manager 都会调用 `refreshUsage`；Host 在 provider implementation 下刷新即将过期的 Codex OAuth credential，并请求经过认证的 quota window。其他 provider 仍可完整添加和切换，但不会返回虚构用量。client 将每个返回百分比从零动画填充到目标值，并为 reduced-motion 用户禁用 transition。

Remote response 只包含账户标签、provider id、active 状态、initial、时间戳与用量百分比。API key、access token、refresh token 与完整 credential record 永远不会跨越 Host 边界。

## Alternatives considered

- **用第二个独立账户文件替换 canonical credential file** — 拒绝，因为这会重复 credential provider 已拥有的存储、权限、锁与 refresh 责任。
- **让 browser 拥有账户 vault** — 拒绝，因为 browser storage 与 Remote response 随后会携带可复用 secret。
- **在首版 manager 暴露完整 authorization prompt protocol** — 延期，因为所选 OAuth provider 通过 native browser callback 或 provider device page 完成，而 API-key provider 有专用 secret input。
- **为每个 quota 抓取 provider dashboard** — 拒绝，因为这些页面不稳定，而且多个 provider 没有为第三方 client 发布受支持的 authenticated usage service。
- **在用户按 Refresh 前显示旧用量** — 拒绝，因为 manager 需要支持即时账户切换决策，所以每次打开都会自动 refresh。

## Consequences

用户可以为每个受支持 provider 保留多个账户，并通过一个动作切换新模型请求所用 credential。移除 active account 时，如果存在另一个已保存身份则会提升它，否则会禁用该 provider route。Codex quota window 会在打开时 refresh，也可以手动 refresh。provider-specific usage gap 会明确显示，而不是静默显示零。Accounts 操作会替换 Settings，而不是在其上叠加第二个可见对话框。

vault 有意复制 provider credential record，因此未来每次 provider-format migration 都必须保留 canonical record 与 managed copy。聚焦 Host 与 client 测试覆盖 canonical import、secret redaction、API-key account lifecycle、添加 OAuth 且不替换 active account、Codex quota parsing、打开时自动 refresh、切换与 animated bar。
