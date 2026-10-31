---
description: "Right-Sidebar browser tabs for sandboxed HTTP(S) pages, including loopback services."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

English | [中文](README.zh.md)

## Summary

Browse HTTP(S) pages, including loopback services, inside independent right-Sidebar tabs. Web uses an iframe with application-managed history; Desktop uses Electron `<webview>` with native navigation history and retained pages. Browser uses one page surface with a compact navigation and feedback toolbar. The package never injects Electron or Node access into visited content.

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

Browser is disabled by default in Web profiles and enabled on Desktop. Enable the shipped entry through the Web profile patch to use it. Open **Browser** from the right-Sidebar guide and enter an HTTP(S) URL. Chat HTTP(S) links open here when the [link preference](../ui-chat/README.md) selects **In-App Sidebar**. A host name without a scheme becomes HTTPS. Public and loopback targets use the same default sandbox. Each guide action or delegated message-link activation creates another Browser tab.

Desktop browser tabs bind to their chat while preserving Chromium sign-in storage. Take control stops agent actions; Resume agent returns control to the owning chat. The toolbar has no device-mode switches. Agent browser operations and ownership are described in the [Desktop package](../../../apps/desktop/README.md).

### When to choose it

Choose Browser for a Web page that should remain beside the current Session. Choose [Document Preview](../ui-sidebar-documentpreview/README.md) for local files, and use the explicit external-browser action when a site refuses iframe embedding or needs browser capabilities this package withholds.

### Minimal configuration

