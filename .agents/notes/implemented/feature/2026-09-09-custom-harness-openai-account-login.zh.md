# Agent Note: Custom Harness OpenAI 账户登录

Status: implemented

[English](2026-09-09-custom-harness-openai-account-login.md) | 中文

## 问题

Custom Harness 已提供 API-key provider 表单，但没有产品界面来使用已安装 pi-ai provider 支持的 OpenAI 账户登录。在浏览器中重新实现 OAuth 会把 token exchange 与存储移入不可信的展示层；仅增加 OpenAI API-key 表单也无法满足基于账户的 ChatGPT subscription access。成功获得 grant 后还需要让 Codex 模型可选，而不要求用户随后手动编辑 `settings.yaml`。

## 决策

Custom Harness 产品 bundle 挂载现有的中立 `authorization` service。继承的 dormant `llm-pi-ai` adapter 会在尚未配置任何 provider route 时，通过该 seam 注册 `llm-pi-ai/openai-codex` OAuth flow。

`dsh-api-settings-controller` 拥有一个窄的 `openAIAccount` Remote namespace。其 `describe` 方法只投影可用性与状态标志。`signIn` 选择 OAuth 与 browser login，只接受 HTTPS 授权目标，通过 Host native-command 边界打开它，并等待 provider 的 localhost callback。pi-ai flow 仍是 OAuth grant 的唯一 writer。authorization service 确认 record 写入后，controller 向现有 `llm-pi-ai` settings namespace 添加 `providers.openai-codex`。`signOut` 删除对应 record 与 route。

Custom Harness brand client 使用 `settings.models.footer` 放置本地化账户卡片。它通过注入 callback 呈现未连接、等待、已连接、失败与退出状态，永远不会收到 credential payload。关闭等待对话框会中止 Remote 请求和 authorization attempt。

## 考虑过的替代方案

- **直接在 React 中实现 OAuth**——已拒绝，因为浏览器将负责 PKCE、callback handling、refresh-token persistence 与 provider-specific behavior，而这些已由 pi-ai 拥有。
- **通过 Remote 暴露完整的中立 authorization 对话**——已延期，因为当前产品只需要 Windows browser-login 路径。通用 prompt/notice transport 会增加目前没有调用者的 device-code 与任意 provider UI。
- **在 settings 中存储 grant**——已拒绝，因为 settings 属于配置，可能被渲染和编辑，并不是 credential authority。
- **在授权完成前启用 route**——已拒绝，因为 selector 会提供无法请求的模型，并且取消登录后会留下误导性配置。
- **接受任意登录 URL**——已拒绝，因为 Host browser opener 是安全边界；账户登录只允许注册 flow 产生的 HTTPS 目标。

## 后果

用户可以在 Settings > Models 使用 OpenAI 账户登录，并在浏览器 callback 完成后看到支持的 Codex 模型。OAuth material 保留在 Custom Harness credential store 中，不跨越 Remote response、settings document 或 session log。退出登录会同时移除 grant 及其依赖的 provider route。界面目前自动选择 desktop browser method；headless device-code 与 manual-code presentation 不属于此产品界面。

聚焦的 Host、client、native-command 与 assembled-profile 测试覆盖脱敏状态、安全 URL 处理、provider 启用、取消、退出、操作系统浏览器分派与真实产品 slot/composition。
