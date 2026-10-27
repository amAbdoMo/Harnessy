---
kind: upgrade-guide
description: "`dsh plugin` no longer accepts `--profile` after forwarded pnpm arguments and uses its own help before the pnpm command."
---

# `dsh plugin` option placement

English | [中文](guide.zh.md)

## Change

`dsh plugin` now reads `--profile <name>` before the first forwarded pnpm argument. Previously, scripts could place `--profile` after pnpm arguments, and `-h` or `--help` could reach pnpm even when the caller expected the forwarder's help. This affects scripts that manage profile packages and users requesting pnpm help through `dsh plugin`.

Once a pnpm command starts the forwarded arguments, every later token reaches pnpm verbatim, including `-h`, `--help`, and `--profile`. If forwarded arguments start with a pnpm option such as `--filter <selector>`, `-h` and `--help` still print the `dsh plugin` help until a pnpm command starts.

## Migration

1. Put `--profile <name>` before pnpm arguments. For example, use `dsh plugin --profile <name> add <package>` instead of `dsh plugin add <package> --profile <name>`.
2. To show a pnpm command's help, put `--help` after the command, as in `dsh plugin --profile <name> add --help`. To show pnpm's general help, use `dsh plugin --profile <name> help`.
3. Confirm that `dsh plugin --help` prints the forwarder's usage and that the commands from steps 1 and 2 reach pnpm.
