---
description: "Harnessy's Delegation settings page for operators managing Command Code lanes, run limits, and workspace overrides in the browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-commandcode

English | [中文](README.zh.md)

## Summary

This package contributes the top-level **Delegation** page to Harnessy's Settings. It reports the installed Command Code CLI's detection, version, and sign-in state; edits the global lane directory and the three run bounds; and manages per-workspace lane overrides with per-field inherited/overridden state and reset controls. It is registered only when the browser bundle is built for the `custom-harness` profile, so no other product shows the page.

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

Mount the client row alongside the Host plugin. The `custom-harness` product patch layer already carries both rows.

```yaml
- id: ui-settings-commandcode
  name: '@deepseek-ai/dsh-client-ui-settings-commandcode'
```

The page appears as the `Delegation` entry in the Settings navigation. It reads the `commandcode-delegation` settings namespace through the shared settings scope and the `commandcode` Remote namespace for installation, catalog, and resolved-lane facts.

### What the page manages

| Area | What the user does |
|---|---|
| Command Code CLI | Reads whether the CLI was detected, which version it reports, and whether it is signed in; re-checks on demand and sees the exact login command when it is not |
| Run limits | Sets the concurrency cap, the per-run timeout in minutes, and the turn cap |
| Lanes | Adds, renames, enables, disables, and deletes **global** lanes; edits each lane's purpose, instructions, exact model with a searchable catalog chooser and a manual id fallback, reasoning effort, and access level. These cards carry the value every workspace inherits, so they show no per-workspace markers |
| Workspace override | For the session's workspace, edits any field of any lane; each field shows whether this workspace overrides it or inherits it, and resets back to inherited one field at a time or for a whole lane |

Every lane field is listed in the workspace editor, including the ones no workspace has overridden yet, so the first override is created by editing the field rather than by first adding an entry. A boolean field is a checkbox, an enum is a select, and long-form instructions are a textarea; nothing is stringified into a generic text box. Resetting prunes the emptied lane and workspace entries.

Full access is labelled in place with what it costs: the CLI runs with `--yolo` and may edit files and run commands in the workspace without asking.

### Copy and accessibility

Every string comes from the `commandCodeDelegation` dictionary, which is registered in both English and Chinese. Controls are native inputs, selects, and buttons, labelled through their own text or an explicit `htmlFor`, and the shared focus ring is visible on every editor.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: profile gate, dictionaries, settings scope, Remote operations, slot registration |
| [`src/client/DelegationSection.tsx`](src/client/DelegationSection.tsx) | The page: CLI state, limits, lane cards, workspace overrides |
| [`src/client/edit.ts`](src/client/edit.ts) | Pure section edits — lane field, add, delete, override, reset, id derivation, the ordered field roster |
| [`src/client/contract.ts`](src/client/contract.ts) | Browser-safe section shape and its decoder |
| [`src/client/delegation-section-store.ts`](src/client/delegation-section-store.ts) | Renderer mirror of the settings scope |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese dictionaries |

### Design concept

- **The Host resolves, the browser renders.** Lane inheritance and workspace resolution are computed once on the Host and read through the `delegation` Remote method, so the browser never re-derives what a run will actually use.
- **Text fields keep a local draft.** A settings write reaches the mirrored snapshot one round-trip after the keystroke, so each text and textarea control holds what the user typed and adopts an externally committed value instead of being reset by its own write.
- **Edits compose against the editor's latest section.** Each edit is applied to the section the editor currently shows and persisted as only the top-level fields it moved, so two edits made inside one settings round-trip cannot overwrite each other by re-deriving from a stale render.
- **The resolved view follows every accepted write.** The Host re-resolves the workspace after each write and the page re-reads it, so inherited/overridden state and the reset controls converge on the document that was committed; each read is aborted when a newer one supersedes it or the page unmounts.
- **A lane delete is a section edit, not a cascade.** Removing a lane also removes every workspace override that patched it, in the same write.
- **A new lane is usable without the catalog.** It starts on the documented default model when this browser has not read the CLI's advisory list, so the manual exact-id fallback is never the only way to make a lane that saves.
- **Profile-gated.** `apply` returns early unless the browser bundle was built for `custom-harness`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Command Code delegation plugin](../../subagent/subagent-commandcode/README.md) — the Host half that owns the settings namespace and the tools.
- [Harnessy product patch layer](../../bundle/custom-harness/README.md) — the profile that mounts both halves.
- [Settings section slots](../ui-settings/README.md) — the slot contract this page registers into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings page that registers no tool, no prompt section, and no model-visible text.

#### KV Cache effect

None; this package neither assembles nor sends a provider request. The lanes it writes change what the Host plugin's tools report on the next delegation, not the content or order of any request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Component rendering is covered by the shared jsdom lane** — the page's own logic lives in `edit.ts` and the Host, both unit-tested directly; the render spec exercises the page through Testing Library wherever that lane is available.
- **The workspace override editor shows stored overrides, not a workspace picker** — the page resolves overrides for the session's own workspace, and a session without one is offered the global lanes only.
- **The model catalog is advisory** — a searchable chooser over the CLI's `--list-models` output is offered beside a manual exact id, because a reformatted listing must not block a lane edit.
- **No lane reordering** — lanes keep storage order; the page adds new lanes at the end.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **The section never starts a process** — installation and catalog facts arrive over the Remote namespace; the page only asks.

</details>

**Runtime invariant:** No companion is published. The settings document is owned by the settings service and the section's data is owned by the Host plugin's Remote namespace.
