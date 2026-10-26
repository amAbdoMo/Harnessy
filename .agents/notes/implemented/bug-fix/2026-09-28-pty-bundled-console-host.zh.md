# Agent Note: Windows PTY 使用 node-pty 自带的控制台宿主

Status: implemented

[English](2026-09-28-pty-bundled-console-host.md) | 中文

## Problem

某些 Windows 控制台宿主把滚动后的 PowerShell 提示符重绘为 `\ndsh>\x1b[1C`，而不是受控的 `dsh> ` 尾部。已到达的尾部不是预期文本的前缀，因此即使看到了提示符标记，持久命令仍使用静默层级。更长的[尾部宽限](2026-09-27-pwsh-prompt-tail-grace.zh.md)有助于延迟到达的有效尾部，却无法修复这种格式错误的渲染。

## Decision

`subprocess-local` 仅在 Windows 上设置 node-pty 的 `useConptyDll: true`。PTY 由自带的 OpenConsole 渲染，而非操作系统控制台宿主；POSIX 分配保持不变。就绪判断仍要求受控提示符证据，并保留现有回退规则。

## Alternatives considered

**延长提示符尾部宽限。** 不采纳于此故障：尾部已经以非前缀形式到达时，永远无法满足该宽限延长的条件。

**规范化操作系统宿主的重绘序列。** 不采纳：这会让 sanitizer 依赖某个控制台渲染器的光标移动编码，而其他重绘形式仍未得到解决。

**要求更新的 Windows 宿主。** 不采纳：node-pty 已经提供可替换的控制台宿主，无需把运行时依赖转嫁给每次安装。

## Consequences

Windows 终端分配需要 node-pty 自带的 ConPTY DLL 与 OpenConsole 可执行文件。文件缺失或解包错误会使分配失败，不会回退到系统宿主。node-pty 把该选项标为实验性，因此依赖升级需要验证打包后的终端。SIGINT 仍是控制台级的 Ctrl-C 输入，PTY 报告的 pid 仍标识 shell。

## Testing

[提供方选项测试](../../../../packages/subprocess/subprocess-local/tests/local.spec.ts)要求 Windows 存在该选项，而 POSIX 不存在。[真实 Loader 组合](../../../../packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts)检查滚动后的提示符就绪、状态保留、退出和重启。[Desktop 文件策略](../../../../apps/desktop/tests/runtime-file-policy.spec.ts)固定所需文件；payload smoke 使用相同的 Windows 选项。这些检查分别负责源码、原生运行时和打包运行时验证。
