# Agent Note：Harnessy MCP 管理器

状态：已实现

[English](2026-09-13-harnessy-mcp-manager.md) | 中文

## 问题

MCP client 原本需要声明式 Loader 配置。Harnessy 的个人 Windows 用户需要可复用的可视化流程，用来保存多个本地或远程服务器、检查状态与工具，并在无需编辑配置文件或重启应用的情况下启用或移除它们。

## 决策

Settings controller 持有一个全局 `mcpManager` Remote namespace，并在 Harnessy credential provider 中保存带版本的服务器 registry。浏览器响应只包含显示字段、非 secret 启动字段、是否存在认证、实时状态和工具名称。HTTP authorization 值与 stdio 环境值绝不会返回 renderer。

启用的 profile 通过 `startManagedConnection` 启动，与声明式插件条目使用相同 MCP 生命周期。它预留 `mcp__<serverName>__*`、监督重连、报告连接快照，并在释放时同时注销工具与 namespace。controller 会串行执行保存与协调，在组合完成时启动已保存且启用的 profile，并且只重启完整受保护记录发生变化的 profile。

Settings > MCP Servers 支持 HTTPS 的 Streamable HTTP（本地开发可使用 loopback HTTP）与直接 stdio 命令。页面提供添加、编辑、测试/重启、启用/禁用、移除、实时状态与已发现工具控制，并在挂载期间每三秒轮询一次脱敏状态。

## 考虑过的替代方案

- **只继续使用 `cordis.yml`**——拒绝，因为日常个人使用需要技术性文件编辑与重启。
- **把 secret 保存在浏览器 settings**——拒绝，因为已渲染 settings 与浏览器状态不是 authorization 值的正确信任边界。
- **创建无关的连接实现**——拒绝，因为它可能绕过 namespace 冲突保护，并偏离 MCP 重连与释放行为。
- **通过新 event protocol 推送每次状态变化**——延期，因为有界轮询更简单，而且状态只在 Settings 页面可见时相关。

## 后果

已启用保存 profile 的 MCP 工具对所有 Harnessy session 全局可用，并使用既有的服务器限定命名契约。secret 保留在应用本地 credential store，但同一 Windows 用户身份运行的进程仍可读取，因此这是本地保护而不是远程 secret manager。远程 profile 不能在 URL 中嵌入凭据或 fragment，非 loopback HTTP 会被拒绝。工具注册期间，其 schema 仍会向模型请求贡献 token；禁用或移除服务器会注销这些工具。
