# Agent Note: Custom Harness 采用上游桌面端

Status: proposed

[English](2026-09-09-custom-harness-upstream-desktop-adoption.md) | 中文

## Problem

上游 `dsh-v0.1.5-alpha.1` 引入了完整的 Electron 桌面应用，取代 Phase 8/9 的 Custom Harness 回环服务器外壳。上游外壳拥有更强的运行时边界：不打开监听端口、携带版本匹配的 Node 与 pnpm、安装已签名的离线包 seed、校验渲染进程 IPC 来源，并以可恢复的分阶段方式切换运行时版本。本次演练现已把 Custom Harness 身份、profile bundle、隔离数据根目录、禁用自动更新策略、Windows 图标与发布隔离接入该外壳。打包、已安装迁移和回滚验证仍未完成，因此本说明继续保持 proposed 状态。

## Proposal

采用上游 Desktop 应用作为唯一活动的桌面包，并为 Custom Harness 增加窄的产品配置接缝。该接缝必须在 base 与 Web bundle 之后选择 Custom Harness bundle，设置公开产品名、应用标识符、图标和产物名，解析产品自有的 Harness 与 Agents 根目录，并在签名更新元数据、迁移和恢复通过产品发布矩阵之前保持自动更新禁用。

Phase 8/9 的 JavaScript 外壳仅在演练期间保留为临时对照材料。当配置后的上游外壳具备等价的生命周期、数据归属、浏览器、故障恢复和打包覆盖后，删除它、Windows Job 启动器及已退役的 NSIS 配方。

产品接缝实现为一份共享的运行时/构建配置，由 Electron 主进程、打包配置、客户端构建与发布脚本共同使用。打包状态解析到 `%LOCALAPPDATA%\CustomHarness` 下；开发模式只接受显式的绝对路径覆盖。只要发布包集合包含 Custom Harness bundle，打包器就写入禁止发布标记，发布器会在访问 registry 前拒绝该标记。完成已安装验证并删除对照外壳后，本说明将取代早期的回环主机架构说明。

## Alternatives considered

**继续交付回环服务器外壳。** 这样短期改动较少，但会重复维护一个上游已有的实现；上游实现具有更小的网络攻击面以及更严格的运行时与包事务模型。

**原样采用上游 Desktop 包。** 这是合并基线，但会交付 DeepSeek Harness 身份与官方 profile，而不是独立品牌产品，并会重新启用 Phase 9 有意延期的更新器。

**把上游 Desktop 实现复制到另一个应用目录。** 这样不必增加配置接缝，却会产生两个大型外壳，必须同步接收安全、签名、协议与恢复修复。

## Acceptance criteria

- 一个包清单和一个 Electron 主入口负责桌面生产构建。
- 已安装渲染器包含 Custom Harness 品牌、Workspace Brief 以及两条反馈禁用配置。
- 外壳不打开监听端口，并保留沙箱、上下文隔离、IPC 来源校验、签名资源验证和分阶段发布恢复。
- 默认可写根目录继续隔离在 Custom Harness 产品根目录下，仅提供明确的测试覆盖值。
- 在单独实现签名更新决策之前，不显示自动更新 UI，也不执行后台检查。
- 干净 Windows 虚拟机通过签名安装、升级、重启、卸载、数据迁移和冷恢复回滚测试。

## Risks

官方 Desktop 包是新的开发者预览代码，其包 seed 假设所有第一方包共用同一发布版本。旧版本会打开无后缀的 Session V0 数据；候选版创建 V3 generation 后，仅降级二进制可能重新打开保留的 V0 generation，并在没有明显报错的情况下分叉历史。过早删除旧外壳会在上游外壳获得等价覆盖之前丢失已测试的故障与生命周期行为。
