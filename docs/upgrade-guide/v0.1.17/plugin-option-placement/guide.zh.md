---
kind: upgrade-guide
description: "`dsh plugin` 不再接受写在 pnpm 转发参数之后的 `--profile`，并会在 pnpm 命令之前显示自己的帮助。"
---

# `dsh plugin` 选项位置

[English](guide.md) | 中文

## 变更

现在 `dsh plugin` 会在第一个 pnpm 转发参数之前读取 `--profile <name>`。此前，脚本可以把 `--profile` 写在 pnpm 参数之后；即使调用方想看转发器的帮助，`-h` 或 `--help` 也可能传给 pnpm。受影响的是管理 profile 包的脚本，以及通过 `dsh plugin` 查看 pnpm 帮助的用户。

一旦 pnpm 命令开始转发参数，后续所有 token 都会原样传给 pnpm，包括 `-h`、`--help` 和 `--profile`。如果转发参数以 `--filter <selector>` 等 pnpm 选项开头，在 pnpm 命令开始之前，`-h` 和 `--help` 仍会显示 `dsh plugin` 的帮助。

## 迁移

1. 把 `--profile <name>` 放在 pnpm 参数之前。例如，使用 `dsh plugin --profile <name> add <package>`，替代 `dsh plugin add <package> --profile <name>`。
2. 要查看 pnpm 命令的帮助，把 `--help` 放在该命令之后，例如 `dsh plugin --profile <name> add --help`。要查看 pnpm 的总体帮助，使用 `dsh plugin --profile <name> help`。
3. 确认 `dsh plugin --help` 会显示转发器用法，并且步骤 1、2 中的命令会到达 pnpm。
