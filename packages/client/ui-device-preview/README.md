---
description: "Desktop phone and tablet design previews with fixed CSS viewports and explicit image fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-device-preview

English | [中文](README.zh.md)

## Summary

Compare a web-compatible app at phone and tablet sizes beside its conversation. Choose iOS or Android device frames, portrait or landscape, preset or custom CSS dimensions, and fit or 100% display. Native-only designs use clearly labeled, noninteractive images with separate orientation assets. Device frames provide visual context, not Android, iOS or Safari simulation.

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

Desktop's right-Sidebar guide exposes **Device preview**. Enter an HTTP(S) URL and choose **Start preview**; each device begins at that URL and then navigates independently. Comparison expands the existing Sidebar. Custom dimensions accept whole CSS pixels from 240 to 2560; fit changes presentation scale, not responsive breakpoints.

### When to choose it

Choose this preview for responsive PWA and web-compatible app layouts. Select an image for a native-only design; selecting another orientation requires its own image rather than rotating an existing screenshot. Choose [Browser](../ui-sidebar-browser/README.md) for ordinary browsing and saved website accounts.

### Minimal configuration

The [Desktop profile composition](../../bundle/web-app/cordis.patch.yml) owns the entry. The plugin has no configuration fields and requires Desktop's private preview transport and Browser's native-page provider; ordinary Web profiles leave it disabled. A URL draft alone does not start navigation. [Desktop preview tools](../../../apps/desktop/README.md#device-preview) separately own project preparation, launcher permission and request-only observations.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [controller](src/client/controller.ts) retains two ordinary Browser pages for the current opening. Geometry updates use fixed Chromium CSS layout metrics with DPR1 and physical compositor scaling, without a second CSS transform on the screen. Hiding a tab or selecting an image removes inspection visibility but retains the page; closing the occurrence drains its pages without stopping a development server. A fresh Agent opening selects Web and replaces the earlier opening's guests, so cancelled observations cannot close the replacement; size and orientation choices remain. Physical DOM removal can replace a guest and lose its native history.

The [view store](src/client/store.ts) contains only viewing choices, drafts and tab-lifetime image assets. Framework-bound hooks expose native page facts. Exact guest associations commit through Main acknowledgement; a stale restored preview identity grants neither automatic navigation nor observation. [Type-only IPC declarations](src/types.ts) keep Host and Client compiler faces separate.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab ownership and docking.
- [Browser](../ui-sidebar-browser/README.md) — ordinary native guests and storage policy.
- [Desktop](../../../apps/desktop/README.md#device-preview) — launch consent, observation and Stop.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Client plugin registers presentation only; the separate Desktop Host owns preview tools and their logged results.

#### KV Cache effect

None; device controls and viewing choices do not enter model requests. Explicit Host tool results and requested screenshots have their own transcript costs.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Preview does not replace target-device qualification:

- Live rendering uses Chromium, not Safari, Android WebView or native OS APIs. User-agent, touch input, safe-area behavior and device performance are not simulated.
- Native-only apps cannot run in a web guest; image mode is noninteractive and has no automatic responsive transformation.
- Images and page history are not restored across application restart. Preview URLs follow ordinary Browser storage policy; saved-account guests are never inspection targets.
- Manual Desktop qualification owns fractional-fit rendering, pointer mapping, orientation changes and the expanded comparison. Source checks alone do not verify those native visual behaviors.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
