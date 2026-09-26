# Agent Note: 将已发布 Harnessy profile 从内置核心包副本迁移出去

Status: implemented

[English](2026-09-26-harnessy-legacy-profile-core-migration.md) | 中文

## Problem

Harnessy 0.1.5-alpha.1 曾把完整 Desktop 包集安装进外部插件 profile，并记录本地 tarball 依赖、overrides 与锁文件。Harnessy 0.1.7 已把运行时放在应用内部，但 Node 的最近包解析仍会选中 profile 中的 0.1.5 副本。混合版本会撤销当前 Typert 定义，使 Settings 无法激活，并让升级后的应用停在不可用页面。早先移除清理流程的决定假设没有已发布 Desktop 写入过这些残留；Harnessy 的已发布 profile 满足了该说明中的重新引入条件。

## Decision

Desktop 在 Host 启动前、持有现有 profile 锁时执行一次性兼容迁移。存在 `desktop-packages.json` 表示这是旧版已发布 profile，`desktop-core-packages-migrated-v1.json` 记录迁移成功完成。迁移在任何修改前校验旧版清单，只从 profile 与旧版 fallback 根目录删除清单列出的包名，从依赖区段及 pnpm overrides 中剪掉这些名称，并且只在包状态发生变化时丢弃锁文件。所有删除和元数据写入成功后才写入标记。

外部插件、bundle 选择、用户 patch、设置、凭据、MCP 配置、会话、附件与旧版清单文件保持不变。没有旧版清单的当前 profile 不会被修改。标记存在后恢复普通原生包优先级，包括用户之后安装的同名依赖。周期性清理仍按[清理移除决定](../simplification/2026-09-19-remove-desktop-profile-core-cleanup.zh.md)保持删除状态。

## Alternatives considered

**要求手动修复 profile。** 正常的原地应用升级不应打开不可用页面，也不应要求用户识别内部包目录。手动修复还会让已保存的应用数据看起来像是丢失，尽管它们仍然存在。

**每次生产启动都恢复清理。** 重复清理会移除迁移后安装的同名依赖，并持续使插件管理器状态失效。持久完成标记把兼容写入限定在由已发布旧版布局产生的 profile。

**让内置运行时获得绝对解析优先级。** 这会改变所有 profile 的既有插件依赖规则，并可能隐藏第三方插件刻意携带的版本。迁移只修复由旧版清单证明属于应用自身的残留。

## Consequences

从已发布旧版布局升级时，应用会以单一运行时版本启动，同时保留用户数据与外部插件。首次升级启动可能删除数百个过时包目录及旧锁文件；中断的迁移会重试，因为标记最后写入。依赖某个被移除顶层副本的插件可能需要在下一次包操作时重建自己的依赖，但插件包与激活选择仍然存在。定向测试固定了修改前校验、拒绝重定向目录、精确包剪除、用户包保留和一次性完成行为。
