# Agent Note: Harnessy 共享技能文件夹

Status: implemented

[English](2026-09-12-harnessy-shared-skills-folder.md) | 中文

## Problem

Harnessy 会刻意把 DSH 与 agent home 重定向到 `%LOCALAPPDATA%\CustomHarness`，避免 Session、凭据和设置与其他 harness 冲突。此隔离也会重定向普通用户的 `.agents\skills` 根目录，使为 Codex、Pi 或其他兼容 agent 安装的个人 skill 无法出现在 Harnessy 中。

## Decision

`custom-harness` profile 挂载一个名为 `harnessy-shared-skills` 的全局 `skill-filesystem` 实例。其由设置管理的自定义根目录默认为 `%USERPROFILE%\.agents\skills`，而 preset 作用域的文件系统 provider 继续使用 Harnessy 的私有 DSH 与 agent 根目录。共享 provider 本身不包含默认项目、用户或内置根目录。

`harnessy-shared-skills` 设置命名空间保存一个 `enabled` 布尔值和一个绝对 `directory`。Settings > General 通过开关、原生文件夹选择器和恢复默认操作公开这些值。设置更改被接受后，只会在关闭旧 watcher 后替换全局共享 provider，因此无需重启应用即可更改发现目录。

项目 `.dsh\skills` 与 `.agents\skills` 根目录保持高于自定义根目录的现有优先级。因此项目专属 skill 会覆盖同名个人 skill，而所选共享根目录仍可用于每个 Harnessy preset 和 workspace。

## Alternatives considered

- **把 Harnessy 的整个 agent home 指向 `%USERPROFILE%\.agents`** — 放弃，因为这也会合并产品自有状态，削弱刻意设置的应用数据边界。
- **把 skill 复制进 Harnessy 的私有 home** — 放弃，因为副本会漂移，并需要反复手动同步。
- **硬编码共享目录且不提供设置** — 放弃，因为用户需要在不重新构建 Harnessy 的情况下关闭共享，或选择另一组兼容 skill。

## Consequences

Harnessy 只共享所选 skill 目录；Session、设置、账户与凭据仍属于产品私有数据。新增、重命名、删除或编辑的 skill 定义会通过文件系统监视变得可见，文件夹更改也会实时生效。此功能新增一个全局 skill provider 和一个持久设置命名空间，因此测试覆盖 provider 替换、禁用、无效路径、取消文件夹选择以及只读 UI 行为。
