# Agent Note: Retire the Delegation Settings page into the Subagents page

Status: implemented

English | [中文](2026-09-16-retire-delegation-settings-page.zh.md)

## Problem

The `custom-harness` profile mounted two Settings pages over one feature. `ui-settings-commandcode` edited the Command Code lane document, while the Subagents page edits the unified roster those lanes migrate into, lists every backend a role routes to, and asks the Command Code backend about its own installation and sign-in state. Two navigation entries wrote two namespaces for one task.

Everything the Delegation page offered had already been rehoused there except one control. A lane's reasoning effort could be picked from the Command Code vocabulary, and the Subagents page could not offer it: `ctx.remote.commandcode.catalog()` returns an id and a description per model with no reasoning metadata, so the page's rule — offer the levels a route advertises — correctly offered an explanation instead of levels. A stored `reasoningEffort` still reached `--effort`; only *choosing* one was impossible.

## Decision

A backend that owns its model space now states the reasoning levels its models accept, and the Delegation page is gone.

The vocabulary is a property of the backend, so it lives in `backends.ts` beside the backend name rather than in the picker: one table entry per backend that owns its model space, each level carrying a dictionary key instead of a literal label. `commandcode` states `default`, `low`, `medium`, and `high`, which is the CLI's own `--effort` vocabulary. `default` is the id that asks for no level at all — the picker's existing model-default option means exactly that, and it stores no `reasoningEffort` — so it is never offered as a level of its own and no literal id reaches the picker.

`commandCodeModelGroups(catalog, backend, vocabulary)` attaches those levels to every projected model, which is where the levels of a backend-owned space belong: its listing states none, and each level applies to all of its models alike. The picker's rule is otherwise unchanged, so a Host-catalog model is still offered exactly `model.reasoning.efforts` and nothing when it advertises none, and re-narrowing on a model change now carries an effort across a backend-owned space as it always did within one model.

The retirement touches mount points and references only. `packages/bundle/custom-harness/cordis.patch.yml` keeps the `commandcode-delegation` Host row and drops the client row; the bundle manifest, the `tsconfig.base.json` alias, the `tsconfig.client.json` reference, the generated client slot catalog, and the two README rows that named the page follow. `packages/subagent/subagent-commandcode/**` keeps its tools, its `commandcode` backend, its health probe, its limiter, and its run machinery; the `commandcode-delegation` settings namespace, its stored `projects` overrides, and `ctx.remote.commandcode.health` and `.catalog` all stay, because the Subagents page now reads the namespace's health and catalog for itself.

## Alternatives considered

**Keep the Delegation page and add the effort control there.** One fewer deletion, and the page already owned the lane document whose lane carries the effort. It lost because the gap was the only thing keeping the page alive: every other control on it — lane membership, run bounds, workspace overrides, CLI state — was already on the Subagents page or read through the same Remote namespace, so keeping it would have preserved a second navigation entry and a second package for one control.

**Leave the effort picker on the global rule and let a backend-owned level stay unselectable.** No new vocabulary, and the migration already stores an effort a lane carried. It lost because it retires a capability a user has today: a stored effort would reach `--effort` with no way to choose a different one, and a surface may not be retired while dropping what it could do.

**Hardcode the Command Code levels in the picker.** The shortest path to the same control. It lost because the vocabulary belongs to the backend, not to this page: a second backend with its own levels would have had to edit the component, which is the scattering the table exists to prevent.

**Publish the levels through the backend's own catalog answer.** `cmd.health`/`cmd.catalog` already carry backend-owned facts, and widening `CommandCodeCatalog` with a level set per model would have kept the page free of the vocabulary. It lost on ownership: the levels are not per model — the CLI accepts one vocabulary for its whole model space — so publishing them per model would have stated a relationship the CLI does not have, and it would have needed a `subagent-commandcode` change, which this change deliberately does not make.

## Consequences

Harnessy keeps one delegation surface. The Backends block, the role cards, the workspace overrides, and the automatic-routing authority stay where they were, and the Command Code status, catalog, and roles that the retired page presented are reachable through them.

A backend that owns its model space must now be named in `backends.ts` to have its levels offered; a backend this page does not know contributes no vocabulary, and its routes keep the levels their listing states, which for such a backend is none. That is a static list, and it is the cost of not inventing a level set on the page's own authority.

The `commandcode-delegation` section outlives its page as data, read by the roster's one-shot migration and left in place so a user can still inspect or revert it. Nothing writes it any more.

The generated `cordis-surface` region of `docs/subsystems/subagent.md` still describes the Command Code health facts as what "the Delegation page shows", because that prose is projected from the JSDoc in `packages/subagent/subagent-commandcode/src/index.ts`, which this change leaves untouched; it is stale wording, not a live surface.

## Related

- [Harnessy edits the unified subagent roster from one Settings page](2026-09-16-subagents-settings-page.md) — the page this change leaves as the only delegation surface.
- [Harnessy delegates to Command Code through user-owned lanes](2026-09-15-commandcode-delegation-lanes.md) — the lane document and its retired page.
- [Harnessy mounts the unified roster and carries its stored lane configuration into it](2026-09-16-subagent-roster-legacy-migration.md) — the migration that reads the lane document this change stops writing.
