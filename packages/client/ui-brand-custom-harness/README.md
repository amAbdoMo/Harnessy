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

After `pnpm run build:custom-harness`, run `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/accounts-live-usage.expected.e2e.ts` to check pushed usage in the built sidebar and open manager. The Harnessy Windows pull-request job runs this keyless check with the product profile.

The supplied transparent Harnessy mark scales to host-owned icon sizes on an ocean-gradient frame. Its deep navy, teal, and cyan palette flows through existing semantic tokens in both light and dark modes, while standard success, warning, and error meanings remain intact. The About row exposes the build version and project destinations without retaining runtime state.

The Shared skills folder row binds the `harnessy-shared-skills` settings namespace, displays its resolved absolute directory, and routes enable, folder-pick, and reset actions through the standard settings and native directory-picker services. It owns presentation only; the filesystem-skill provider owns discovery, watching, precedence, and provider replacement.

The sidebar footer shows the active Codex identity and uppercase plan beside compact circular `5h` and `7d` usage meters instead of opening Settings directly. Committed Host account snapshots update both surfaces immediately, and Codex request completion triggers a fresh usage check. Harnessy also refreshes at startup, every minute while the window is visible, and whenever the window returns to the foreground; these triggers and manager opening share one in-flight refresh. An older read response cannot replace a newer pushed snapshot. A new Codex account or manager/sign-in action retains one follow-up when its check shares an older read. Their rings jump directly to the latest value, turn yellow at 80% and red at 95%, and honor reduced-motion preferences. Selecting the footer opens one compact menu containing the same account summary and a Settings action. The account action opens the exclusive provider-focused manager for Codex, GLM, Kimi, OpenCode, and Claude Code while the Settings panel stays hidden; closing the dialog closes both views. The composer model button opens a searchable two-column picker for models and thinking levels. The manager header, provider rail, and account pane use equal compact insets, and its height follows the content without a credential-storage footer. The provider rail shows each nonzero saved-person total in a compact badge beside its brand mark. Empty-state logos keep the provider badge colors in both themes; muted hint text does not recolor the glyph. The manager imports the account already active in Harnessy, supports additional browser or API-key accounts, and switches the canonical provider identity through injected Host callbacks. The manager renders the same live snapshot the sidebar meters read and has no manual Refresh button. Usage remains provider-reported; changes made outside Harnessy appear on the next automatic check. Codex memberships belonging to one ChatGPT user share one card; a Personal/Workspace switch appears only when both usage contexts are saved, and the selected context controls both the displayed quota and the target of Switch. Reset times use live compact countdowns. View resets opens an account-scoped popup with each provider-issued reset's expiry in the browser's local timezone and its own Use reset action. Missing expiry is explicitly unreported; unavailable, unsupported, and expired credits cannot be redeemed. Choosing a row sends its exact provider ID, retains the same retry key for that account and credit after a failed attempt, and refreshes usage and the list after redemption. Query failures keep the list with Retry, and operation outcomes use a root-owned toast. Membership ids combine the ChatGPT user and workspace ids, so two users signed into the same workspace remain separate accounts. The optional automatic-switch control promotes another eligible Codex membership after a fresh usage check finds either active standard window at 95%; a quota refusal performs one recovery refresh, selects the eligible account with the most capacity—including the current account after its quota resets—and retries the same request once, while unrelated Business workspaces never mix. The Host repeats the proactive check before each Codex model request binds its credential. The bell beside the Workspaces search action retains automatic account switches, recorded root-Session outcomes (`completed`, `stopped`, or `failed`), access-approval requests, questions, and plan-review requests. A pending human action suppresses a duplicate terminal message for the same run. Child completion remains in the subagent panel without creating notification noise, while a child that needs user action can still notify. New activity always raises an in-app toast; failure, stopping, and action-needed events also request a native Desktop notification immediately, while successful completion requests one only when the app is not in the foreground. Any unread activity adds one count-free dot to the bell; opening the menu marks history read, while Clear history removes the retained rows. The first live snapshot after startup is a silent baseline, so pending work is not replayed as new activity after a reload. Opening the account dialog always requests a fresh Codex usage snapshot. Providers without supported usage data show a clear unavailable state. Remote refusal messages are displayed without inspecting credential contents.

The MCP Servers section presents one compact card per saved server, with a warm whole-card success, pending, or error border plus connection state, endpoint, transport, authentication presence, and discovered tool names. Its header action opens only the dedicated MCP JSON document, while the global settings document action stays hidden on this page. A single staged editor supports remote HTTPS and local stdio profiles. The local editor can fill an editable WordPress MCP Adapter template with the current endpoint format, command, arguments, and protected environment names; paired text areas keep equal height, placeholders use readable secondary text, and connection failures use a high-contrast alert. JSON import accepts the common `mcp`, `mcpServers`, and `servers` roots or a direct server map, including local command arrays or command-plus-arguments records and remote HTTP endpoints. It shows a redacted review before saving, derives unique tool namespaces, preserves enabled state, and reports unsupported SSE transport, extra headers, per-server timeouts, and malformed entries instead of silently changing them. Imported environment variables, authorization headers, URLs, commands, and arguments remain in the staged import record and are never shown in the review. Saved secrets are never rendered back into the form; leaving a secret field blank keeps its protected value, while an explicit control clears it. Test, enable, edit, import, and remove actions route only through injected Host callbacks. A compact MCP action in every Session header remains visible even when no server exists; in a title row at most 560px wide its label hides while the icon, status dot, call count, tooltip, and accessible name remain. It colors its dot from global connection health, shows the live call count, sorts active and failed servers first, and combines server status with up to 100 secret-free tool-call records derived from the latest Session projection. Failed rows can reconnect or focus the matching conversation event. Terminal connection failure and later recovery enter the notification center and native Desktop notifications; successful calls stay in the MCP activity list without notification noise. One shared three-second refresh continues while the app is open and refreshes immediately when the window returns to the foreground.

A native task or action-needed notification selects its existing Session through workspace navigation, without reloading the application document. Selection waits for the initial Session catalog; a removed Session leaves the current view unchanged. Account and MCP notifications open the app without a Session target. The [Desktop notification registration](../../../apps/desktop/README.md#native-activity-notifications) owns Windows branding, protocol activation, and development limitations.

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
