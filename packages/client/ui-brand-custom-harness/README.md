---
description: "Harnessy browser identity, theme tokens, About row, and provider account manager."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

English | [中文](README.zh.md)

## Summary

This package fills the generic sidebar and conversation-hero brand slots, adds a short localized orientation beneath the new-session headline, applies a reversible light/dark color and typography layer, adds a localized About row to General settings, and contributes Harnessy's account manager to the Models footer. It activates only when the browser bundle was built with the `custom-harness` client profile, so the shared Web composition can retain its stock identity in other builds.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Compose this package through [`dsh-custom-harness`](../../bundle/custom-harness/README.md) and build the repository with `pnpm run build:custom-harness`. Product names, project links, and support links come from the centralized build environment; missing values fail loudly rather than mixing identities.

The supplied transparent Harnessy mark scales to host-owned icon sizes on an ocean-gradient frame. Its deep navy, teal, and cyan palette flows through existing semantic tokens in both light and dark modes, while standard success, warning, and error meanings remain intact. The About row exposes the build version and project destinations without retaining runtime state.

The Models footer card reads only redacted `accounts.describe()` state. **Accounts** opens an exclusive provider-focused dialog for Codex, GLM, Kimi, OpenCode, and Claude Code while the Settings panel stays hidden; closing the dialog closes both views. The provider rail shows each nonzero saved-account total in a compact badge. The manager imports the account already active in Harnessy, supports additional browser or API-key accounts, and switches the canonical provider identity through injected Host callbacks. Opening the dialog always requests a fresh Codex usage snapshot; quota bars animate from zero to the returned percentage and honor reduced-motion preferences. Providers without supported usage data show a clear unavailable state. Remote refusal messages are displayed without inspecting credential contents.

<a id="model-experience"></a>
## Model Experience

None, as this package never constructs prompts or model requests; account activation only asks the Host to enable the selected installed provider route so its supported models enter the ordinary selector.

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
