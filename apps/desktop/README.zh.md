# `@deepseek-ai/dsh-custom-harness-desktop`

[English](README.md) | 中文

此私有包是 Custom Harness profile 的 Windows Electron 宿主。Electron 主进程拥有一个原生窗口和一个已构建的 `dsh --profile custom-harness` 后端；它不会交付另一份前端，也不会暴露 preload bridge。

## Source execution

先用 `npm run build:custom-harness` 构建定制产物，将 `CUSTOM_HARNESS_ELECTRON_EXECUTABLE` 指向一个经过明确审计的 Electron 44.2.0 可执行文件，再运行 `npm run custom-harness:desktop`。启动器也接受项目中精确安装的运行时；它不会下载或选择任意缓存归档。

启动器默认使用 `%LOCALAPPDATA%\CustomHarness`，并接受既有的 `CUSTOM_HARNESS_DATA_DIR`、`CUSTOM_HARNESS_HOME`、`CUSTOM_HARNESS_AGENTS_DIR`、`CUSTOM_HARNESS_LOG_DIR` 与 `CUSTOM_HARNESS_CACHE_DIR` 测试／开发覆盖值。它会在打开宿主前验证 `.dsh-build/client-build-environment.json`。

## Windows packaging

`npm run package:custom-harness:win` 从干净的检出构建 NSIS x64 安装程序。打包要求 `CUSTOM_HARNESS_NODE_RUNTIME` 指向经过审计的 Node.js 24.19.0 Windows 运行时，`CUSTOM_HARNESS_ELECTRON_DIST` 指向经过审计的 Electron 44.2.0 分发包，并要求 `CUSTOM_HARNESS_PUBLISHER_NAME` 包含产品所有者准确的法定发布者名称。打包配方固定 electron-builder 26.15.7 与 pnpm 11.7.0。

成功构建后会写入 `apps/desktop/dist/CustomHarness-Setup-0.1.2-rc.1-windows-x64.exe`，并在旁边生成 JSON 清单，记录源代码、输入、校验和、产物扫描及 Authenticode 状态。未签名产物始终标记为 `UNSIGNED`，且不具备分发条件。自动更新与便携版目标均未启用。

## Installed data

不可变的应用资源保留在所选安装目录内。会话、设置、凭据及 Harness 状态使用 `%LOCALAPPDATA%\CustomHarness\Harness`；技能使用 `%LOCALAPPDATA%\CustomHarness\Agents`；Electron profile 数据使用 `%LOCALAPPDATA%\CustomHarness\Cache\DesktopUserData`；桌面诊断信息使用 `%LOCALAPPDATA%\CustomHarness\Logs`。

NSIS 卸载配方默认保留这些产品自有数据。桌面诊断日志在 1 MiB 时轮转，并保留三个归档。包级生命周期测试证明，更改或删除模拟安装目录后，代表性的产品自有状态仍然完整；发布版本仍须完成干净机器上的安装、升级与卸载验证。

## Lifecycle and failure behavior

Electron 在启动后端之前取得单实例锁。后端绑定 `127.0.0.1:48765`，发出带认证信息的就绪 URL，并运行在 Windows Job 启动器之下。启动超时、端口冲突、提前退出、产品产物不匹配、后端崩溃及持续健康失败都会显示“重试／退出”恢复；“File → Open in Browser”会复用带认证信息的服务 URL。

关闭窗口会退出应用并停止 Job 所有者。本产品有意不提供托盘生命周期。浏览器打开失败时服务继续运行，因此可以重试该命令。

## Security

BrowserWindow 启用上下文隔离和沙箱，同时禁用 Node 集成与 webview。应用没有 preload 脚本。权限请求全部拒绝，窗口导航限制在当前回环源，外部 HTTP(S) 目标通过系统浏览器打开，启动令牌会从桌面诊断信息中清除。

## Windows helper license

`native/windows-job-launcher.cs` 改编自 MIT 许可的 DeepSeek Harness Desktop 包装器。原始声明与条款保留在 [`third-party-licenses/deepseek-harness-desktop-LICENSE`](third-party-licenses/deepseek-harness-desktop-LICENSE)。

## Model Experience

桌面宿主不会改变 prompt、工具、模型上下文、会话或命令执行。桌面与浏览器客户端使用同一个定制后端和 Web 应用；原生生命周期故障不会进入模型可见的对话内容。
