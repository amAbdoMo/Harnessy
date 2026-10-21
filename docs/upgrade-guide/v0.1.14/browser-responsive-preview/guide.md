---
kind: upgrade-guide
description: "Browser Desktop, Mobile and Tablet modes replace the separate Device Preview tab and guide entry."
---

# Responsive preview moves into Browser

English | [中文](guide.zh.md)

## Change

The separate **Device Preview** tab and start-guide entry are removed. Desktop users open **Browser**, which starts in **Desktop** mode, and select **Mobile** or **Tablet** for responsive previews. These modes use Chromium CSS viewports and device frames, not Android, iOS or Safari simulation. Saved website accounts remain in Desktop mode and cannot be device-observation targets.

The public Sidebar kind `device-preview` is removed. The internal `ui-device-preview` package, private transport and `device_preview_*` tools retain their names; this is a Browser UI migration, not a tool rename.

## Migration

1. Open **Browser** from the Sidebar guide instead of **Device Preview**, then select **Mobile** or **Tablet** for a responsive preview. Use its single address bar and **Go** for the selected page; **Settings** contains custom sizes and image controls.
2. Replace extension calls to `ctx.sidebarRight.openTab('device-preview', ...)` with Browser navigation. Use `ctx.sidebarRight.openTab('browser', { params: { url } })` to open a URL, then select the responsive mode in Browser; do not reuse the removed kind or assume its parameters apply to Browser.
3. Keep existing `device_preview_*` tool calls. Opening grants no inspection; each screenshot or layout observation still requires fresh consent. Closing the Browser tab does not stop a managed development server; use **Stop** separately.
4. Confirm that the guide offers Browser without a separate Device Preview entry, that a new Browser tab starts in Desktop mode, and that ordinary Desktop pages can switch to Mobile and Tablet.
