---
description: "Custom Harness browser action and durable Markdown card for creating, retrying, and reviewing the selected workspace's bounded Workspace Brief."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-brief

English | [中文](README.zh.md)

## Summary

This package adds a “Create workspace brief” action to the open session header and a dedicated card for the resulting `/workspace-brief` command lifecycle. The action shows loading, success, and actionable failure states, prevents duplicate in-flight requests, and allows an explicit retry. The card renders persisted Markdown from the host command, so reload and reconnect use recorded data without rerunning repository inspection. The browser never reads workspace files directly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Custom Harness bundle mounts this browser plugin with the host Workspace Brief command. Open a session attached to a workspace, then select “Create workspace brief” in the session header; the button is disabled until the session is open.

The action sends the exact argument-free `/workspace-brief` command. To include Git status, type `/workspace-brief --git` through the ordinary command input. Transport and command failures appear beside the action and remain retryable; the durable command card independently displays the recorded running, success, or failure state.

### Minimal composition

Mount this row in the client composition after the locale, Remote, chat, conversation, renderer, and session UI packages. The Custom Harness bundle supplies that graph.

```yaml
- id: ui-workspace-brief
  name: '@deepseek-ai/dsh-client-ui-workspace-brief'
```

The package accepts no configuration fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes one ordered `conversation.session.header.actions` entry and one `workspace-brief` keyed `conversation.chat.commandview` entry. The action calls `ctx.remote.commands.execute` once per accepted click; the host command owns validation, observation, cancellation, and durable events. Both slot registrations and the locale dictionary are effect-owned and disappear with the plugin fiber.

| File | Role |
|---|---|
| [`src/client/WorkspaceBriefAction.tsx`](src/client/WorkspaceBriefAction.tsx) | Open-session gating, in-flight deduplication, transient status, and explicit retry |
| [`src/client/WorkspaceBriefCard.tsx`](src/client/WorkspaceBriefCard.tsx) | Durable loading, Markdown success, and error rendering |
| [`src/client/index.ts`](src/client/index.ts) | Locales, Remote adapter, and effect-owned slot registrations |
| [`tests/browser-plugin.client.spec.tsx`](tests/browser-plugin.client.spec.tsx) | Component, dispatch, failure, disable, and reload coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Brief host command](../../workspace/workspace-brief/README.md) — owns security bounds, failures, and persisted output.
- [UI conversation](../ui-conversation/README.md) — declares the session-header action slot.
- [UI chat](../ui-chat/README.md) — declares keyed command-card rendering and the generic fallback.
- [Client package map](../README.md) — adjacent browser packages.
- [Workspace Brief decision](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.md) — records the product boundary and lifecycle choice.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser plugin only dispatches a human command whose log-only lifecycle and brief output are excluded from model history.

#### KV Cache effect

None; action state and card rendering never alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints keep the browser adapter small and predictable.

- **Default brief from the button** — the header action does not expose a Git-status toggle; users type the documented `--git` command when needed.
- **Open sessions only** — a Draft, opening, closing, or closed session cannot dispatch the action.
- **No automatic refresh** — reconnect and reload render recorded command events and never inspect the workspace again.
- **Chat presentation** — the specialized Markdown card belongs to the Chat command renderer; other projections may show their generic command lifecycle view.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin owns two slot registrations and one locale registration, and its tests prove disposal withdraws both product seats before a clean reload.
