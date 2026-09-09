---
description: "Custom Harness browser identity, theme tokens, and About row for users and maintainers of the independent product profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

English | [中文](README.zh.md)

## Summary

This package fills the generic sidebar and conversation-hero brand slots, adds a short localized orientation beneath the new-session headline, applies a reversible light/dark color and typography layer, and adds a localized About row to General settings. It activates only when the browser bundle was built with the `custom-harness` client profile, so the shared Web composition can retain its stock identity in other builds.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Compose this package through [`dsh-custom-harness`](../../bundle/custom-harness/README.md) and build the repository with `pnpm run build:custom-harness`. Product names, project links, and support links come from the centralized build environment; missing values fail loudly rather than mixing identities.

The mark is a vector threaded aperture that scales to host-owned icon sizes and follows light or dark product tokens. The cool-violet palette flows through existing semantic tokens, while the shared blue send action and success, warning, and error meanings remain intact. The About row exposes the build version and project destinations without retaining runtime state.

<a id="model-experience"></a>
## Model Experience

None, as this browser presentation package registers nothing model-facing.

#### KV Cache effect

None; the package neither assembles nor sends provider input.

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
