# Agent Note: Harnessy edits the unified subagent roster from one Settings page

Status: implemented

English | [中文](2026-09-16-subagents-settings-page.zh.md)

## Problem

The unified roster made roles the unit a user configures: a role fixes its backend, model policy, sandbox access, invocation policy, tool scoping, and standing instructions, and the two model-facing tools read that document on every call. Nothing in the browser could write it.

Three surfaces were close to one and none of them fit. The Delegation page owns the Command Code lane document — a different namespace with a different field set, and one whose access vocabulary (`read-only` / `full-access`) is not the sandbox ladder a role names. The Plugins section ships a card per settings namespace, but a card is one column of a tab and cannot carry a per-role directory with a model picker, an advanced block, and a per-workspace override editor. The Subagent card's automatic-routing control already exists, but it writes `subagent-model-selection`, while the roster resolves its authority from `automaticRouting` inside its own section.

The model picker was the sharpest constraint. `ModelSelect` in `ui-model-selection` submits a selection to the live session rather than emitting a controlled value, one client plugin may not import another plugin's component, and adding a value export to a UI plugin needs sign-off. There was no reusable controlled model control to build on.

## Decision

`@deepseek-ai/dsh-client-ui-settings-subagents` contributes one top-level **Subagents** page (`settings.section`, id `subagents`, order 20), registered only when the browser bundle is built for `custom-harness`, and declaring its copy under a new `settings.subagents` locale namespace.

The page splits the surfaces by who owns the truth. Every editable value comes from the `subagent-roster` settings section, written through `settingsScope` and persisted as only the top-level fields an edit moved, so two edits inside one settings round-trip compose instead of overwriting each other. Every *resolved* value comes from the Host: `resolvedRoster(workspace)` supplies the values a delegation would run with and the per-field override provenance, `storedRoster()` supplies the stored run bounds the page reports, and `automaticRouting()` supplies the authority its routing block explains. The workspace comes from the active session's `cwd` through the standard `useSessions` seat, with `null` when there is none.

The model and reasoning-effort picker is built inside this package over the shared catalog, which is the option the architecture brief recommended over promoting a control into `ui-primitives` and refactoring the composer seat. Three rules make it honest. The stored value is an exact `{ provider, model, reasoningEffort? }` route. The effort control offers only the levels `model.reasoning.efforts` advertises, and a model that advertises none gets an explanation instead of a fabricated level. Selecting a different model re-narrows that list and clears an effort the new model does not advertise, because the effort belonged to the route it replaced. A route the catalog no longer advertises stays listed — joined in from the stored policy, marked, and removable — rather than disappearing from a role that still pins it.

The workspace override editor lists every overridable field of every role, shows Inherited or Overridden beside each, and gives each row its own Reset plus a reset-all for the role and for the workspace. Resetting prunes the emptied entry, so a field returns to fully inherited instead of leaving a patch that records nothing.

The Automatic routing block re-homes the Plugins card's control with its semantics intact: an enabled switch, a checkbox list of exact provider/model routes drawn from the global catalog, and the same rule that a route saved against a model the catalog dropped stays visible and removable. The block writes the roster's own `automaticRouting` field. The Plugins card is untouched; both write different namespaces until the retirement phase.

## Alternatives considered

**Promote a controlled model+effort picker into `ui-primitives` and refactor the composer seat onto it.** This is the option the architecture brief offered second, and it would leave one control instead of two. It lost because the composer's picker submits to a live session while a settings picker emits a value, so the refactor would rewrite the composer's submit semantics inside a settings-page change, and the catalog data — the part that actually needed sharing — is already shared through the Host.

**Ship the page as another `settings.plugin.item` card.** It would have reused the tab chrome and the namespace-keyed dispatch the Plugins section already has. It lost on shape: a card is a column of a tab, and this page is a directory of roles with a per-role editor, a workspace override editor per role, and its own collapsible routing block. It would also have put one feature's page inside another feature's section, which is what the `settings.section` slot exists to avoid.

**Extend the Delegation page instead of adding a page.** Fewer navigation entries and no new package. It lost because the two documents share no field: lanes are Command Code's own concept with a CLI-specific access vocabulary, and the roster's roles are backend-agnostic. Merging them would have made one page write two namespaces and present two vocabularies for one control.

**Read the workspace override layer only from `resolvedRoster`.** It is the Host's own answer, and it is the right source for the values it carries. It lost as the *only* source because the resolved role view omits `instructions`, `tools`, and `maxDepth`, so an editor over every overridable field has no resolved answer for three of them. The editor therefore derives the effective value from the stored definition and the workspace patch with the same rule the Host applies, and uses the resolved read for provenance and for the card summary.

**Stage edits and write them on Save, as the Plugins cards do.** That is the accepted settings-form pattern for a card whose namespace has a document the user previews. It lost because this page edits a directory of independent roles rather than one form: a staged draft would have to track which of N roles is dirty, and the Delegation page — the closest neighbour, and the page this one replaces — already composes live edits against the document the editor shows.

**Give the model control separate mode and route controls.** A mode select plus a route select is the most literal rendering of `SubagentModelPolicy`, and it is what the schema looks like. It lost because it makes the user answer a question the answer already implies: "fixed with no route" *is* inherit and "automatic" *is* agent-chosen, so one control over inherit / agent-chosen / each model states the whole policy and keeps the effort control's enablement a consequence of one choice.

## Consequences

Harnessy gains one page and one locale namespace, and the roster document becomes editable without a restart: the tools read the live section, so a saved edit applies to the next delegation from a session that is already running.

The page writes fields and enforces nothing. Access narrowing, invocation policy, and route authorization are resolved and enforced by the roster plugin, so a defect here can mislead a user but cannot widen a child. The page does present the full-access consequence in place and never offers access as something the agent may widen, because the language a settings surface uses is part of the guarantee even when the mechanism is elsewhere.

Four costs are deliberate. Duplicating a role creates a disabled copy under a fresh id, because a copy carries the same purpose and a second live route for the same job must not appear before the user reviews it. A workspace cannot remove a role from this page: the override layer's `removed` list is read and pruned but has no control. The override editor's model row writes the whole model policy, so a workspace pins a route and its effort together or inherits both. And the Plugins Subagent card keeps its own automatic-routing control against the older `subagent-model-selection` namespace until that namespace is retired, so two controls authorize routes on two documents for now.

The picker is a second implementation of a model control, which is the price of not touching the composer. It is bounded: it is presentational over the shared catalog, so a provider or model a deployment adds appears with no change to this package.

## Related

- [User-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md) — the authorization control this page re-homes onto the roster's own section.
- [Harnessy delegates to Command Code through user-owned lanes](2026-09-15-commandcode-delegation-lanes.md) — the page shape this one follows, and the surface it replaces at retirement.
- [Per-child persona, tool filter, and depth](2026-07-12-subagent-persona-tool-filter-and-depth.md) — the child policy knobs a role's fields resolve into.
