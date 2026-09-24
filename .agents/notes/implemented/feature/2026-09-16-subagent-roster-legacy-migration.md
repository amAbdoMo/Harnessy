# Agent Note: Harnessy mounts the unified roster and carries its stored lane configuration into it

Status: implemented

English | [中文](2026-09-16-subagent-roster-legacy-migration.zh.md)

## Problem

The unified roster shipped as a package that no profile mounted: its two tools reached no agent, and a Harnessy user's roles lived in the `commandcode-delegation` lane document instead. Mounting the row alone would have left an existing user with the roster's shipped roles and none of the ones they configured, and delegating to a role they had named would have failed for a reason that had nothing to do with their configuration.

Carrying the old configuration forward has one hard constraint: the lane document is the only record of the roles that were actually running, and the Delegation page keeps writing it while both surfaces coexist. A migration that rewrote, truncated, or cleared that section — or the per-workspace `projects` overrides inside it — would destroy the source it was reading.

## Decision

`packages/bundle/custom-harness/cordis.patch.yml` mounts the `subagent-roster` Host row beside the existing `commandcode-delegation` Host row, and the bundle manifest declares it. Both tool sets therefore run side by side: `commandcode_delegate` and `list_commandcode_lanes` keep working through the lane section, while `delegate` and `list_subagents` serve the roster. Retiring the lane surface is a later, separate change; nothing about the old row, its client page, or its document changed here.

`src/migration.ts` in the roster package owns the one-shot migration, wired directly after the settings registration in `apply()`, so it runs with the section it writes already in place.

## What the migration reads, and what makes it run

The migration reads both legacy namespaces through `settings.describe()`, which is the only public read that separates a namespace's stored user section from its resolved value, and it needs both. The stored section is the trigger: a namespace whose user never wrote anything there is not configuration to carry, whatever its schema resolves to. The resolved value is the source: a user who stored only `maxConcurrentRuns` still had six lanes running, and the projection has to reproduce what their configuration did, not the fragment they typed.

It runs when the lane namespace is registered and the user stored something in either legacy namespace. A namespace nobody registered, one whose stored section the provider cannot read, and one holding an empty section are all the same ordinary outcome — nothing to migrate — because a deployment mounts the legacy plugins exactly when it offers their feature. The model-selection authority falls back to the shipped default when its namespace is absent, so a deployment that mounts the lane plugin alone still carries its lanes.

The guard runs first and reads the roster's own stored section. Any stored `subagent-roster` document ends the migration, including one whose role list the user emptied: it is the user's roster, and the migration exists to seed a document, not to replace one.

## What it writes, and what it refuses to write

The projected document is validated by `validateSubagentSettings` before the write, and the write is a single `replace` of the `subagent-roster` section. Neither legacy section is touched — not the lane list, not its `projects` overrides, not the selection — so the old values stay inspectable and the migration can be reverted by editing the new document.

Every outcome is one Host log line: carried with the number of roles, nothing to migrate, refused with the validation message, or the provider's refusal to write. None of them throws, so no stored legacy value can fail the load or take the settings section down with it. The second run of the same load sees the document the first one wrote and writes nothing.

A migrated role keeps `execution.backend: 'commandcode'`, because that is where its lane ran. No provider registers under that name in this phase, so a delegation to one of those roles fails through the existing provider lookup with `no subagent provider registered for "commandcode"` and starts nothing; the roster substitutes no other backend.

## Declared namespace names

`src/migration.ts` declares `commandcode-delegation` and `subagent-model-selection` locally rather than importing them from their owning packages. The roster composes with every profile, and importing either constant would make a product-agnostic package depend on one product's backend package. The composition test in `subagent-commandcode` mounts both real rows, seeds the lane section under its owner's own constant, and fails if either name drifts — which is also what proves the migration reaches the real document.

## Alternatives considered

**Import `COMMAND_CODE_DELEGATION_NAMESPACE` and `SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE` and drop the local constants.** One source of truth instead of three, and rename-safe at compile time. It lost on dependency direction: `subagent-commandcode` is a single product's backend, and the roster is the generic role directory every profile can mount. The composition test buys the same protection without the edge.

**Migrate whenever the lane namespace is registered.** This is the simplest reading of "project the existing configuration", and it needs no stored-section comparison. It lost because a registered namespace always resolves its shipped defaults: a fresh Harnessy install would have had its working in-process roles replaced by six Command Code roles that cannot run yet. The stored section is the only thing that distinguishes configured from defaulted.

**Require the model-selection half as well.** Reading both namespaces as a pair is tidier than a fallback. It lost because the lane plugin and the selection plugin are mounted by different profiles: a deployment that mounts lanes without the selection package would have carried nothing, and its lanes are the half that matters.

**Delete the legacy sections after a successful write.** It would leave one document instead of two and make the next load's guard unnecessary. It lost because the Delegation page still writes the lane section in this phase, so the deletion would remove the document a live surface owns, and because the migration's reversibility is the reason a user can trust it.

**Ask the user before migrating.** A settings prompt is the obvious way to make an irreversible-feeling change visible. It lost because the migration is not irreversible — it writes a new document and leaves every old value in place — and because there is no composed prompt at plugin load, so the alternative was inventing a load-time interaction surface for a decision a user can undo by editing the document.

**Project the lanes only, and carry the selection authority separately.** Keeping the two namespaces' migrations independent would let one land without the other. It lost because the roster's document is one section with one write: two writes would need a second guard for the section they both touch, and the stored roster already answers "has this user's document been written".

## Consequences

Harnessy carries an existing user's roles on the first load after the row is mounted, once, and the Delegation page keeps working beside the Subagents page.

For a user who stored a lane configuration, the migrated roles are the Command Code roles they configured, so delegations to them fail loudly until a `commandcode` provider is registered. That is the accepted cost of keeping the roles rather than discarding them, and it is why the failure is asserted: `packages/subagent/subagent-roster/tests/migration.spec.ts` delegates to a migrated role and requires the provider-lookup error with no start request reaching any backend.

The migration reads `describe()` once per settings attach, which resolves every registered namespace's schema. It is a load-time cost, paid once, and it buys the only read that can tell a user's configuration from a schema default.

A role-less projection is written as projected. A user whose stored lanes are empty ends with an empty role list rather than the shipped roles, because the migration reproduces their configuration instead of choosing for them; the guard then keeps every later load from touching it, and the page can add roles back.

## Related

- [Harnessy delegates to Command Code through user-owned lanes](2026-09-15-commandcode-delegation-lanes.md) — the lane document and settings section this migration reads, and the surface it will replace.
- [Harnessy edits the unified subagent roster from one Settings page](2026-09-16-subagents-settings-page.md) — the page that writes the document this migration seeds.
- [User-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md) — the authority the selection namespace is folded into.
