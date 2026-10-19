---
kind: upgrade-guide
description: "Custom filesystem, shell and hook compositions require the working-directory service."
---

# Working-directory service in custom compositions

English | [中文](guide.zh.md)

## Change

Directory-aware filesystem, shell, LSP, skill, terminal, hook, mod, browser MCP and delegation plugins require `@deepseek-ai/dsh-working-directory`. They use a Session's effective execution directory rather than reading only its original project directory. The shared base bundle mounts the service; custom compositions must provide it explicitly.

Session directory changes now append mandatory `working-directory/change` events instead of changing `Session.header.cwd`. The header remains the original project, settings, workspace and sandbox authority. Older builds that do not recognize this required event must refuse the log; do not downgrade a changed Session to execute it in its original directory. Merely reading a legacy or headerless fallback, listing Sessions or assembling the first prompt does not append an initial value or trigger migration. No header or historical file is rewritten or moved.

TypeScript adds `HarnessSession` and `HarnessClient` methods `getWorkingDirectory` / `setWorkingDirectory`; Python adds symmetric `Session` and `HarnessClient` methods `get_working_directory` / `set_working_directory`. The matching runtime serves `session/working-directory/get` and `session/working-directory/set`. Explicit operations may create an unknown Session; get validates the directory and can recover a missing selection. Existing processes retain their startup directories.

## Migration

1. Add `@deepseek-ai/dsh-working-directory` to custom compositions alongside the filesystem provider, Session projection registry and system-prompt service.
2. Keep the original project as the permission root; changing the current directory does not grant additional access.
3. Use matching SDK and runtime artifacts containing both directory methods. Source integration alone does not deploy an app or update an installed Python runtime wheel.
4. Confirm that an Agent can execute a directory-based operation and that its current directory appears in required user context. Custom `{{cwd}}` prompt templates refresh during assembly without replacing their text; optional features remain disabled.
5. Select an existing directory, read it back, and verify a `working-directory/change` event while the original header remains unchanged. Remove the selected directory and confirm recovery to an available original root; unchanged reads must add no transition. Future operations use the effective directory, but existing shells and terminals do not move.

6. Leave Auto review and wait for reviewed calls to finish before changing directories; its [directory restriction](../../../../packages/experimental/auto-review/README.md#known-limitations-and-deferred-work) also applies to direct directory-service calls.

See the [service reference](../../../../packages/session/working-directory/README.md) for configuration, replay and recovery, and the [compatibility acknowledgement](../../../persistence-changes/2026-10-17-working-directory-transitions.md) for required-event handling.
