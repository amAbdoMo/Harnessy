---
description: "Harnessy durable Markdown card for reviewing the selected workspace's bounded Workspace Brief command output."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-brief

English | [中文](README.zh.md)

## Summary

This package renders a dedicated card for the `/workspace-brief` command lifecycle. The card renders persisted Markdown from the host command, so reload and reconnect use recorded data without rerunning repository inspection. The browser never reads workspace files directly and contributes no session-header action.

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

The Harnessy bundle mounts this browser plugin with the host Workspace Brief command. In a session attached to a workspace, type `/workspace-brief` through the ordinary command input.

To include Git status, use `/workspace-brief --git`. The durable command card displays the recorded running, success, or failure state. Run the command again to retry a failed inspection.

### Minimal composition

Mount this row in the client composition with the locale, chat, and renderer packages. The Harnessy bundle supplies that graph.

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

The plugin contributes one `workspace-brief` keyed `conversation.chat.commandview` entry. The host command owns validation, observation, cancellation, and durable events. The slot registration and locale dictionary are effect-owned and disappear with the plugin fiber.

| File | Role |
|---|---|
| [`src/client/WorkspaceBriefCard.tsx`](src/client/WorkspaceBriefCard.tsx) | Durable loading, Markdown success, and error rendering |
| [`src/client/index.ts`](src/client/index.ts) | Locales and effect-owned command-card registration |
| [`tests/browser-plugin.client.spec.tsx`](tests/browser-plugin.client.spec.tsx) | Card states, absent header action, disable, and reload coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Brief host command](../../workspace/workspace-brief/README.md) — owns security bounds, failures, and persisted output.
- [UI chat](../ui-chat/README.md) — declares keyed command-card rendering and the generic fallback.
- [Client package map](../README.md) — adjacent browser packages.
- [Workspace Brief decision](../../../.agents/notes/implemented/feature/2026-09-08-custom-harness-workspace-brief.md) — records the product boundary and lifecycle choice.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser plugin only renders a human command whose log-only lifecycle and brief output are excluded from model history.

#### KV Cache effect

None; card rendering never alters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints keep the browser adapter small and predictable.

- **No automatic refresh** — reconnect and reload render recorded command events and never inspect the workspace again.
- **Chat presentation** — the specialized Markdown card belongs to the Chat command renderer; other projections may show their generic command lifecycle view.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin owns one command-card registration and one locale registration; disabling it withdraws both without affecting the host command.
