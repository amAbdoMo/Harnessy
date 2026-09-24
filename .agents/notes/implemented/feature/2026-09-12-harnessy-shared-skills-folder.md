# Agent Note: Harnessy shared skills folder

Status: implemented

English | [中文](2026-09-12-harnessy-shared-skills-folder.zh.md)

## Problem

Harnessy intentionally redirects its DSH and agent homes into `%LOCALAPPDATA%\CustomHarness` so sessions, credentials, and settings cannot collide with another harness. That isolation also redirects the ordinary user `.agents\skills` root, preventing a personal skill installed for Codex, Pi, or another compatible agent from appearing in Harnessy.

## Decision

The `custom-harness` profile mounts one global `skill-filesystem` instance named `harnessy-shared-skills`. Its settings-backed custom root defaults to `%USERPROFILE%\.agents\skills`, while the preset-scoped filesystem providers retain Harnessy's private DSH and agent roots. The shared provider contains no default project, user, or bundled roots of its own.

The `harnessy-shared-skills` settings namespace stores an `enabled` boolean and one absolute `directory`. Settings > General exposes those values through a switch, the native folder picker, and a reset-to-default action. An accepted settings change replaces only the global shared provider after closing its previous watcher, so discovery changes without restarting the application.

Project `.dsh\skills` and `.agents\skills` roots keep their existing priority over custom roots. A project-specific skill therefore wins over a same-named personal skill, while the selected shared root remains available to every Harnessy preset and workspace.

## Alternatives considered

- **Point Harnessy's entire agent home at `%USERPROFILE%\.agents`** — rejected because it would also merge product-owned state and weaken the deliberate application-data boundary.
- **Copy skills into Harnessy's private home** — rejected because copies drift and require repeated manual synchronization.
- **Hard-code the shared directory without a setting** — rejected because users need to disable sharing or select a different compatible skill collection without rebuilding Harnessy.

## Consequences

Harnessy shares only the selected skill directory; sessions, settings, accounts, and credentials remain private to the product. New, renamed, removed, or edited skill definitions become visible through filesystem watching, and folder changes take effect live. The feature adds one global skill provider and one durable settings namespace, so tests cover provider replacement, disablement, invalid paths, folder-picker cancellation, and read-only UI behavior.
