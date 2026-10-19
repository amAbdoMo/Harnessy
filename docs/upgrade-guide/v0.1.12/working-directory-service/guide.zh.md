---
kind: upgrade-guide
description: "自定义文件系统、shell 和钩子组合需要工作目录服务。"
---

# 自定义组合中的工作目录服务

[English](guide.md) | 中文

## 变更

支持当前目录的文件系统、shell、LSP、技能、终端、钩子、mod、浏览器 MCP 和委派插件需要 `@deepseek-ai/dsh-working-directory`。它们使用 Session 的有效执行目录，而不是只读取原始项目目录。共享 base bundle 会挂载此服务；自定义组合必须显式提供。

Session 目录变更现在追加必读的 `working-directory/change` 事件，而不是修改 `Session.header.cwd`。头部仍持有原始项目、设置、工作区及沙箱权限依据。不识别该必读事件的旧构建必须拒绝日志；不要将已变更的 Session 降级后在原始目录执行。仅读取旧有或无头部目录的回退值、列出 Session 或首次组装提示词，不会追加初始值或触发迁移。头部及历史文件均不会被重写或移动。

TypeScript 为 `HarnessSession` 与 `HarnessClient` 添加 `getWorkingDirectory` / `setWorkingDirectory` 方法；Python 为 `Session` 与 `HarnessClient` 添加对称的 `get_working_directory` / `set_working_directory` 方法。配套运行时提供 `session/working-directory/get` 与 `session/working-directory/set`。显式操作可以创建未知 Session；get 会校验目录，并可恢复消失的选择。现有进程保留其启动目录。

## 迁移

1. 在自定义组合中添加 `@deepseek-ai/dsh-working-directory`，同时提供文件系统、Session 投影注册表和系统提示词服务。
2. 保留原始项目作为权限根目录；改变当前目录不会授予额外访问权限。
3. 使用包含两种目录方法的配套 SDK 与运行时产物。仅集成源码不会部署应用或更新已安装的 Python 运行时 wheel 包。
4. 确认 Agent 可以执行基于目录的操作，且其当前目录出现在必需用户上下文中。自定义 `{{cwd}}` 提示词模板在组装期间刷新，而不替换其文本；可选功能保持关闭。
5. 选择现有目录并读取返回值，确认存在 `working-directory/change` 事件且原始头部不变。删除所选目录，确认恢复到可用的原始根目录；目录未变的读取不得增加转换记录。后续操作使用有效目录，但现有 shell 和终端不会移动。

6. 切换目录前退出 Auto review，并等待已审查调用完成；其[目录限制](../../../../packages/experimental/auto-review/README.zh.md#known-limitations-and-deferred-work)同样适用于直接调用目录服务。

配置、重放与恢复的说明见[服务参考](../../../../packages/session/working-directory/README.zh.md)；必读事件的处理见[兼容性确认记录](../../../persistence-changes/2026-10-17-working-directory-transitions.zh.md)。
