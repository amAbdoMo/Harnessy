# Agent Note: 作为产品 profile 层的 Custom Harness 身份

Status: implemented

[English](2026-09-08-custom-harness-brand-identity.md) | 中文

## 问题

此 fork 需要独立的可见身份和可写状态，同时继续把 DeepSeek Harness 保留为可升级框架。品牌分散在构建时文档元数据、PWA 安装元数据、外壳 slot 回退、首次运行声明和 profile 组合中。仓库级全局重命名会破坏包名、模型提供方身份、协议、法律声明和上游合并能力；复用 `DSH_HOME` 则会让原版与定制产品覆盖彼此的设置和会话。

## 决策

Custom Harness 是一个命名构建与运行时 profile，以现有 Web 应用之上的窄层实现。

- `scripts/custom-harness-product.ts` 是显示名称、slug、Windows 标识、协议、文件系统目录名、产品链接、manifest 短名称和图标路径的权威身份记录。`custom-harness` 客户端构建 profile 会把其中公开的子集投射到浏览器产物。
- `dsh --profile custom-harness` 依次组合 `dsh-base`、`dsh-web-app` 和 `dsh-custom-harness`。最后的 patch 只禁用原有品牌和反馈行，插入 `dsh-client-ui-brand-custom-harness`，并提供面向产品的 Web 命令帮助。
- 客户端包占据侧栏标志与名称、会话首屏标志与说明、通用设置 About 行和主题 token seam。其可逆的明暗配色通过语义 token 改变共享表层，保留蓝色发送操作和标准状态色，并为键盘焦点添加清晰轮廓、为选中会话添加紫色导轨。“穿线光圈”标志在所有尺寸下均为 SVG，本地化首次运行文案会标识独立预览版，但不改变面向模型提供方的 DeepSeek 名称。
- `scripts/run-custom-harness.ts` 会忽略环境中的 `DSH_HOME`，默认选择 `%LOCALAPPDATA%\CustomHarness\Harness`，并使用同级 Logs 与 Cache 目录。产品专属覆盖可用于测试和托管部署；不会自动导入原版状态。
- 静态源 manifest 与原有品牌包保持不变。只有命名产品构建会通过构建时转换生成 Custom Harness 标题、favicon 与 PWA 元数据。

## 考虑过的替代方案

- **全局搜索替换**——否决，因为内部包 ID、模型提供方名称、API 合同与声明是兼容性表层，而不是产品界面文案。
- **直接修改原有 Web bundle**——否决，因为原版与定制应用必须共存，并继续从同一源码树构建。
- **复用 `DSH_HOME`，只添加 UI 标签**——否决，因为缺少状态隔离的身份会允许跨产品设置和会话冲突。
- **创建第二套应用运行时**——否决，因为 profile 与 slot 系统已经提供预期扩展 seam；另一套启动栈会重复框架行为。

## 后果

两个 profile 可以在独立根目录中初始化并重启，而产品品牌仍是可移除的最终 bundle 层。共享的交互、流式输出、会话、审批、附件、重连和错误路径继续由原有 owner 管理；定制层只改变展示与 slot 内容。此 fork 保留上游包身份与法律身份，定制浏览器构建中的所有可见产品值都可追溯到集中管理的构建记录。桌面可执行文件、安装器、任务栏和协议注册值已经记录，但在桌面打包表层出现之前仍属延期项。
