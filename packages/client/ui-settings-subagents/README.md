---
description: "Harnessy's Subagents settings page for operators configuring the unified subagent roster, its per-workspace overrides, and automatic-routing authorization in the browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-subagents

English | [中文](README.zh.md)

## Summary

Harnessy's Subagents page configures each role's purpose, routing, model, effort, access, invocation, tools, and instructions. Summary cards use compact badges and risk-aware access colors. The editor groups advanced fields, tests resolved settings without model usage, warns about overlapping automatic roles, and exposes delegation limits. Create, Duplicate, and Edit stage one local draft; Save performs one complete Host write and Cancel discards it. New IDs remain editable until first save, and validation explains missing required values. Runtime diagnostics and workspace overrides stay in disclosures. The page is included only in the `custom-harness` browser profile.

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

Mount the client row alongside the Host roster plugin. The `custom-harness` product patch layer already carries the client row; the Host row that owns the `subagent-roster` settings section and the `subagentRoster` Remote namespace is mounted by whichever profile wants the roster.

```yaml
- id: ui-settings-subagents
  name: '@deepseek-ai/dsh-client-ui-settings-subagents'
```

The page appears as the `Subagents` entry in the Settings navigation. It reads the `subagent-roster` settings namespace through the shared settings scope, and the Host's `subagentRoster` and `session` Remote namespaces for the resolved roster, the routing authority, the stored document, and the model catalog.

### What the page manages

| Area | What the user does |
|---|---|
| Roles | Adds, renames, enables, disables, duplicates, and deletes **global** roles. Create and Duplicate open disabled editable drafts, existing edits remain local until Save changes, and Cancel performs no write. Each collapsed card shows its purpose and compact policy badges; the switch label states only the current Enabled or Disabled state, and the create action matches the adjacent input height. Its editor keeps routing guidance and optional identity, instructions, tools, runtime, scheduling, timeout, and depth in disclosures |
| Test role | Refreshes the selected runtime and model catalog, verifies that routing guidance is complete, and reports the selected backend, model, access, and invocation policy without starting a subagent or consuming model usage |
| Runtime status | Keeps installation, version, and sign-in diagnostics collapsed until needed, with the exact login command and a re-check for a runtime that can report for itself |
| Model and reasoning effort | Pins an exact provider/model route, leaves the role inheriting the calling agent's route, or opts the role into agent-chosen routing. Choices come from the catalog the role's backend owns. A model from the Host catalog is offered the levels it advertises and none at all when it advertises none; a route in a backend-owned space is offered the levels that backend accepts, since its own listing names none. Changing the model clears an effort the new model is not offered |
| Workspace override | Keeps advanced per-workspace role patches collapsed until opened; each field shows whether this workspace overrides it or inherits it, and resets back to inherited one field at a time, for a whole role, or for the whole workspace |
| Automatic routing | Enables agent-chosen models and authorizes the exact `{ provider, model }` routes a choice must resolve to |
| Delegation limits | Chooses Adaptive so the parent selects the smallest useful batch, or sets a stricter manual safety cap; both modes share the Host's hard limit of 16 and the same editable default timeout |

A role's ID is fixed once the role exists, because it is both the name the agent uses and the key the override layer patches; duplicating a role creates a fresh ID and starts the copy disabled, so a second live route for the same job never appears unreviewed. Deleting a role removes every workspace override that named it in the same write.

Full access is labelled in place with what it costs, and the page never presents access as something the agent can widen: a role can only narrow the calling agent.

Test role performs local validation plus catalog and runtime refreshes. It does not call a model, start a child conversation, or prove that a future provider request will succeed; runtime authentication and catalog availability remain the earliest facts the page can verify without usage.

### Copy and accessibility

Every string comes from the `settings.subagents` dictionary, registered in both English and Chinese. Inputs, textareas, buttons, and shared `Select` listboxes use visible labels and `aria-describedby`; icon-free actions carry visible text, and the shared focus ring is visible on every control. The layout collapses to one column on a narrow viewport.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: profile gate, dictionaries, settings scope, Remote operations, slot registration |
| [`src/client/SubagentsSection.tsx`](src/client/SubagentsSection.tsx) | The page: role cards, the add row, workspace overrides, and the routing block |
| [`src/client/DefinitionCard.tsx`](src/client/DefinitionCard.tsx) | One role's card: its summary line and every editable field |
| [`src/client/WorkspaceOverrideEditor.tsx`](src/client/WorkspaceOverrideEditor.tsx) | One role's per-workspace override rows and their reset controls |
| [`src/client/ModelEffortPicker.tsx`](src/client/ModelEffortPicker.tsx) | The grouped model control and its reasoning-effort control |
| [`src/client/RoutingBlock.tsx`](src/client/RoutingBlock.tsx) | The collapsible automatic-routing authorization control |
| [`src/client/edit.ts`](src/client/edit.ts) | Pure section edits — field, add, duplicate, delete, override, reset, prune, and id derivation |
| [`src/client/backends.ts`](src/client/backends.ts) | Pure backend projection: which backends the roster routes to, which of them report for themselves, and the reasoning levels each backend-owned space accepts |
| [`src/client/catalog.ts`](src/client/catalog.ts) | Pure catalog projection: which catalog a backend owns, route rows, provider groups, the efforts a route offers, and route narrowing |
| [`src/client/routing-overlap.ts`](src/client/routing-overlap.ts) | Pure overlap detector for enabled automatic roles' purpose and routing guidance |
| [`src/client/contract.ts`](src/client/contract.ts) | The Host contract this browser half mirrors: namespace, option lists, id pattern, default backend, and the backend that owns its own model space |
| [`src/client/fields.tsx`](src/client/fields.tsx) | Shared labelled controls and the draft that survives the settings round-trip |
| [`src/client/section-store.ts`](src/client/section-store.ts) | Renderer mirror of the settings scope |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese dictionaries |

