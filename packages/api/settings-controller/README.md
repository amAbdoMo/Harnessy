---
description: "Host Remote owner for settings, credentials, and Harnessy provider account management."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, `ctx.remote.accounts`, `ctx.remote.mcpManager`, and compatibility `ctx.remote.openAIAccount` namespaces for browser configuration surfaces. It returns redacted settings and credential metadata, supports writes without returning secret values, opens provider-owned settings or Agent preset locations on the Host desktop, and bridges Harnessy's provider-account and MCP actions to Host-owned services. When a provider is absent, each namespace remains registered and returns an actionable configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers both namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings and credential Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text-editor intent. `settings.canOpenAgentPresetDirectory()` reports native-opening availability when the preset page becomes visible. `settings.openAgentPresetDirectory(id)` resolves only a user-authored preset and either opens its directory or returns the path when native opening is unavailable; neither open method accepts a browser-supplied filesystem target.

`openAIAccount.describe()` returns availability, configured, in-flight, and writable flags without a token-shaped field. `openAIAccount.signIn()` selects the installed `llm-pi-ai/openai-codex` OAuth flow, accepts only an HTTPS authorization destination, opens it in the Host desktop's default browser, and waits for the provider's local callback. A successful attempt writes the grant inside the authorization flow and adds `llm-pi-ai.providers.openai-codex` to settings. `openAIAccount.signOut()` deletes that grant and removes the dependent route. Browser-open failures use `openai-account/browser-failed`; missing composition or an unsafe URL uses `openai-account/unavailable`.

`accounts.describe()` imports an existing canonical provider credential into a protected, Host-only multi-account vault and returns only provider labels, account identity labels, activation state, and usage snapshots. Codex, Kimi, and Claude Code use their installed OAuth flows; GLM and OpenCode accept locally stored API keys. Add, activate, rename, and remove operations keep the provider's canonical `llm-pi-ai/<provider>` credential synchronized with the selected vault entry, so model requests switch immediately. `accounts.refreshUsage()` refreshes Codex OAuth when required and reads its supported quota windows; providers without a supported usage service report that limitation instead of guessing values.

`mcpManager.describe()` returns Harnessy's global saved MCP profiles, live connection state, and discovered tool names without authentication values. `save`, `setEnabled`, `reconnect`, and `deleteServer` serialize durable changes through the credential provider and reconcile supervised connections immediately. Remote services require HTTPS, except loopback HTTP on this computer; local stdio entries launch an executable directly without shell interpolation. Enabled servers reserve the same public namespace as declarative MCP client entries, so duplicate namespaces fail without disturbing an earlier connection.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether Agent preset directories can be handed to a native desktop opener |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings and credential configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.
- The OpenAI account surface intentionally supports the desktop browser-login method; headless device-code and manual-code presentation remain available through the underlying authorization seam but are not exposed here.
- Provider usage is exposed only where a stable, authenticated service is available. The current manager reports Codex windows; GLM, Kimi, OpenCode, and Claude Code accounts remain switchable without fabricated quota data.
- MCP status uses a short browser polling interval rather than a pushed Remote event. The last known tool list can remain visible during reconnection, while calls fail until the server recovers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No secret, API key, OAuth grant, MCP authorization value, or stdio environment value crosses a response. Provider authorization flows remain the OAuth grant writers; protected managers retain credentials only inside the credential provider and project redacted state onto the wire.
