# Custom Harness

[English](README.md) | 中文

Custom Harness 是由 [amAbdoMo](https://github.com/amAbdoMo) 维护的个人 Windows 桌面 AI harness。它基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，保留上游的插件化运行时，同时提供独立品牌、隔离的应用数据和紧凑的 Windows 安装程序。

此仓库用于备份定制应用的源代码和版本历史。稳定版本以安装程序形式发布在 [GitHub Releases](https://github.com/amAbdoMo/Harnessy/releases) 中。

## 项目目标

- 保留个人版本所使用的桌面 harness 功能和界面。
- 像普通 Windows 应用一样安装和启动，不显示终端窗口。
- 将 Custom Harness 数据与其他 Harness 安装隔离。
- 在 Git 中记录每次源代码调整，并为稳定版本提供可恢复的安装程序。
- 保留从上游 DeepSeek Harness 获取兼容修复和改进的能力。

<a id="run"></a>

## 在 Windows 上安装

Custom Harness 的个人发行版本当前面向 Windows x64。

1. 打开[最新版本](https://github.com/amAbdoMo/Harnessy/releases/latest)。
2. 下载名为 `CustomHarness-Setup-*-win-x64.exe` 的文件。
3. 运行安装程序，并在提示时选择安装目录。
4. 安装完成后启动 **Custom Harness**。

个人安装程序没有代码签名，因此 Windows SmartScreen 可能显示警告。运行前请确认安装程序来自此仓库的 Releases 页面。

## 使用应用

打开**设置**，配置需要使用的模型提供商和凭据。选择工作区，创建会话，选择模型和权限模式，然后在输入框中输入任务。

应用状态存储在 `%LOCALAPPDATA%\CustomHarness` 下。安装新版 Custom Harness 会继续使用同一产品数据目录；源代码和安装程序不包含本地会话或凭据。

Custom Harness 当前不会自动检查或安装更新。发布新版本后，请从 GitHub Releases 安装新版。

## 版本和备份流程

Git 提交保存每次源代码更改，版本标签标识稳定快照，对应的 GitHub Release 保存 Windows 安装程序。这样可以把完整开发历史与少量可安装版本分开管理。

个人应用数据不会提交到 GitHub。需要备份本地会话和设置时，请单独备份 `%LOCALAPPDATA%\CustomHarness`，并妥善保护其中保存的凭据。

<a id="run-from-source"></a>

## 构建个人安装程序

构建需要 Windows x64、Node.js 24 和 pnpm 11.7.0。

```powershell
git clone https://github.com/amAbdoMo/Harnessy.git
cd Harnessy
pnpm install --frozen-lockfile
pnpm run package:desktop:win:x64:local
```

未签名安装程序输出到 `apps/desktop/.desktop-build/targets/win-x64/artifacts/`。构建产物和已安装依赖不会提交到 Git，因此仓库只保存源代码，而不会重复保存生成文件。

上游签名打包命令保持独立，并会在缺少必要签名凭据时失败。`:local` 命令是此个人未签名 Windows 版本的明确构建路径。

## 开发检查

修改本地 Windows 打包流程后，运行：

```powershell
pnpm exec tsc -b tsconfig.host.json --pretty false
pnpm exec vitest run apps/desktop/tests/package-target.spec.ts apps/desktop/tests/macos-signature.spec.ts
```

GitHub 会在 Windows 上针对推送和拉取请求运行相同的桌面检查。继承的上游多平台、sandbox 和真实 API 工作流默认禁用，因为它们需要 DeepSeek 的运行器和密钥。

## 与 DeepSeek Harness 的关系

Custom Harness 是独立的个人衍生版本，不是 DeepSeek 官方产品。上游项目、文档和社区信息请访问 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

源代码继续使用 [MIT 许可证](LICENSE)。第三方依赖及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中。