### Design concept

- **The Host owns the values, the page owns the edits.** The stored document is the settings section; cards render from it, and every edit persists only the top-level fields it moved, so two edits made inside one settings round-trip compose instead of overwriting each other.
- **Edits are fenced by the revision they were computed from.** A write made against the settled mirrored document carries that revision, so a document that moved elsewhere is refused rather than silently overwritten; while this page is still composing over its own edits, the scope's queue carries the fence.
- **The catalog is the only source of a selectable route, and the role's backend picks which one.** A backend whose routes resolve through Harnessy is served by the Host catalog, so a deployment that adds a provider needs no change here; a backend that owns its model space is served by its own listing instead, because the composed runtime has no adapter for a model it is not the one to run. Either way a route the source does not advertise stays listed, marked, and removable rather than disappearing from a saved role; a failed source stays visible as an inline notice and a failed Test role result.
- **Effort is never fabricated.** The effort control offers only what a route's catalog states. A Host-catalog model offers the levels it advertises, a model that advertises none shows an explanation instead of a control, and a route in a backend-owned space offers that backend's own levels; either way an effort the newly selected model is not offered is cleared from the stored route.
- **A backend's levels are its own property.** The vocabulary of each backend that owns its model space sits beside that backend's name in `backends.ts`, including the id that means "send no level at all", which the picker realizes as its model-default option rather than as a level of its own. A second such backend states its levels in one more table row, and no literal id reaches the picker.
- **The Host resolves, the browser shows provenance.** The resolved roster read supplies the values a delegation runs with and the per-field override provenance; the page reads it afresh after each accepted write, so inherited/overridden state converges on the document that was committed.
- **A role edit is one complete draft.** Fields, switches, model choices, and advanced values stay local until Save. Client validation mirrors the Host's user-correctable identity and required-field checks, while the Host remains authoritative when the single revision-fenced write arrives.
- **Profile-gated.** `apply` returns early unless the browser bundle was built for `custom-harness`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent roster](../../subagent/subagent-roster/README.md) — the Host half that owns the settings namespace, the Remote namespace, and the two model-facing tools.
- [Harnessy product patch layer](../../bundle/custom-harness/README.md) — the profile that mounts this client row.
- [Settings section slots](../ui-settings/README.md) — the slot contract this page registers into.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the delegation contracts the roles it writes are resolved against.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings page that registers no tool, no prompt section, and no model-visible text.

#### KV Cache effect

None; this package neither assembles nor sends a provider request. The roles it writes change what the Host roster's tools report on the next delegation, not the content or order of any request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The workspace override editor shows stored overrides, not a workspace picker** — the page resolves overrides for the session's own workspace; a session without one is offered the global roles only.
- **A workspace cannot remove a role from this page** — the override layer's `removed` list is read and pruned but has no control here, so removing a role for one workspace is not yet reachable from the browser.
- **The override editor's model row cannot set an effort separately from its model** — the row writes the whole model policy, so a workspace pins a route and its effort together, or inherits both.
- **A backend-owned level is offered from the backend, not from its listing** — Command Code's own catalog carries an id and a description and nothing else, so the levels its routes offer are the ones this page records for that backend; a backend whose levels it does not record offers none, and a level a saved route already names stays stored either way.
- **The Plugins Subagent card remains available outside Harnessy** — the `custom-harness` build omits that redundant card because its complete role and routing workflow lives on the Subagents page; other profiles retain the older `subagent-model-selection` surface.
- **No role reordering** — roles keep storage order; the page adds new roles at the end.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **The Host enforces every policy this page writes** — the page only writes fields; access narrowing, invocation policy, and route authorization are resolved and enforced by the roster plugin, so a bug here cannot widen a child.
- **The picker is deliberately package-local** — `ModelSelect` in `ui-model-selection` submits a selection to the live session rather than emitting a controlled value, and one plugin may not import another plugin's component, so this page owns its own control over the shared catalog data.

</details>

**Runtime invariant:** No companion is published. The settings document is owned by the settings service, and the resolved roster, routing authority, and run bounds are owned by the Host roster plugin's Remote namespace.
