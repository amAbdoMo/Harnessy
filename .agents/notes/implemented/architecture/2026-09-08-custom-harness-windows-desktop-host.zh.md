# Agent Note: Custom Harness Windows 桌面宿主

Status: implemented

[English](2026-09-08-custom-harness-windows-desktop-host.md) | 中文

## Problem

定制 Web profile 提供产品界面与经过认证的本地服务，但 Windows 桌面应用还需要一个原生生命周期所有者，统一负责就绪、聚焦、故障展示、浏览器交接以及后端进程树清理。通过同步源码包装器启动 CLI 无法提供这些保证。

## Decision

`apps/desktop` 是一个 Electron 主进程应用，拥有一个原生 BrowserWindow 和一个定制后端。它在启动后端之前取得 Electron 单实例锁，并在再次启动时恢复和聚焦现有窗口。在 Windows 上，只有托盘已经提供重新打开入口时，关闭主窗口才会让进程继续运行；后续的这项决策由 [Windows 托盘后台生命周期](../feature/2026-09-20-windows-tray-background-lifecycle.zh.md) 负责。

桌面服务以 `--profile custom-harness --host 127.0.0.1 --port 48765 --no-open` 启动已构建 CLI。它仅信任该精确回环端口上带认证信息的 `dsh web:` 就绪 URL，在导航前验证 Custom Harness manifest 与图标，将令牌仅保存在内存中，从诊断信息里清除令牌，并在启动后持续监控 manifest。

BrowserWindow 启用上下文隔离与沙箱，并禁用 Node 集成和 webview。应用没有 preload bridge。权限请求全部拒绝，窗口内导航限制在当前服务源，经过验证的 HTTP(S) 链接通过系统浏览器打开。

Windows 后端运行在一个保留 MIT 署名的原生启动器之下；该启动器改编自 `deepseek-harness-desktop` v0.3.8。启动器以挂起状态创建 CLI，将其分配给关闭即终止的 Job Object，然后恢复并等待；因此停止启动器会关闭 Job 句柄并终止所属后端进程树。

源码启动器会验证命名客户端构建记录与产物摘要，创建产品自有存储，在需要时编译 Job 启动器，并要求项目已安装的 Electron 可执行文件或显式提供、经过审计的开发可执行文件。打包后的入口从 Electron resources 目录解析不可变的 CLI、Node.js、辅助程序与图标资源，同时将 Harness 状态、agents、浏览器 profile 数据及有界桌面日志保存在 `%LOCALAPPDATA%\CustomHarness` 下。

Windows 打包配方从干净检出及固定的 Node.js、Electron、electron-builder 与 pnpm 输入生成一个按用户安装的 NSIS x64 安装程序。它在卸载时保留产品自有数据，包含项目、包装器、Electron 与 Chromium 声明，扫描解包应用中的私有材料，并在安装程序旁写入源代码／校验和／Authenticode 清单。自动更新与便携版目标均不存在。

## Recovery contract

启动超时、端口冲突、提前退出、定制产物不匹配、后端崩溃及持续健康检查失败进入统一的原生“重试／退出”流程。浏览器打开失败时服务继续运行并显示重试说明。托盘可用时，Windows 关闭控件会隐藏主窗口；托盘中的显式退出操作会在进程退出前停止后端。

## Alternatives considered

**原样采用社区包装器。** 其原生模式可复用，但它固定了较旧的标准 DSH 运行时，也没有目标产品的定制构建记录、启动后健康检查或恢复契约。

**构建 WebView2/.NET 宿主。** 仅安装 WebView2 运行时并不足够：此开发机器没有 WebView2 SDK、.NET SDK、MSBuild、Visual Studio 工具链或既有宿主项目，新建 bridge 还会重复隔离工作。

**保留纯浏览器启动器。** 它拥有最小的原生攻击面，但无法拥有产品要求的原生窗口、单实例聚焦或完整 Windows 进程生命周期。

**自动选择任意 Electron 缓存归档。** 这会便利开发启动，却绕开受支持版本与更新审查，因此源码启动器会在没有已安装或已审计运行时时明确失败。

## Testing

聚焦测试覆盖就绪验证、令牌清除、超时、产物不匹配、健康失败、单实例聚焦、浏览器交接、导航、渲染器设置、产品启动环境、有界日志轮转、分发包扫描、打包路径隔离，以及更换或删除模拟安装目录后代表性数据的保留。原生辅助程序通过 Windows .NET Framework 编译器构建；真实定制后端通过该辅助程序提供预期 manifest 与图标；竞争端口以 `EADDRINUSE` 失败；停止 Job 所有者会关闭服务。

受管任务宿主在渲染器启动前拒绝 Chromium AppContainer／缓存授权。严格沙箱下的原生渲染、缩放、聚焦、重复二次启动、浏览器共享、崩溃恢复展示以及重复干净退出仍是明确的目标机器检查；这一环境限制不构成削弱产品安全设置的理由。

## Consequences

Custom Harness 在不分叉 Web 应用、也不向渲染器暴露 Electron 权限的情况下获得一个原生 Windows 生命周期所有者。浏览器与桌面视图共享既有认证服务、会话存储和交互所有者。

桌面源码引入 Electron 发布维护、Chromium 声明、原生打包、代码签名、干净机器安装、升级、卸载和 Windows 目标验证等持续责任。固定本地端口让冲突恢复可预测，但应用运行期间会占用端口 48765。
