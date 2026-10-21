---
description: "Browser-integrated Desktop responsive previews with fixed phone/tablet CSS viewports and explicit image fallback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-device-preview

English | [中文](README.zh.md)

## Summary

Preview a web-compatible app at phone and tablet sizes inside Browser beside its conversation. Choose iOS or Android device frames, portrait or landscape, preset or custom CSS dimensions, and fit or 100% display. Native-only designs use clearly labeled, noninteractive images with separate orientation assets. Device frames provide visual context, not Android, iOS or Safari simulation.

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

Open **Browser** from Desktop's right-Sidebar guide. New Browser tabs start in **Desktop** mode; select **Mobile** or **Tablet** inside the tab for responsive previews. Browser is the only preview guide/tab entry; this package supplies its private responsive integration, not a separate Device Preview tab. Phone and tablet pages navigate independently. Custom dimensions accept whole CSS pixels from 240 to 2560; fit changes presentation scale, not responsive breakpoints.

The compact toolbar has one address bar for the selected Mobile or Tablet page. **Go** navigates that page; **Compare** also opens an unstarted live second page at the selected page's current URL without resetting an already-open page or an image selection. Device family, orientation and display scale stay visible; **Settings** expands preset/custom dimensions and live/image selection. **About this preview** keeps the rendering limitations available without a permanent warning above the canvas.

Drag a device edge or corner to change its CSS viewport within the custom-size bounds; the live page reflows without navigation. Focus a handle and use arrow keys for one CSS pixel, or Shift+arrow for ten. Fit keeps the starting scale and opposite edge fixed during the drag, then fits again. Pointer release, Escape, cancellation and hiding keep the last applied dimensions. Preset size restores the selected device's dimensions. Resizing an image changes its frame, not its contents.

### When to choose it

Choose Browser's responsive modes for PWA and web-compatible app layouts. Select an image for a native-only design; selecting another orientation requires its own image rather than rotating an existing screenshot. Use [Browser's Desktop mode](../ui-sidebar-browser/README.md) for ordinary browsing and saved website accounts; saved accounts never become device-observation targets.

### Minimal configuration

The [Desktop profile composition](../../bundle/web-app/cordis.patch.yml) owns the integration. The plugin has no configuration fields and requires Desktop's private preview transport and Browser's native-page provider; ordinary Web profiles leave it disabled. A URL draft alone does not start navigation. [Desktop preview tools](../../../apps/desktop/README.md#device-preview) own project preparation, exact-launcher consent and request-only observations. Opening grants no page inspection, and closing the Browser tab does not stop its server.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [controller](src/client/controller.ts) retains two ordinary Browser pages for the current opening. Geometry updates use fixed Chromium CSS layout metrics with DPR1 and physical compositor scaling, without a second CSS transform on the screen. Hiding a tab or selecting an image removes inspection visibility but retains the page; closing the occurrence drains its pages without stopping a development server. A fresh Agent opening selects Web and replaces the earlier opening's guests, so cancelled observations cannot close the replacement; size and orientation choices remain. Physical DOM removal can replace a guest and lose its native history.

The [view store](src/client/store.ts) contains only viewing choices, drafts and tab-lifetime image assets. Framework-bound hooks expose native page facts. Exact guest associations commit through Main acknowledgement; a stale restored preview identity grants neither automatic navigation nor observation. The transport adapter invokes methods on the original Desktop bridge, preserving prototype methods and their receiver. [Type-only IPC declarations](src/types.ts) keep Host and Client compiler faces separate.

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
