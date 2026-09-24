# Agent Note: Custom Harness fork CI

Status: implemented

English | [中文](2026-09-09-custom-harness-fork-ci.zh.md)

## Problem

The inherited default-branch workflows assume DeepSeek-owned API secrets, self-hosted runners, and multi-platform release maintenance. Running those jobs automatically in the personal Windows fork produces failures and indefinitely queued checks that do not describe the supported Custom Harness build.

## Decision

[Custom Harness Windows](../../../../.github/workflows/custom-harness-windows.yml) is the automatic push and pull-request workflow for this fork. It runs on a hosted Windows x64 runner without product credentials, type-checks the desktop host, and exercises the focused packaging-policy tests that distinguish the personal unsigned installer from the signed upstream release path.

Inherited master, sandbox, and real-API workflows keep their manual triggers and source definitions for upstream synchronization diagnostics. Their automatic jobs run only when the repository variable `CUSTOM_HARNESS_RUN_UPSTREAM_CI` equals `true`; enabling the variable also requires the matching secrets, runner capacity, and multi-platform maintenance intent.

## Alternatives considered

**Delete the inherited workflows.** This would simplify the Actions list but make upstream synchronization harder by removing useful reference automation from the fork.

**Configure all upstream infrastructure.** This would preserve every upstream signal but requires private API credentials, dedicated runners, and macOS/Linux maintenance that the Windows-only personal product does not need.

**Ignore the red checks.** Persistent unrelated failures make the latest supported revision difficult to distinguish from an actual desktop regression.

## Consequences

The default GitHub signal describes the Windows desktop product and remains keyless. Upstream multi-platform or live-service regressions are not checked automatically in this fork; maintainers must deliberately enable and provision those workflows when diagnosing an upstream merge.
