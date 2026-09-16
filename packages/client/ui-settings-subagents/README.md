---
description: "Harnessy's Subagents settings page for operators configuring the unified subagent roster, its per-workspace overrides, and automatic-routing authorization in the browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-subagents

English | [中文](README.zh.md)

## Summary

Harnessy's Subagents page is where the unified subagent roster is configured: one card per stored role, each editing its model and reasoning effort, sandbox access, invocation policy, tool scoping, and standing instructions. It reports which backend each role routes to and, where that backend can answer for itself, whether it is installed, which version it reports, and whether it is signed in. It shows every role's inherited-versus-overridden state for the session's workspace, with a per-field reset and a reset-all, and holds the automatic-routing allowlist that decides which models an agent may pick for a subagent. Each role's model choices come from the catalog its backend owns: the Host catalog for a backend that resolves through Harnessy, and that backend's own listing for one that owns its model space. The page is registered only when the browser bundle is built for the `custom-harness` profile.

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
| Roles | Adds, renames, enables, disables, duplicates, and deletes **global** roles. Each card collapses to one line — name, resolved model, effort, access, invocation — and expands to every field: Enabled, ID, Name, Purpose, When to use, Model, Reasoning effort, Access, Invocation, Standing instructions, Tools, and an Advanced block holding the backend, background policy, timeout, and max depth |
| Backends | Reports every backend a role routes to, and asks a backend that can answer for itself whether it is installed, which version it reports, and whether it is signed in — with the exact login command when it is not, and a re-check |
| Model and reasoning effort | Pins an exact provider/model route, leaves the role inheriting the calling agent's route, or opts the role into agent-chosen routing. Choices come from the catalog the role's backend owns, and the picker names which one it read. Only the levels the selected model actually advertises are offered, and changing the model clears an effort the new model does not advertise |
| Workspace override | For the session's workspace, edits any field of any role; each field shows whether this workspace overrides it or inherits it, and resets back to inherited one field at a time, for a whole role, or for the whole workspace |
| Automatic routing | Enables agent-chosen models and authorizes the exact `{ provider, model }` routes a choice must resolve to |

A role's ID is fixed once the role exists, because it is both the name the agent uses and the key the override layer patches; duplicating a role creates a fresh ID and starts the copy disabled, so a second live route for the same job never appears unreviewed. Deleting a role removes every workspace override that named it in the same write.

Full access is labelled in place with what it costs, and the page never presents access as something the agent can widen: a role can only narrow the calling agent.

### Copy and accessibility

Every string comes from the `settings.subagents` dictionary, registered in both English and Chinese. Controls are native inputs, selects, textareas, and buttons, each labelled by its own visible text and described through `aria-describedby`; icon-free actions carry visible text, and the shared focus ring is visible on every control. The layout collapses to one column on a narrow viewport.

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
| [`src/client/backends.ts`](src/client/backends.ts) | Pure backend projection: which backends the roster routes to, and which of them report for themselves |
| [`src/client/catalog.ts`](src/client/catalog.ts) | Pure catalog projection: which catalog a backend owns, route rows, provider groups, advertised efforts, and route narrowing |
| [`src/client/contract.ts`](src/client/contract.ts) | The Host contract this browser half mirrors: namespace, option lists, id pattern, default backend, and the backend that owns its own model space |
| [`src/client/fields.tsx`](src/client/fields.tsx) | Shared labelled controls and the draft that survives the settings round-trip |
| [`src/client/section-store.ts`](src/client/section-store.ts) | Renderer mirror of the settings scope |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese dictionaries |

### Design concept

- **The Host owns the values, the page owns the edits.** The stored document is the settings section; cards render from it, and every edit persists only the top-level fields it moved, so two edits made inside one settings round-trip compose instead of overwriting each other.
- **Edits are fenced by the revision they were computed from.** A write made against the settled mirrored document carries that revision, so a document that moved elsewhere is refused rather than silently overwritten; while this page is still composing over its own edits, the scope's queue carries the fence.
- **The catalog is the only source of a selectable route, and the role's backend picks which one.** A backend whose routes resolve through Harnessy is served by the Host catalog, so a deployment that adds a provider needs no change here; a backend that owns its model space is served by its own listing instead, because the composed runtime has no adapter for a model it is not the one to run. Either way a route the source does not advertise stays listed, marked, and removable rather than disappearing from a saved role, and the picker says which of the two it is reading.
- **Effort is never fabricated.** The effort control offers only the levels the selected model advertises; a model that advertises none shows an explanation instead of a control, and an effort the newly selected model does not advertise is cleared from the stored route.
- **The Host resolves, the browser shows provenance.** The resolved roster read supplies the values a delegation runs with and the per-field override provenance; the page reads it afresh after each accepted write, so inherited/overridden state converges on the document that was committed.
- **Text fields keep a local draft.** A settings write reaches the mirrored snapshot one round-trip after the keystroke, so each text control holds what the user typed and adopts an externally committed value instead of being reset by its own write.
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
- **A backend-owned listing advertises no reasoning levels here** — Command Code's own catalog carries an id and a description and nothing else, so a model chosen from it offers no level; a level a saved route already names stays stored and is what the delegation runs with.
- **The Delegation page and the Plugins Subagent card still exist** — this page is additive until the retirement phase; the Plugins card keeps its own automatic-routing control over the older namespace.
- **No role reordering** — roles keep storage order; the page adds new roles at the end.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- **The Host enforces every policy this page writes** — the page only writes fields; access narrowing, invocation policy, and route authorization are resolved and enforced by the roster plugin, so a bug here cannot widen a child.
- **The picker is deliberately package-local** — `ModelSelect` in `ui-model-selection` submits a selection to the live session rather than emitting a controlled value, and one plugin may not import another plugin's component, so this page owns its own control over the shared catalog data.

</details>

**Runtime invariant:** No companion is published. The settings document is owned by the settings service, and the resolved roster, routing authority, and run bounds are owned by the Host roster plugin's Remote namespace.
