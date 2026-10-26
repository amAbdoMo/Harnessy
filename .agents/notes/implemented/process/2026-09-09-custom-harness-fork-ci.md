# Agent Note: Custom Harness fork CI

Status: implemented

English | [中文](2026-09-09-custom-harness-fork-ci.zh.md)

## Problem

The inherited default-branch workflows assume DeepSeek-owned API secrets, self-hosted runners, and multi-platform release maintenance. Running those jobs automatically in the personal Windows fork produces failures and indefinitely queued checks that do not describe the supported Custom Harness build.

## Decision

[Harnessy Windows](../../../../.github/workflows/custom-harness-windows.yml) runs automatically for `master` pushes and pull requests, with manual dispatch also available. Its focused hosted Windows x64 checks need no product credentials and retain the normal Harnessy build, including complete Host and Client type checks, alongside product, saved-setting, browser-account, recovery, and packaging-policy checks. A manual run, or a `master` push whose head commit contains `[build-installer]`, also builds the unsigned Windows x64 installer, executes the packaged-runtime verification, and uploads the resulting files as a workflow artifact. A failed packaging run reports its newest redacted packaging journal in the check annotation and preserves the complete journal with the installer log in a diagnostic artifact. The successful installer artifact remains distinct from the signed upstream release path and is not uploaded to an update feed.

Inherited pull-request, master, sandbox, and real-API workflows keep their source definitions and existing manual triggers for upstream synchronization diagnostics. Their automatic jobs run only when the repository variable `CUSTOM_HARNESS_RUN_UPSTREAM_CI` equals `true`; enabling the variable also requires the matching secrets, runner capacity, and multi-platform maintenance intent. The inherited pull-request aggregate carries the same opt-in as its workers and is skipped when those optional checks are disabled.

## Alternatives considered

**Delete the inherited workflows.** This would simplify the Actions list but make upstream synchronization harder by removing useful reference automation from the fork.

**Configure all upstream infrastructure.** This would preserve every upstream signal but requires private API credentials, dedicated runners, and macOS/Linux maintenance that the Windows-only personal product does not need.

**Ignore the red checks.** Persistent unrelated failures make the latest supported revision difficult to distinguish from an actual desktop regression.

## Consequences

The default GitHub signal describes the focused Windows desktop product and remains keyless; it does not claim exhaustive coverage or the complete inherited platform matrix. A maintainer can obtain a verified unsigned installer from a manual workflow run without preparing a local Visual Studio toolchain. Upstream multi-platform or live-service regressions are not checked automatically in this fork; maintainers must deliberately enable and provision those workflows when diagnosing an upstream merge. The supported normal build owns both complete aggregate checks under the [artifact-build policy](2026-10-05-pr-artifact-typechecks.md), without a duplicate standalone Host compile.
