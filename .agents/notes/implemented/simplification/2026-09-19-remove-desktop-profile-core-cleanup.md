# Agent Note: Remove the Desktop production profile core-package cleanup

Status: implemented

English | [中文](2026-09-19-remove-desktop-profile-core-cleanup.zh.md)

## Problem

Since 2026-09-15, production Desktop cleaned the profile before starting the Host, using the package names listed by the runtime descriptor: it deleted same-named entries under `$DSH_HOME/profiles/desktop/node_modules`, pruned the manifest's dependency declarations and pnpm overrides for those names, discarded the lockfile when package state changed, and removed development-time links once according to `desktop-runtime-state.json`. It targeted two kinds of residue: earlier Desktop builds had installed the core packages into the profile as local tarballs through pnpm, writing declarations, overrides, and a lockfile; and the development mode of the link backend had projected the installation closure into the same profile's `node_modules`. Under nearest-wins resolution those copies shadowed the runtime bundled with the application, combining an old Web frontend with new plugins.

Both kinds of residue were believed to exist only on internal development and test machines. Harnessy 0.1.5-alpha.1 had in fact released the installed-core layout, so its profiles need the one-time [legacy-profile migration](../bug-fix/2026-09-26-harnessy-legacy-profile-core-migration.md). New profiles do not contain core packages, and after the [link backend removal](../architecture/2026-09-19-profile-resolution-lookup-order.md) development mode writes no links into the profile. The removed cleanup had to rerun on every production launch and fought the next pnpm operation, which reinstalled packages from the retained declarations.

## Decision

The recurring cleanup and link-era package migration remain deleted. `DesktopProjectManager.applyRelease` validates the runtime descriptor, runs the separately owned one-time legacy-profile migration when its inventory is present and its marker is absent, migrates profile settings, creates the profile files, and removes projections through the shared `removeLinkProjections`. After the compatibility marker exists, neither production nor development launches modify the profile's packages, declarations, overrides, lockfile, or `desktop-runtime-state.json`.

Resolution inside the profile follows the [lookup-order Note](../architecture/2026-09-19-profile-resolution-lookup-order.md): packages in the profile's own `node_modules` win as the nearest layer, and installation package names are occupied by the generation at `$DSH_HOME/profiles/node_modules`. When a package installed into the profile declares `@deepseek-ai/*` packages under `dependencies`, pnpm installs copies into the profile and those copies run at their own versions. Official packages keep only pure-function packages under `dependencies` and declare every package with module-level identity as a peer; a third-party plugin that declares an identity-bearing dsh package as a real dependency makes that packaging choice for itself.

Capability given up: there is no recurring repair for core copies added after the compatibility marker. `desktop-runtime-state.json` is no longer read or deleted. Projections the link backend wrote are removed by the shared profile load, see the [lookup-order Note](../architecture/2026-09-19-profile-resolution-lookup-order.md).

The first reintroduction condition was met by Harnessy 0.1.5-alpha.1 and is handled by the one-time migration rather than restoring recurring cleanup. Recurring cleanup remains justified only if official packages again write competing core copies after the marker or change dependency conventions so that profiles continually regain them.

## Alternatives considered

**Keep the original cleanup.** The residue it served is no longer produced, yet it deleted directories, pruned declarations, and discarded the lockfile on every production launch, fighting the following pnpm operations.

**Delete only same-named directories under the profile's `node_modules`, leaving declarations and the lockfile alone.** The 2026-09-15 decision already rejected this: pnpm reinstalls the same old packages from the retained declarations and overrides.

**Give `@deepseek-ai/*` generation entries absolute precedence over same-named copies inside the profile.** That overrides versions plugins bring along and is a new resolution-rule decision outside the scope of removing the cleanup.

**Clean only in the installer.** The 2026-09-15 decision already rejected this: it misses other profiles and cannot reach copies recreated after installation.

## Verification

- [project-manager.spec.ts](../../../../apps/desktop/tests/project-manager.spec.ts) asserts that a current profile keeps installed packages, declarations, `desktop-runtime-state.json`, and the lockfile byte-for-byte unchanged.
- [legacy-profile-migration.spec.ts](../../../../apps/desktop/tests/legacy-profile-migration.spec.ts) asserts that only a released legacy inventory triggers the one-time compatibility write.

## Consequences

Bought: ordinary launches do not repeatedly rewrite the profile, and Desktop and the CLI apply one rule to copies installed after migration. Paid: the released legacy layout requires one guarded compatibility write; dsh copies that third-party plugins later bring into the profile as real dependencies run at their own versions.
