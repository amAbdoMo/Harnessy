---
description: "Custom Harness product patch layer for users and maintainers launching the independently branded Web profile."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-custom-harness`

English | [中文](README.zh.md)

## Summary

This package is the narrow product layer applied after `dsh-base` and `dsh-web-app` by the shipped `custom-harness` profile. It replaces the stock brand, disables per-message ratings and notes, and adds the bounded read-only Workspace Brief action without renaming shared framework packages, provider names, protocols, or compatibility surfaces.

## Use this package

Run `pnpm run build:custom-harness` once, then start the product with `pnpm run custom-harness -- --no-open`. The launcher selects `dsh --profile custom-harness` and replaces any ambient stock `DSH_HOME` with the product-owned home under the Custom Harness data directory.

The default Windows locations are `%LOCALAPPDATA%\CustomHarness\Harness`, `%LOCALAPPDATA%\CustomHarness\Logs`, and `%LOCALAPPDATA%\CustomHarness\Cache`. Product-specific `CUSTOM_HARNESS_*` variables may redirect them for testing or managed deployments; no stock state is imported automatically.

## Disabled per-message feedback

The profile disables both the `message-feedback` Host row and the `ui-message-feedback` client row. Consequently the browser does not offer Good response, Bad response, or Add a note actions, and direct `messageFeedback/list`, `messageFeedback/put`, and `messageFeedback/delete` Remote requests are unclaimed and return HTTP 404.

Per-message feedback has no model tool, so the tool roster needs no compatibility alias or tombstone. Existing session logs continue to open because ratings and notes live in a separate sidecar rather than the session event stream. The profile does not migrate or delete that sidecar.

The session-level `/feedback` command remains available. Telemetry feedback gating, authentication, approvals, permission presets, sandboxing, and filesystem policy are also unchanged; they are separate operational, privacy, and safety controls.

## Workspace Brief

The profile inserts the `workspace-brief` Host row and `ui-workspace-brief` client row. An open session can create a bounded Markdown summary of its selected registered Git workspace; typing `/workspace-brief --git` adds bounded short-status rows. The command accepts no arbitrary path, writes no files, performs no network or model request, and persists its result through the ordinary command log.

Disabling either row removes that half of the experience without changing stored sessions. A recorded brief remains readable through the generic command renderer when the specialized client row is absent; reconnect and restart never rerun repository inspection automatically.

## Model Experience

Indirectly, through the inherited base and Web composition; this patch layer registers no prompt or tool schema of its own, and Workspace Brief remains a human-only log event.

#### KV Cache effect

None beyond the selected base and Web composition; the patch changes browser-only rows.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Source launcher** — this phase supplies a repository launcher and product metadata, not a desktop executable or installer.
- **Independent state by default** — users must migrate selected stock state explicitly if they want it; the launcher never copies it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** This bundle patches only product-owned rows and leaves all shared API and package identifiers intact.

No runtime invariant companion is published; this package is a static product patch layer whose inserted rows own their runtime relationships and invariant companions.
