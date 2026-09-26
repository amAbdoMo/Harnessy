# Agent Note: Migrate released Harnessy profiles away from bundled core copies

Status: implemented

English | [中文](2026-09-26-harnessy-legacy-profile-core-migration.zh.md)

## Problem

Harnessy 0.1.5-alpha.1 installed the complete Desktop package set into the external plugin profile and recorded local tarball dependencies, overrides, and a lockfile. Harnessy 0.1.7 carries its runtime inside the application, but Node's nearest-package resolution still selected those 0.1.5 profile copies. The resulting mixed generation withdrew current Typert definitions, prevented Settings from activating, and left the upgraded application at its unavailable screen. The earlier cleanup removal assumed no released Desktop had written this residue; Harnessy's released profile satisfies that note's reintroduction condition.

## Decision

Desktop profile preparation runs a one-time compatibility migration under the existing profile lock before the Host starts. The presence of `desktop-packages.json` identifies a legacy released profile, and `desktop-core-packages-migrated-v1.json` records successful completion. The migration validates the legacy inventory before changing anything, removes only package names listed there from the profile and legacy fallback roots, prunes those names from dependency sections and pnpm overrides, and discards the lockfile only when package state changed. It writes the marker after every removal and metadata write succeeds.

External plugins, bundle selections, the user patch, settings, credentials, MCP configuration, sessions, attachments, and legacy inventory files remain. A current profile without the legacy inventory is untouched. After the marker exists, normal native package precedence applies again, including to a same-named dependency that a user installs later. The recurring cleanup remains removed as recorded by the [cleanup-removal decision](../simplification/2026-09-19-remove-desktop-profile-core-cleanup.md).

## Alternatives considered

**Require manual profile repair.** A normal in-place application upgrade must not open an unavailable window or require users to identify internal package directories. Manual repair also makes saved application data appear lost even though it remains intact.

**Restore cleanup on every production launch.** Repeated cleanup would remove same-named dependencies installed after migration and would continue invalidating plugin-manager state. A durable completion marker limits the compatibility write to profiles produced by the released legacy layout.

**Give the bundled runtime absolute resolution precedence.** That changes the documented plugin dependency rule for every profile and can hide versions deliberately carried by third-party plugins. The migration repairs only application-owned residue proven by the legacy inventory.

## Consequences

Upgrades from the released legacy layout start against one runtime generation while retaining user-owned data and external plugins. The first upgraded launch can remove hundreds of obsolete package directories and its stale lockfile; an interrupted migration retries because the marker is written last. A plugin that depended on one of the removed top-level copies may need its next package operation to recreate its own dependency, while the plugin package and activation selection remain present. Focused tests pin validation-before-mutation, redirected-directory refusal, exact package pruning, user-package preservation, and one-time completion.
