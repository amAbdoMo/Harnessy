---
description: "Harnessy browser identity, theme tokens, About row, and OpenAI account controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

English | [中文](README.zh.md)

## Summary

This package fills the generic sidebar and conversation-hero brand slots, adds a short localized orientation beneath the new-session headline, applies a reversible light/dark color and typography layer, adds a localized About row to General settings, and contributes the OpenAI account card to the Models footer. It activates only when the browser bundle was built with the `custom-harness` client profile, so the shared Web composition can retain its stock identity in other builds.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Compose this package through [`dsh-custom-harness`](../../bundle/custom-harness/README.md) and build the repository with `pnpm run build:custom-harness`. Product names, project links, and support links come from the centralized build environment; missing values fail loudly rather than mixing identities.

The supplied transparent Harnessy mark scales to host-owned icon sizes on an ocean-gradient frame. Its deep navy, teal, and cyan palette flows through existing semantic tokens in both light and dark modes, while standard success, warning, and error meanings remain intact. The About row exposes the build version and project destinations without retaining runtime state.

The Models footer card reads only the redacted `openAIAccount.describe()` state. **Sign in with OpenAI** starts a cancellable Host request and shows a waiting dialog while the default browser completes OAuth. On success it refreshes to Connected; **Sign out** removes the local grant and its Codex provider route. Remote refusal messages are displayed without inspecting credential contents.

<a id="model-experience"></a>
## Model Experience

None, as this package never constructs prompts or model requests; successful account sign-in only asks the Host to enable the installed OpenAI Codex provider route so its supported models enter the ordinary selector.

#### KV Cache effect

None directly; the selected provider and model own request construction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Build-profile gated** — changing the identity requires a new browser build rather than a runtime setting.
- **Browser presentation only** — the [desktop application](../../../apps/desktop/README.md) owns executable and installer assets; this package owns the renderer identity they display.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** Every visible value comes from the named product build, and teardown removes all slot occupants and token overrides.

No runtime invariant companion is published; the host registries own the cross-event slot and theme relationships, while this presentation adapter retains no durable state.