The package has no plugin configuration. A Web profile enables the shipped entry through its profile patch:

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`. The optional URL passes the same validation as address-bar input before navigation.

The `browser.new` command opens a separate Browser page in the focused dock pane, replacing a guide and retaining existing content pages. From the conversation or a floating content page, it uses the active dock pane. Desktop defaults to Cmd+T on macOS and Ctrl+T on Windows; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves the command unbound. The guide button uses a blue globe and displays the effective shortcut inline without a duplicate tooltip.

The toolbar uses labeled icon buttons for navigation, tab control and annotation. Annotate page captures the current viewport and places Select, Region, Draw, Erase and Undo over the page, with an inline comment field and Add to chat action; it opens no dialog. Cancel or Escape discards the annotations. Capturing takes human control and leaves it there until Resume agent is selected. Navigation and agent resume stay unavailable while annotation is open. Add to chat stages the annotated PNG, page address/title and selected element context in the current chat draft; it does not submit the message. Ordinary Desktop tabs retain title/URL checkpoints; saved-account tabs retain their configured landing URL. Saved account and encrypted login management stays in the toolbar menus.

The saved-profile form accepts a bare host name as HTTPS and requires the exact connected MCP server name from Settings. Invalid fields show a correction beside the input and retain the draft; saved landing URLs cannot contain credentials, query parameters or fragments. Desktop failures use localized recovery messages selected by allowlisted identifiers; raw diagnostics and account values never enter profile notices.

Opening an existing saved profile does not require its paired MCP server to remain connected or unchanged; legacy paired-request Resume still verifies that binding. In the account menu, **Edit URL** changes the saved landing address without recreating the profile or clearing its browser storage and encrypted login. Saving opens the new address in the same tab position. A different origin requires native confirmation; site cookies remain subject to their original domain. A cancelled or failed save retains the old address.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Protocol policy

The address parser accepts HTTP and HTTPS, including loopback targets. It rejects `file:` URLs, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering.

### Iframe carrier

Web uses `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` by default. The frame has no direct download or top-navigation flag. Popups leave the sandbox; in Web, an escaped popup retains its opener and can navigate the top-level application. The visited origin can use its own cookies and Web storage but a cross-origin target cannot read DSH DOM, storage, or API responses. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. The toolbar can remove the sandbox for the current tab occurrence; the choice is not persisted. An unsandboxed page can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. The package does not proxy or probe remote pages.

Web records toolbar submissions and typed tab opens. A navigation state machine treats the first iframe load for each controlled revision as known and a later load as proof that the page changed to an unreadable URL. In that unknown state the address is marked, Back, Forward, and external-open are disabled, and Reload returns to the last controlled URL. A remounted body reloads the latest application-known URL and uses its optional initial URL only before the first controlled target. History API and fragment changes that emit no iframe load remain invisible. An iframe `error` event displays a transient load-failure notice until the next controlled load without changing URL history.

### Controller

Desktop provides the type-only `nativeBrowser` page service to the private [Browser responsive integration](../ui-device-preview/README.md). Consumers own page disposal. Ordinary pages can apply fixed CSS viewport metrics without navigation; saved-account pages expose no viewport operation. Successful native command notifications identify the exact lease and acknowledged geometry, while release revokes the association before physical guest drainage.

Each tab's `BrowserController` owns address validation, commands, and explicit restoration. `BrowserFrame` supplies carrier-neutral navigation state; `IframeImpl` uses `BrowserNavigation`, while `ElectronWebViewImpl` observes Chromium history only for ordinary tabs. `BrowserPresentation` owns physical DOM attachment. A Session-owned `WebsiteRequestSession` maintains the bounded request roster and exact claims; each saved-account page owns its admission, revocation, and drainage. Disposal stops roster observation synchronously and withdraws controls without waiting for native drainage. It joins admission and guest releases, including late acquisitions; failed drainage remains joinable and blocks reuse. Framework-bound Browser, profile, and request hooks supply snapshots; components receive plain callbacks, never providers or observable objects.

Desktop Main owns guest leases, tab ownership, human control, account storage and the encrypted login vault. Preload exposes scoped human controls and bounded annotation capture/selection. Shared declarations use `/types`; Host and Client compile separately. Desktop keeps account tabs mounted across Session switches and collapse. Tab ownership follows the chat instead of one execution generation. Legacy saved-account request admission remains separate for paired MCP tools.

The page refresh shortcut calls the same reload operation as the toolbar. Its tooltip and ARIA key combination follow the effective binding. Desktop routes accepted shortcuts from an approved guest through its owning window; the focused webview must still carry that guest’s lease. Web leaves browser-reserved combinations unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [Document Preview](../ui-sidebar-documentpreview/README.md) — local source, Markdown, images, HTML, and PDF rendering.
- [Sidebar Browser decision](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md) — iframe behavior and controller ownership.
- [Desktop Browser decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md) — webview leases, CWD storage grouping and manual restoration.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Client plugin adds only Browser presentation, registers no tools, prompts, or Session events, and exposes no visited content to the model.

#### KV Cache effect

None; browsing and human request controls do not enter a model request, while `website_profiles` and `website_prepare` are registered by the separate Desktop Host.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The isolation policy deliberately gives up some browser compatibility:

- Many sites refuse iframe embedding or need downloads or top-level navigation withheld from the frame by the default sandbox. An HTTPS application can also block public HTTP pages as mixed content. Disabling the sandbox trades its restrictions for compatibility but does not bypass mixed-content or private-network policy. The unsandboxed frame can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. It does not isolate the visited origin's cookies per Browser tab or prevent an in-frame page from choosing its own next URL.
- In Web, a popup that escapes the sandbox retains its opener and can use that chain to navigate the top-level application. Desktop handles popup creation separately.
- A later iframe load reveals that navigation occurred but not the new cross-origin URL. History API and fragment changes may remain invisible; Web Back and Forward are unavailable after the state becomes unknown.
- Browsers conceal many iframe failures for security: DNS, TLS, mixed-content, CSP, and `X-Frame-Options` failures may emit `load` or no actionable event instead of `error`. The load-failure notice is best-effort.
- Ordinary tabs retain title/URL checkpoints across reloads and plugin unload while present in Sidebar's layout; saved-account tabs retain the profile id and configured landing URL instead. Closing a tab removes its checkpoint. Restart restoration recovers neither page memory, unsaved forms, Chromium history, nor request grants.
- Local files are rejected and remain owned by Document Preview.
- Ordinary Desktop tabs share process-local storage partitions by canonical workspace CWD; unresolved Workspaces are isolated per Session. [Local HTTPS device tabs](../../../apps/desktop/README.md#local-https-devices) instead use fresh origin-scoped partitions; certificate consent and login storage do not cross tabs, and a storage transition replaces the guest after physical release. Saved-account tabs use separate persistent partitions, retaining authentication until successful sign-out or forgetting. Cleanup revokes authority, joins every guest release even after a sibling fails, then clears storage, cache, authentication, and connections. Any drainage failure preserves storage and blocks the profile; interrupted cleanup stays blocked after restart. Persistence does not protect cookies from the same OS user. Guest permissions, downloads, and native popups are denied; approved HTTP(S) popup requests open Sidebar tabs. Host-address filtering is not a general private-network or DNS-rebinding firewall.
- Desktop agent browser operations use the native preview toolkit and tab ownership. Legacy saved-account tools retain their separate paired MCP authorization and uncertain-outcome locks. Annotation selection reads the top document; cross-origin iframe contents and framework component source locations are not inferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
