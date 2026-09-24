# Agent Note: Windows 托盘后台生命周期

Status: implemented

[English](2026-09-20-windows-tray-background-lifecycle.md) | 中文

## Problem

关闭 Harnessy 窗口也会停止 Desktop Host，因此用户从任务栏清除窗口后，活跃 Session 无法继续运行。如果在没有可靠窗口恢复入口的情况下保留进程，情况会更糟，因为用户可能失去对不可见应用的控制。

## Decision

Harnessy 会先安装 Windows 系统托盘图标，再启用后台模式。此后关闭主窗口会阻止窗口销毁并将其隐藏，而 Electron 进程、Desktop Host 与活跃 Session 会继续运行。选择托盘图标、选择 **Open Harnessy**、再次启动 Harnessy，或选择原生通知，都会恢复并聚焦同一个窗口。

托盘菜单通过 **Exit Harnessy** 提供显式关闭操作。Electron 会在窗口开始关闭前记录退出请求，通过既有异步关闭路径等待 Desktop Host 完全停止，允许窗口关闭，并在进程最终退出期间销毁托盘图标。

托盘创建是前置条件，而不是外观增强。如果 Windows 无法加载非空托盘图像或创建托盘对象，后台模式会保持禁用，关闭最后一个窗口将遵循正常退出路径。其他操作系统保留既有窗口生命周期。

## Alternatives considered

**始终通过窗口关闭控件退出。** 这样关闭语义明确，但当用户只是想从任务栏移除 Harnessy 时，也会中断活跃 Session。

**无需托盘也保持运行。** 这样可以保留工作，但可能留下无法访问的后台进程，并且没有可见的恢复或退出控件。

**增加后台模式偏好设置。** 偏好设置可以提供逐用户选择，但会增加另一种生命周期状态，而且仍然需要可靠的显式退出。Windows 一致采用由托盘保障的持续运行方式，而 **Exit Harnessy** 仍是当前进程的直接退出选择。

## Testing

聚焦生命周期测试证明：Windows 只有在托盘就绪后才隐藏主窗口；显式退出会禁用隐藏和后台保留；其他平台不会进入托盘支持的后台模式。Desktop 构建和打包后的 Windows 验证会覆盖 Electron 接线与图标资源。

## Consequences

主窗口关闭后，活跃 Session 会继续运行，托盘为用户提供稳定的恢复与退出控件。Harnessy 会继续消耗运行中 Session 所需的资源，直到用户选择 **Exit Harnessy** 或 Windows 结束进程。

后台持续运行依赖托盘成功创建。这个条件可以防止无声进程在所有用户可见控件消失后继续存活，并让关闭恢复继续使用既有 Desktop Host teardown 路径。
