# Agent Note: Custom Harness Workspace Brief as a bounded human command

Status: implemented

English | [中文](2026-09-08-custom-harness-workspace-brief.zh.md)

## Problem

Custom Harness needed one useful end-to-end product action that demonstrates its extension architecture without granting a new model capability or creating another persistence authority. A workspace summary can expose repository names, paths, status, and manifest contents, so an unconstrained implementation could escape the selected workspace, read excessive data, follow symbolic links, or repeat side effects after reconnect. A browser-only summary would also bypass host filesystem and sandbox policy, while a generated file would add write and cleanup behavior that the product did not require.

## Decision

Workspace Brief is a human command with separate host and browser plugins, enabled only by the Custom Harness product bundle.

- `dsh-workspace-brief` registers `/workspace-brief [--git]`. It accepts no path, resolves the exact session cwd through `ctx.workspaceRegistry`, and rejects missing, unregistered, unavailable, or non-Git workspaces before producing a result.
- The runner observes the top-level inventory and a regular, non-linked `package.json` through `ctx.fs`. It runs one constant Git command through `ctx.shell` with the current read-only sandbox policy. Independent limits cover elapsed time, manifest bytes, Git bytes, inventory rows, status rows, field length, and final Markdown length.
- Manifest failure is partial because repository identity and Git facts remain valid; workspace, permission, Git, cancellation, and timeout failures settle separately. Explicit retries repeat only read operations and create another ordinary command lifecycle.
- `dsh-client-ui-workspace-brief` contributes one open-session header action and one keyed command card. The action prevents concurrent duplicate dispatch, while the card folds `command/run` and `command/done` so reload and reconnect display recorded output without rerunning inspection.
- The command events are log-only and never enter model history. The feature adds no database, file, network request, model tool, or model invocation.

## Alternatives considered

- **Run the inspection in the browser** — rejected because the browser has no authoritative workspace, filesystem, or sandbox capability and would duplicate host policy.
- **Write `WORKSPACE-BRIEF.md` into the repository** — rejected because the brief is presentation state; a file would mutate user content, require overwrite policy, and create cleanup and retry semantics.
- **Expose a model tool** — rejected because Phase 5 authorizes a human product action, not a new model capability. A tool would require separate capability, prompt, permission, and model-experience review.
- **Create a Workspace Brief database** — rejected because the command lifecycle already provides durable per-session replay and pairing; another store would introduce synchronization and deletion ownership.
- **Accept arbitrary paths or recursive discovery** — rejected because the session's registered workspace is the product boundary and top-level bounded facts satisfy the brief.

## Consequences

The feature crosses real product UI, Remote command dispatch, host policy, filesystem and shell capabilities, and durable session presentation while remaining removable as two plugin rows. Users receive a stable point-in-time summary and explicit partial-data labels; retries cannot change workspace contents. The fixed bounds omit deep project structure, full diffs, and large status sets, and the header action intentionally produces the default no-status form. Focused tests pin success, validation, failure classification, cancellation, replay, idempotency, and plugin disable/re-enable behavior.
