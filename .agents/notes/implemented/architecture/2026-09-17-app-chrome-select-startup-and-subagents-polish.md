# Agent Note: The app's own chrome: a shared Select, silent children, and the Subagents page's first glance

Status: implemented

English | [中文](2026-09-17-app-chrome-select-startup-and-subagents-polish.zh.md)

## Problem

A pass over the packaged Harnessy desktop app found several things that read as unfinished rather than as design.

A console window appeared during normal startup. The shell spawns the bundled `node.exe` from a GUI process, and Windows allocates a console for any console-subsystem child created without `CREATE_NO_WINDOW`; piping stdout/stderr does not suppress it. Both live spawn sites — the host child on every start and the pnpm child on first run and upgrades — were missing `windowsHide: true`, so the user saw a black window flash (and on a cold first run, up to three).

Unpackaged Desktop startup could also fail before the renderer became usable. Its disposable project mirrored pnpm's virtual-hoist directory alone, so a retired package's dangling link aborted projection and a newly added transitive workspace plugin could be absent even though its owning bundle declared it. The development launcher also built the default official client graph, which omitted Harnessy's Subagents settings page from the Desktop renderer.

Every settings dropdown was a native `<select>`. The platform paints its popup and its arrow, ignores the theme's tokens, and renders differently from every other control on the page; the Models page had papered over the arrow with a data-URI chevron and the Subagents page had not.

Scrollbars were themed (`ui-theme/styles/scrollbar.css`) but read as the platform's: an 8px square-cornered bar whose thumb sat flush against the track.

The Subagents page opened on its diagnostics and stacked eleven full-width override rows per role, so the first thing a user met was a wall of controls.

Compact status surfaces also hid useful distinctions. The sidebar account card was transparent until hover, the Subagents and MCP settings entries shared the fallback gear, and the running-subagent catalog omitted the model that produced each conversation. The new-subagent action aligned with the field hint instead of its input.

The packaged Windows directory was 735.56 MB, including 48.30 MB of Chromium locale packs even though Harnessy now ships English-only UI. A release reconciliation also extracted the 249.02 MB pnpm store into a complete temporary tree and then recursively copied that tree into the persistent store before pnpm could install the profile. On the measured Windows package, archive validation and extraction took 34.963 seconds and the duplicate merge copy took another 27.121 seconds; seed and core-package integrity verification together took less than one second.

## Decision

