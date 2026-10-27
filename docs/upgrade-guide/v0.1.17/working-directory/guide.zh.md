---
kind: upgrade-guide
description: "文件系统结果使用操作时的规范路径，嵌套 PTC 调用也会计算工具展示元数据。"
---

# 更新依赖目录的工具集成

[English](guide.md) | 中文

## 变更

文件系统工具结果标识操作实际使用的规范路径。Shell 结果记录其启动目录。Session 更改目录后，这些记录仍使历史链接指向原来的目标；原始项目与权限根目录保持不变。

工具的 `output.presentationMeta` 也会对成功的嵌套 PTC 调用执行。投影失败时，该嵌套调用以 `ToolOutputError` 拒绝。元数据是可选的持久化展示数据；规范程序值与模型内容保持各自已有的职责。缺少元数据的旧记录仍可读取。

子智能体启动会在异步准备之前捕获请求的目录。现有进程保持其启动目录，Harnessy 仍支持已配置的提供方目录覆盖。

## 迁移

1. 读取文件系统或 Shell 结果的集成应使用已记录的规范路径或 `cwd`，不要用 Session 后来的目录解析旧参数。对缺少此类证据的旧记录保留安全的回退行为。
2. 保持自定义 `output.presentationMeta` 投影为纯函数，并返回可安全序列化为 JSON 的数据。分别执行原生调用与嵌套 PTC 调用，确认元数据标识实际操作目标且不改变结果。
3. 使用[工作目录服务](../../../../packages/session/working-directory/README.zh.md)读取有效目录；使用 `Session.header.cwd` 标识原始项目。确认新子智能体从选定目录启动，而现有终端保持其启动目录。

新增持久化元数据已在[持久化记录](../../../persistence-changes/README.zh.md)中确认，无需重写用户数据。
