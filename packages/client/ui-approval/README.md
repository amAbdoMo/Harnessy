---
description: "Browser approval UI that answers Host permission requests through the scoped interaction path."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

## Summary

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes pending requests through `ctx.uiSession`, takes over the Conversation composer, renders permitted correlated Tool detail, and returns the user's decision to the waiting Host request. It also renders read-only permission checkpoints from recorded approval events. Use it when a browser must collect approval for a waiting Host operation.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Focus the approval detail region to approve with Enter or reject with Escape. The mounted plugin reserves both keys against editable shortcuts. Enter on the focused Reject button retains its native reject action. Input controls and IME candidates keep their own keys. Keyboard and pointer actions share one pending-request lock; a withdrawn or replaced request cannot accept another answer, and an earlier failed answer cannot unlock its replacement.

A `summary-only` request renders requester-supplied localized summary copy without invoking the optional detail slot or inspecting correlated command arguments. Ordinary requests use an indexed tool-call lookup and show command detail only while that exact call is running. Recorded `approval/asked` and `approval/decided` events form one checkpoint per request id; “Permission granted once” records permission, not successful execution. Replay never exposes decision buttons or grants authority.

<a id="model-experience"></a>
## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The live panel supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages. Historical checkpoints record decisions, not persistent permissions. Requester-supplied localized presentation copy follows the UI language without changing the audit reason or translating model-generated text.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