**Console children are hidden at the source.** `apps/desktop/src/host-process.ts` and `apps/desktop/src/project-manager.ts` spawn with `windowsHide: true`, and both suites assert the flag on the real `spawn` call (a `vi.mock('node:child_process', …)` wrapper from the repo's existing pattern). The flag is the only lever: `detached` and `shell` were already unset, and the stdio pipes are unrelated to console allocation.

**The development project follows the workspace dependency graph.** Projection starts with pnpm's virtual-hoist directory, ignores only links whose targets no longer exist, then follows package-local links from the CLI and Desktop Host through every workspace package. A transitive plugin therefore resolves from the disposable project even when pnpm does not place its workspace link in the virtual-hoist directory. `dev:desktop` builds the `custom-harness` client profile explicitly, so the development renderer uses the same product-specific client graph as packaging.

**One shared `Select` in `ui-primitives`.** A native `<select>` cannot be themed, so the app now owns a listbox: a `role="combobox"` trigger styled like `Input` (32px, radius 8, `--dsw-alias-border-l4`, layer-1 fill, brand focus border) and a portaled `role="listbox"` card styled like `Menu` (menu surface, hairline from the elevation shadow, l2 scrollbar rebind). It supports grouped rows, disabled rows, Home/End/arrow walking that skips disabled rows, Enter/Space/Escape/Tab, outside-pointer dismissal, and `aria-activedescendant` so focus stays on the trigger. All eight native selects are gone: five in `ui-settings-models`, three in `ui-settings-subagents` (behind `DraftSelect` and the model/effort picker). `packages/client/ui-settings-models/tests/styles.client.spec.ts` now asserts no `<select>` reappears in that package.

**The scrollbar skin became the app's bar.** Still one global sheet reading the same tokens and indirection: width 10px, a 999px pill thumb inset 2px through a transparent border with `background-clip: padding-box`, the existing hover token, a transparent track and corner. The `--dsh-scrollbar-width` mirror moves with it, and the full-round radius carries `corner-shape: round` like every other pill in the app.

**Interactive controls carry focus on their own edge.** The global `field-focus.css` rule covers fields, buttons, dropdown triggers, toggles, tabs, editable regions, and other focusable controls: focus changes an existing border to the brand token and removes outside outlines and glows. Wrapper-owned fields such as the composer, search, and rename surfaces change the wrapper border through their component style. Focus does not add border width, so resting geometry remains stable.

**The Subagents page leads with what it edits.** Roles come first, followed by Automatic routing, the collapsed Runtime status report, and workspace overrides. An expanded role separates Role details from Run settings, renders invocation as one select instead of three explained radio rows, and places identity, instructions, tools, runtime, scheduling, and limits behind Advanced. Test role refreshes the relevant catalog and runtime, validates the routing guidance, and reports the selected backend, model, access, and invocation without starting a subagent or consuming model usage. Each role's override editor is a collapsed `<details>` that lists only the fields this workspace replaces until "Show all fields" asks for the rest.

**Role summaries compare policies instead of restating them.** Each collapsed card shows the role purpose and compact model, effort, access, invocation, and workspace-provenance badges. Read-only access stays neutral, workspace-write access is amber, and full access is red. Enabled is a switch whose adjacent label states only its current Enabled or Disabled state, agent-chosen routing uses the explicit label “Agent can choose,” and workspace cards say Custom or Inherited. Routing guidance stays collapsed until editing; Test role performs the existing usage-free resolution check. Create and Duplicate open disabled local drafts, every expanded editor stages all fields until Save changes, and Cancel writes nothing. Client validation explains the Host's user-correctable required fields before one complete write; a new role's derived id remains editable until that first save. The page warns when enabled automatic roles substantially overlap, Delegation limits edits concurrency and default timeout as shared controls, and the new-subagent action uses the input's 32px height.

**MCP import is provider-tolerant but transport-honest.** The importer accepts the common `mcp`, `mcpServers`, and `servers` roots or a direct map, then normalizes local argv and command-plus-arguments records and remote HTTP records into the existing protected Host save operation. A redacted review exposes names, derived unique namespaces, transport, enabled state, and protected-value counts without rendering environment values, headers, URLs, commands, or arguments. Unsupported SSE transport, per-server timeout, extra headers, malformed entries, and capacity limits remain visible warnings or skipped records. Accepted profiles save sequentially so a Host rejection has an exact stopping point.

**Product-specific settings remove duplicate entry points.** On the MCP page, the global settings-document action gives way to an MCP-only action that opens `$DSH_HOME/mcp-servers.json`; the Host validates file edits on the next status read and keeps UI writes synchronized. Because direct editing requires readable values, that owner-local file may contain MCP credentials and is not a shareable export. Connection state colors the whole card border instead of drawing a separate left rail. The Harnessy Plugins page omits the older Subagent model-selection card, and its Models page omits the built-in `deepseek-official` row and onboarding step while retaining custom provider routes. Role edits submit one complete validated definition instead of a sequence of partial writes.

**The overflow was a layout bug, not a taste call.** The override row declared four grid tracks for three children, so the control landed in a `max-content` track and its intrinsic width drove the row wider than the modal. The row is now a two-column grid (control, then state pill + reset) that stacks under 640px; field grids clamp with `minmax(min(200px, 100%), 1fr)`; the role-card action row wraps; the settings scroller gained `min-width: 0` and `overflow-x: hidden` so a section can never stretch the panel. The Subagents page's inputs and textareas were re-tokenised to the shared control's geometry so one form row reads as one family.

**Compact status surfaces expose stable identity.** The sidebar account card rests on the interactive-hover fill and uses the sidebar active fill while hovered or open. Settings maps Subagents to the branch glyph and MCP Servers to the database glyph instead of the fallback gear. A subagent catalog row leads its secondary line with the exact model id from the durable model-selection projection, preferring the latest consumed selection and falling back to the next selection before an initial request. The new-subagent button aligns with its input while the hint remains below the field.

**Notifications follow work that needs attention.** The existing browser-local account-switch history now also records a running Session becoming idle and a new approval, question, or plan-review interaction. The first observed Session and interaction snapshot establishes a silent baseline so refreshes do not replay existing state. Later transitions add one unread row and one transient toast, while the Desktop preload exposes a bounded notification-only IPC operation. A packaged Windows start creates or repairs the Start-menu shortcut that binds the executable to the same application id Electron sets before readiness. The main process validates each notification's title and body, retains its Electron object until Windows closes, fails, or activates it, and focuses the application when the user selects it. The bell badge renders the unread count instead of a presence dot.

**Release reconciliation writes package bytes once.** Runtime validation now extracts only pnpm's small versioned SQLite indexes into transaction scratch while checking every archive entry, shard assignment, type, duplicate, and declared entry count. Only after every shard passes does a second archive pass stream non-index package files directly into the persistent Desktop store. Four bounded workers process independent shards in both passes; using all 16 lanes measured slower on the same disk. The staged indexes then merge transactionally with seed records taking precedence and plugin-only records surviving. A failed archive validation cannot modify the persistent store; a later write failure can leave only verified content-addressed package bytes, while the old index remains authoritative until the final merge. The measured archive-to-store phase fell from 62.085 seconds to 18.283 seconds (70.6%), a complete first installation without the backend health boot took 48.676 seconds, and a matching warm reconciliation took 9.21 milliseconds. These are fresh local Windows diagnostics, not a cross-machine CI budget.

**The English-only product ships one Chromium locale.** Electron-builder retains only `en-US`; it does not remove licenses, GPU fallbacks, Node.js, pnpm, or the offline seed. The measured unpacked Windows artifact fell from 735.56 MB to 687.82 MB, and its locale directory fell from 48.30 MB to 0.56 MB, while keeping the runtime and recovery design intact.

## Alternatives considered

**Keep the native selects and restyle them harder.** Zero new API surface, and the Models page had already gone some way down this road. It lost because a native `<select>`'s popup is the OS's: its colours, row heights, checkmark, and scrollbar are outside the page's reach, so the control can never match the listbox the rest of the app draws, and the data-URI chevron was evidence of the ceiling.

**Extend `Menu` into a select.** One fewer primitive, and `Menu` already portals, positions, and dismisses. It lost on semantics: `Menu` is `role="menu"`/`menuitem` with no roving focus or `aria-activedescendant`, so a select built on it would announce itself as a menu and fail the listbox contract every screen reader expects from a dropdown.

**Ship the source fix for the console window without a test.** The flag is one word and "obviously" right. It lost because nothing else pins it: without an assertion the next spawn site — or a refactor of these two — reintroduces the window silently, and only a packaged run on Windows shows it.

**Re-skin scrollbars per surface.** Each panel could state its own bar. It lost because the app already has the rebind contract (`--dsh-scrollbar-thumb{,-hover}` on the elevated container) and the difference the user saw was the bar's *shape*, which every surface should share.

**Collapse the whole Workspace overrides block.** The shortest path to a calmer page. It lost because the block carries the workspace feature's only entry point: a control the user cannot find is not simpler, it is absent. Per-role disclosure keeps the count visible in the summary line while the fields stay one click away.

**Resolve friendly model names inside the subagent catalog.** A catalog label could be more polished than an exact id. It lost because the conversation header owns the durable session projection but not the provider catalog, and adding that dependency would make truthful status contingent on a second asynchronous source. The exact model id stays available even when a provider is offline or removed.

**Compress or delete the offline seed after installation.** This would reduce the unpacked application's filesystem size more than locale pruning. It lost because the seed is the signed offline recovery and upgrade input, and compressed per-shard payloads would trade installed size for decompression cost and less stable differential ranges. The product keeps that recovery property and removes only files it cannot use.

## Consequences

The packaged app starts without a console window, and both spawn sites carry a test that says so. Dropdowns look and behave the same everywhere they appear, and a future native `<select>` is a lint-free but test-visible regression in the Models package.

The unpackaged app starts across workspace package additions and removals without requiring stale virtual-hoist links to be repaired by hand. Its normal build includes the Subagents page and the product-specific model and reasoning-effort controls.

The Subagents page opens on compact role summaries that expose meaningful differences without repeating labels. Purpose and policy badges make access risk, routing choice, and workspace customization comparable at a glance; routing guidance and optional controls remain quiet until editing. Runtime diagnostics stay one collapsed row until a Test role result needs investigation, and the workspace editor's default view remains "what this workspace changed." Shared limits no longer require direct configuration-file editing, and overlapping automatic roles are visible before they compete for the same request.

MCP profiles from common provider configuration files can be reviewed and imported together without copying credentials field by field. The review remains safe to display and unsupported transport details remain explicit. The dedicated MCP document provides one direct-edit source without opening unrelated settings; it is local sensitive data rather than a redacted export.

The account footer reads as a persistent launcher rather than an invisible hit target. Settings navigation distinguishes agents from servers at a glance, the create action lines up with the value it submits, and the subagent catalog identifies the model for both active and completed conversations without another network read.

First installation and release reconciliation no longer create and recursively copy a second complete pnpm store. The loading page remains responsive during asynchronous archive work, validation still finishes before the persistent store changes, and plugin index entries survive the optimized path. Warm startup still bypasses all seed archive work when the release, package versions, and seed integrity descriptor match.

Windows packages no longer carry Chromium translations the app cannot select. The remaining large contributors are deliberate: Electron and its rendering fallbacks, the upstream Node.js and pnpm runtime, and the offline seed that can reconstruct the writable Desktop profile.

`ui-primitives` grows one control with its own stylesheet and a 16-test spec that holds it at 100% coverage; the README catalog lists it, and `ui-settings-models` and `ui-settings-subagents` no longer carry dropdown styling of their own. The tests for both settings pages now drive the shared control (open the popup, pick a row) instead of reading `HTMLSelectElement.value`.

Two limits are deliberate. The `Select` has no type-ahead: arrow/Home/End walking covers the lists the app renders today, and a first-letter jump can be added without changing the API. The settings scroller clips horizontally (`overflow-x: hidden`), so a future section that genuinely needs a wide table must own its own horizontal scroller rather than relying on the panel.

## Related

- [Shared client control primitives](../../implemented/architecture/2026-09-05-shared-client-control-primitives.md) — why a second consumer sends a control here.
- [Harnessy edits the unified subagent roster from one Settings page](../../implemented/feature/2026-09-16-subagents-settings-page.md) — the page this polish pass re-lays out.
- [Retire the Delegation Settings page into the Subagents page](../../implemented/feature/2026-09-16-retire-delegation-settings-page.md) — the page set the Subagents page replaced at retirement.
