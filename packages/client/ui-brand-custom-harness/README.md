---
description: "Harnessy browser identity, theme tokens, About row, and provider account manager."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-custom-harness

English | [中文](README.zh.md)

## Summary

This package fills the generic sidebar and conversation-hero brand slots, adds a short localized orientation beneath the new-session headline, applies a reversible light/dark color and typography layer, adds new-session workspace, shared-skills, and About controls to General settings, contributes Harnessy's account manager to the Models footer, and provides the MCP Servers settings page. It activates only when the browser bundle was built with the `custom-harness` client profile, so the shared Web composition can retain its stock identity in other builds.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Compose this package through [`dsh-custom-harness`](../../bundle/custom-harness/README.md) and build the repository with `pnpm run build:custom-harness`. Product names, project links, and support links come from the centralized build environment; missing values fail loudly rather than mixing identities.

The supplied transparent Harnessy mark scales to host-owned icon sizes on an ocean-gradient frame. Its deep navy, teal, and cyan palette flows through existing semantic tokens in both light and dark modes, while standard success, warning, and error meanings remain intact. The About row exposes the build version and project destinations without retaining runtime state.

The Shared skills folder row binds the `harnessy-shared-skills` settings namespace, displays its resolved absolute directory, and routes enable, folder-pick, and reset actions through the standard settings and native directory-picker services. It owns presentation only; the filesystem-skill provider owns discovery, watching, precedence, and provider replacement.

The New session workspace row offers Remote website and Harnessy default modes. Remote website asks for a parent folder and enables the Host setting atomically; each later ungrouped Session receives an isolated child folder there, while a saved project always uses its own path. The selected folder contains local temporary and generated files only. MCP servers and their remote targets remain configured separately.

The sidebar footer shows the active Codex identity, its uppercase plan, and compact `5h` and `7d` usage meters instead of opening Settings directly. Harnessy refreshes these meters at startup, every minute while the window is visible, and whenever the window returns to the foreground; automatic triggers share one in-flight refresh. Their fills jump directly to the latest value, turn yellow at 80% and red at 95%, and honor reduced-motion preferences. Selecting the footer opens one compact menu containing the same account summary and a Settings action. The account action opens the exclusive provider-focused manager for Codex, GLM, Kimi, OpenCode, and Claude Code while the Settings panel stays hidden; closing the dialog closes both views. The provider rail shows each nonzero saved-person total in a compact badge. The manager imports the account already active in Harnessy, supports additional browser or API-key accounts, and switches the canonical provider identity through injected Host callbacks. Codex memberships belonging to one ChatGPT user share one card; a Personal/Workspace switch appears only when both usage contexts are saved, and the selected context controls both the displayed quota and the target of Switch. Membership ids combine the ChatGPT user and workspace ids, so two users signed into the same workspace remain separate accounts. The optional automatic-switch control promotes another eligible Codex membership after a fresh usage check finds either active standard window at 95%; a quota refusal performs one recovery refresh and retries only after a successful switch, while unrelated Business workspaces never mix. The Host repeats the proactive check before each Codex model request binds its credential. The bell beside the Workspaces search action retains automatic account switches, recorded root-Session outcomes (`completed`, `stopped`, or `failed`), access-approval requests, questions, and plan-review requests. A pending human action suppresses a duplicate terminal message for the same run. Child completion remains in the subagent panel without creating notification noise, while a child that needs user action can still notify. New activity always raises an in-app toast; failure, stopping, and action-needed events also request a native Desktop notification immediately, while successful completion requests one only when the app is not in the foreground. Any unread activity adds one count-free dot to the bell; opening the menu marks history read, while Clear history removes the retained rows. The first live snapshot after startup is a silent baseline, so pending work is not replayed as new activity after a reload. Opening the account dialog always requests a fresh Codex usage snapshot. Providers without supported usage data show a clear unavailable state. Remote refusal messages are displayed without inspecting credential contents.

The MCP Servers section presents one compact card per saved server, with a warm whole-card success, pending, or error border plus connection state, endpoint, transport, authentication presence, and discovered tool names. Its header action opens only the dedicated MCP JSON document, while the global settings document action stays hidden on this page. A single staged editor supports remote HTTPS and local stdio profiles. The local editor can fill an editable WordPress MCP Adapter template with the current endpoint format, command, arguments, and protected environment names; paired text areas keep equal height, placeholders use readable secondary text, and connection failures use a high-contrast alert. JSON import accepts the common `mcp`, `mcpServers`, and `servers` roots or a direct server map, including local command arrays or command-plus-arguments records and remote HTTP endpoints. It shows a redacted review before saving, derives unique tool namespaces, preserves enabled state, and reports unsupported SSE transport, extra headers, per-server timeouts, and malformed entries instead of silently changing them. Imported environment variables, authorization headers, URLs, commands, and arguments remain in the staged import record and are never shown in the review. Saved secrets are never rendered back into the form; leaving a secret field blank keeps its protected value, while an explicit control clears it. Test, enable, edit, import, and remove actions route only through injected Host callbacks. A labeled compact MCP action in every Session header remains visible even when no server exists, colors its dot from global connection health, shows the live call count, sorts active and failed servers first, and combines server status with up to 100 secret-free tool-call records derived from the latest Session projection. Failed rows can reconnect or focus the matching conversation event. Terminal connection failure and later recovery enter the notification center and native Desktop notifications; successful calls stay in the MCP activity list without notification noise. One shared three-second refresh continues while the app is open and refreshes immediately when the window returns to the foreground.

<a id="model-experience"></a>
## Model Experience

None, as this package constructs no prompts or model requests; account activation only asks the Host to enable a provider route, while the MCP page only asks the Host to register discovered tools through the ordinary tool registry.

#### KV Cache effect

None directly; the selected provider and model own request construction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Build-profile gated** — changing the identity requires a new browser build rather than a runtime setting.
- **Product-browser scope** — the [desktop application](../../../apps/desktop/README.md) owns executable and installer assets; this package owns the renderer identity and product settings controls they display.
- **Status polling** — MCP status refreshes every three seconds while the renderer is active and once when the window returns to the foreground; it is not a push event stream.
- **Ordered MCP import** — accepted profiles are saved in review order. If the Host rejects a later profile, earlier profiles remain saved and the page reports where the import stopped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** Every visible value comes from the named product build, and teardown removes all slot occupants and token overrides.

No runtime invariant companion is published; the host registries own the cross-event slot and theme relationships, while this presentation adapter retains no durable state.
