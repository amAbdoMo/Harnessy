---
description: "Harnessy product patch layer for users and maintainers launching the independently branded Web profile."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-custom-harness`

English | [中文](README.zh.md)

## Summary

This package is the narrow product layer applied after `dsh-base` and `dsh-web-app` by the shipped `custom-harness` profile. It replaces the stock brand, disables per-message ratings and notes, enables the neutral authorization service for OpenAI account login, adds the bounded read-only Workspace Brief action, mounts public model capability metadata with its `--models-sync` / `--models-explain` diagnostics, and adds Command Code delegation and the Subagents roster, whose one Settings surface — the **Subagents** page — edits the roster and reports the Command Code backend beside it, without renaming shared framework packages, provider names, protocols, or compatibility surfaces.

## Table of Contents

- [Use this package](#use-this-package)
- [Disabled per-message feedback](#disabled-per-message-feedback)
- [Workspace Brief](#workspace-brief)
- [Public model capability metadata](#public-model-capability-metadata)
- [Command Code delegation](#command-code-delegation)
- [Subagents](#subagents)
- [OpenAI account login](#openai-account-login)
- [Shared skills folder](#shared-skills-folder)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Run `pnpm run build:custom-harness` once, then start the product with `pnpm run custom-harness -- --no-open`. The launcher selects `dsh --profile custom-harness` and replaces any ambient stock `DSH_HOME` with the product-owned home under the Harnessy data directory.

The default Windows locations are `%LOCALAPPDATA%\CustomHarness\Harness`, `%LOCALAPPDATA%\CustomHarness\Logs`, and `%LOCALAPPDATA%\CustomHarness\Cache`. Product-specific `CUSTOM_HARNESS_*` variables may redirect them for testing or managed deployments; no stock state is imported automatically.

<a id="disabled-per-message-feedback"></a>
## Disabled per-message feedback

The profile disables both the `message-feedback` Host row and the `ui-message-feedback` client row. Consequently the browser does not offer Good response, Bad response, or Add a note actions, and direct `messageFeedback/list`, `messageFeedback/put`, and `messageFeedback/delete` Remote requests are unclaimed and return HTTP 404.

Per-message feedback has no model tool, so the tool roster needs no compatibility alias or tombstone. Existing session logs continue to open because ratings and notes live in a separate sidecar rather than the session event stream. The profile does not migrate or delete that sidecar.

The session-level `/feedback` command remains available. Telemetry feedback gating, authentication, approvals, permission presets, sandboxing, and filesystem policy are also unchanged; they are separate operational, privacy, and safety controls.

<a id="workspace-brief"></a>
## Workspace Brief

The profile inserts the `workspace-brief` Host row and `ui-workspace-brief` client row. An open session can create a bounded Markdown summary of its selected registered Git workspace; typing `/workspace-brief --git` adds bounded short-status rows. The command accepts no arbitrary path, writes no files, performs no network or model request, and persists its result through the ordinary command log.

Disabling either row removes that half of the experience without changing stored sessions. A recorded brief remains readable through the generic command renderer when the specialized client row is absent; reconnect and restart never rerun repository inspection automatically.

<a id="public-model-capability-metadata"></a>
## Public model capability metadata

The profile mounts the `model-capabilities` Host row and its `model-capabilities-cli` companion. The first keeps a catalog per public database — a successful fetch, else the durable cache, else the bundled snapshot — and registers one capability source on the LLM seam, so a model no adapter or local integration describes can still be offered its provider-aware reasoning-effort levels. The second adds `dsh --profile custom-harness --models-sync=check`, `--models-sync=write`, `--models-explain=<route>/<model>`, and `--models-refresh`.

The capability row declares the Command Code controller as an injected service. The Loader mounts sibling rows in parallel, so its position in the patch file does not order it; that dependency is what makes Command Code's own capability source register first, which is what keeps its declarations ahead of any public claim. Only this profile mounts the rows, so no official profile gains public metadata.

Behavior, configuration (`model-capabilities.publicMetadata`), and the sync safety rules are documented in the [package README](../../llm/model-capabilities/README.md). Disabling the row withdraws the capability source and leaves every local declaration untouched; the CLI row then reports that the layer is not mounted.

<a id="command-code-delegation"></a>
## Command Code delegation

The profile mounts the `commandcode-delegation` Host row with its pre-roster tools disabled. The live `commandcode-delegation` settings section, `commandcode` backend, health probe, and model catalog remain available, so the **Subagents** page can configure roles against Command Code without exposing a second delegation route to the model.

Each lane fixes an exact Command Code model, a reasoning effort, and an access level, so a delegated task can never choose or widen any of them. The user's own installed and authenticated CLI is the only backend: this profile vendors no Command Code package, stores no Command Code credential, and falls back to no other product, model, or executable. Loading the row starts no Command Code process. Disabling it removes the section and backend state the Subagents page would otherwise report, and leaves every other product profile untouched.

The stored lane section stays mounted as migration input and backend configuration. Other profiles may retain `commandcode_delegate` and `list_commandcode_lanes`; Harnessy deliberately exposes only the roster's tools.

<a id="subagents"></a>
## Subagents

The profile mounts the `subagent-roster` Host row and the `ui-settings-subagents` client row. Together they add the top-level **Subagents** page in Settings and the role directory behind it: the `subagent-roster` settings section with one card per stored role — its model and reasoning effort, its sandbox access, its invocation policy, its tool scoping, and its standing instructions — plus the per-workspace overrides and the automatic-routing authorization an agent's model choice resolves against.

The Host row adds one token-stable `delegate` tool and one `list_subagents` discovery tool to every agent in this profile. Harnessy disables the generic `subagent` and `subagent_fork` tools and the pre-roster Command Code tools, so every new child must name one enabled configured role. The tool guidance tells the model to read the directory before delegating, choose the best matching role, and batch related items instead of creating one child per image, file, or record. The parent keeps final integration and validation. Loading the row starts no child.

On the first load that finds a stored lane configuration, the Host row also carries that configuration into the `subagent-roster` document, once. The `commandcode-delegation` section, its per-workspace `projects` overrides, and the `subagent-model-selection` section stay exactly where they were stored, so a user can inspect or revert; a roster the user already edited is never replaced.

The client row is presentation only: it reads the Host roster plugin's `subagentRoster` Remote namespace, the Host's global model catalog, and — where the Command Code row is mounted — that row's `commandcode` namespace for a backend-owned role's routes, and it writes the `subagent-roster` settings section. It therefore enforces no policy of its own and starts no process.

<a id="openai-account-login"></a>
## OpenAI account login

The profile mounts `@deepseek-ai/dsh-authorization`. The inherited dormant `llm-pi-ai` adapter consequently registers its `openai-codex` OAuth flow even before a provider route exists, while the Harnessy brand client places **Sign in with OpenAI** in Settings > Models. The Host opens the HTTPS authorization page in the default browser; the provider flow writes the resulting grant directly to the local credential store, and the controller activates the matching provider route only after the authorization service confirms that write.

Sign-out deletes the local grant and removes the matching route. Tokens never cross the Remote response and never enter settings or session logs. See the [official Codex authentication documentation](https://learn.chatgpt.com/docs/auth) for the upstream account-sign-in behavior.

<a id="shared-skills-folder"></a>
## Shared skills folder

The profile mounts a global filesystem-skill provider whose default root is `%USERPROFILE%\.agents\skills`. Harnessy's private runtime and credential homes remain under `%LOCALAPPDATA%\CustomHarness`; only the explicitly selected skill directory is shared. Settings > General exposes a live enable switch and native folder picker, and resetting the field restores the normal `.agents\skills` location. The provider watches the selected directory, so catalog additions, renames, and frontmatter changes do not require an application restart.

The global shared root composes with each preset's scoped filesystem provider. Project `.dsh\skills` and `.agents\skills` entries retain their higher priority, so a project can deliberately override a personal skill with the same name.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the inherited base and Web composition. OpenAI sign-in can activate the installed Codex model catalog; the mounted public-metadata row contributes reasoning-effort levels for models no local source describes, the mounted delegation rows own the tools this profile adds, this patch layer registers no prompt or tool schema of its own, and Workspace Brief remains a human-only log event.

#### KV Cache effect

None beyond the selected base and Web composition, apart from the stable `delegate` and `list_subagents` schemas the mounted roster row contributes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bundle scope** — this package supplies the product profile and repository launcher; the [desktop application](../../../apps/desktop/README.md) owns the executable and installer.
- **Independent state by default** — sessions, settings, and credentials remain isolated; only the user-selected skills folder is shared, and the launcher never copies other stock state.
- **Public metadata ships here alone** — no official profile mounts `model-capabilities`, so a deployment that wants provider-aware public reasoning metadata mounts the rows itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** This bundle patches only product-owned rows and leaves all shared API and package identifiers intact.

No runtime invariant companion is published; this package is a static product patch layer whose inserted rows own their runtime relationships and invariant companions.
