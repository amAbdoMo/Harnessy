---
description: "Custom Harness product patch layer for users and maintainers launching the independently branded Web profile."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-custom-harness`

English | [中文](README.zh.md)

## Summary

This package is the narrow product layer applied after `dsh-base` and `dsh-web-app` by the shipped `custom-harness` profile. It replaces the stock brand, disables per-message ratings and notes, enables the neutral authorization service for OpenAI account login, and adds the bounded read-only Workspace Brief action without renaming shared framework packages, provider names, protocols, or compatibility surfaces.

## Table of Contents

- [Use this package](#use-this-package)
- [Disabled per-message feedback](#disabled-per-message-feedback)
- [Workspace Brief](#workspace-brief)
- [OpenAI account login](#openai-account-login)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Run `pnpm run build:custom-harness` once, then start the product with `pnpm run custom-harness -- --no-open`. The launcher selects `dsh --profile custom-harness` and replaces any ambient stock `DSH_HOME` with the product-owned home under the Custom Harness data directory.

The default Windows locations are `%LOCALAPPDATA%\CustomHarness\Harness`, `%LOCALAPPDATA%\CustomHarness\Logs`, and `%LOCALAPPDATA%\CustomHarness\Cache`. Product-specific `CUSTOM_HARNESS_*` variables may redirect them for testing or managed deployments; no stock state is imported automatically.

<a id="disabled-per-message-feedback"></a>
## Disabled per-message feedback

The profile disables both the `message-feedback` Host row and the `ui-message-feedback` client row. Consequently the browser does not offer Good response, Bad response, or Add a note actions, and direct `messageFeedback/list`, `messageFeedback/put`, and `messageFeedback/delete` Remote requests are unclaimed and return HTTP 404.

Per-message feedback has no model tool, so the tool roster needs no compatibility alias or tombstone. Existing session logs continue to open because ratings and notes live in a separate sidecar rather than the session event stream. The profile does not migrate or delete that sidecar.

The session-level `/feedback` command remains available. Telemetry feedback gating, authentication, approvals, permission presets, sandboxing, and filesystem policy are also unchanged; they are separate operational, privacy, and safety controls.

<a id="workspace-brief"></a>
## Workspace Brief

The profile inserts the `workspace-brief` Host row and `ui-workspace-brief` client row. An open session can create a bounded Markdown summary of its selected registered Git workspace; typing `/workspace-brief --git` adds bounded short-status rows. The command accepts no arbitrary path, writes no files, performs no network or model request, and persists its result through the ordinary command log.

Disabling either row removes that half of the experience without changing stored sessions. A recorded brief remains readable through the generic command renderer when the specialized client row is absent; reconnect and restart never rerun repository inspection automatically.

<a id="openai-account-login"></a>
## OpenAI account login

The profile mounts `@deepseek-ai/dsh-authorization`. The inherited dormant `llm-pi-ai` adapter consequently registers its `openai-codex` OAuth flow even before a provider route exists, while the Custom Harness brand client places **Sign in with OpenAI** in Settings > Models. The Host opens the HTTPS authorization page in the default browser; the provider flow writes the resulting grant directly to the local credential store, and the controller activates the matching provider route only after the authorization service confirms that write.

Sign-out deletes the local grant and removes the matching route. Tokens never cross the Remote response and never enter settings or session logs. See the [official Codex authentication documentation](https://learn.chatgpt.com/docs/auth) for the upstream account-sign-in behavior.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the inherited base and Web composition. OpenAI sign-in can activate the installed Codex model catalog; this patch layer registers no prompt or tool schema of its own, and Workspace Brief remains a human-only log event.

#### KV Cache effect

None beyond the selected base and Web composition; the patch changes browser-only rows.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bundle scope** — this package supplies the product profile and repository launcher; the [desktop application](../../../apps/desktop/README.md) owns the executable and installer.
- **Independent state by default** — users must migrate selected stock state explicitly if they want it; the launcher never copies it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** This bundle patches only product-owned rows and leaves all shared API and package identifiers intact.

No runtime invariant companion is published; this package is a static product patch layer whose inserted rows own their runtime relationships and invariant companions.
