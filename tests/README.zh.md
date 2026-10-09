# 浏览器 e2e 测试

[English](README.md) | 中文

本测试套件使用 [e2e](https://e2e.tester.army/docs/quickstart.md)，通过真实的 Web host 测试 Harnessy。[配置](../e2e.config.ts)使用 ChatGPT `gpt-6-luna` 驱动浏览器操作。应用本身使用[不调用工具的已录制响应](../snapshots/web/deepseek-messages-chat/session.v3.jsonl)，而非在线模型提供商。

## 运行

[安装仓库依赖](../docs/development.zh.md)后，构建相互匹配的 host 和浏览器产物，并完成一次 ChatGPT 登录：

```sh
pnpm run build:custom-harness
npx e2e login openai
```

在仓库根目录运行测试套件：

```sh
npm run test:e2e:ui
```

[冒烟测试](example.e2e.ts)不调用模型。[对话测试](conversation.e2e.ts)连接 workspace、创建会话、发送消息，并检查页面重载后用户消息和助手响应是否仍在。要运行这一流程而不回放缓存的操作：

```sh
npx e2e run tests/conversation.e2e.ts --no-cache
```

已在 Node.js 24.14.0 下验证原生 Windows 执行。上游平台指南仍以[快速入门](https://e2e.tester.army/docs/quickstart.md)为准。

## 隔离与故障

运行器在分配的回环端口上启动已构建的 `dsh web` CLI（命令行界面），并在结束后停止它。每次 CLI 运行都在 Git 忽略的 `.e2e/` 目录下拥有独立的主目录和日志，并通过 `HARNESS_E2E_RUN_ID` 与其 worker 共享。每个对话测试拥有自己的 workspace，并负责删除它；主目录和日志产物保留用于诊断。[认证 fixture（测试前置数据）](support/harness.ts)仅交换所拥有服务器生成的启动 URL，不会从正在运行的 GUI 复制凭据或 cookie。服务器日志包含测试进程的启动 token，请勿公开这些日志。

`APP_URL` 让冒烟测试选择外部启动的应用；请在本地提供其已认证的启动 URL。对话测试拒绝外部目标。正在运行的 GUI 不会被替换。

陈旧的 host／浏览器构建可能导致「Failed to load plugins」；请使用上方命令重新构建。其他故障的截图、轨迹和步骤详情位于 `.e2e/` 下；使用 `npx e2e run --last-failed --reporter list,markdown` 查看。现有的真实 API `test:e2e` 脚本和 CI 任务保持不变。
