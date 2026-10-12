# Agent Note: Desktop Host 的私有 Android 访问

Status: implemented

[English](2026-10-11-harnessy-android-companion.md) | 中文

## 问题

Android 手机需要查看并向 PC 上已运行的 agent 发送消息，也要支持离开本地 Wi-Fi 后使用。第二个 Web 进程不拥有这些活跃 agent，还可能争用 Desktop 的数据。网络可达性本身不能为工具型 Host 的调用者提供认证。

## 决策

可选私有网络浏览器功能复用现有 Desktop Host 经过认证的 Web 前端和 Session API。远程访问通过启动时的显式选择启用：固定的 loopback 端口，以及 PC 的 Tailscale DNS 主机名上的 HTTPS 根 URL。用户自行管理私有 Tailscale Serve 配置；Harnessy 不安装 VPN，也不创建公开路由。Desktop 保留独立的 loopback 登录和普通的仅供本机访问默认值。

所属 Desktop 应用可查询不含凭据的远端根地址，并请求 Main 进程把当前 Host 的配对 URL 复制到剪贴板。renderer 不能选择目标或接收凭据。Desktop 的 stdout 不打印含凭据的启动 URL。Host 替换和退出会使待完成的配对操作失效。

[浏览器启动令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)和[载体请求信任规则](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)继续作为权威。Tailscale 身份 header 和代理转发 header 不授予应用身份。配对后的手机拥有现有操作者的权限；移动布局不是仅限会话的授权层级。

## 考虑过的替代方案

**启动独立 Web profile。** 它无法连接现有进程的活跃 agent，还会为持久数据增加一个所有者。复用 Desktop Host 可保留单一进程所有者。

**把 Host 绑定到网络或发布公开隧道。** 所请求的离家访问不需要面向互联网的工具型服务器。私有 HTTPS 转发保留 loopback 监听器和现有认证。

**为每个动态端口自动管理 Serve。** 这会把应用启动与用户拥有的网络配置耦合，还可能替换其他应用的映射。显式固定端口可提供稳定转发，而不把 VPN 管理权限交给 Harnessy。

## 后果

PC 必须保持唤醒、联网并运行应用。手机是展示客户端，而不是 Android 执行运行时或离线 Session 缓存。复制的配对链接属于敏感信息，同步剪贴板也存在风险。cookie 保留现有有效期与撤销语义；从私有网络移除丢失手机是立即控制可达性的措施，不是 cookie 撤销。

[Desktop 私有浏览器配置](../../../../apps/desktop/README.zh.md#legacy-private-browser-access)指定由 PC 所有者验证真实代理、浏览器认证、重连和移动数据访问。静态验证不能确认这些结果。按[暂存工作流](../../../../HARNESSY-STAGING-DELIVERY.md#safe-builds)，源码变更必须先在应用完全退出后重新构建，才能启用。

[原生中继决策](2026-10-12-native-android-relay-authority.zh.md)拥有主要 Android 工作流，不拥有此可选浏览器功能。本记录与认证／请求信任说明仍保持活跃，因为各自独立的浏览器安全依据仍适用；取代关系仅是部分的。
