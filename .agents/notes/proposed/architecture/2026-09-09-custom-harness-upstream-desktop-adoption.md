# Agent Note: Custom Harness upstream Desktop adoption

English | [中文](2026-09-09-custom-harness-upstream-desktop-adoption.zh.md)

Status: proposed

## Problem

Upstream `dsh-v0.1.5-alpha.1` introduces a complete Electron Desktop application that replaces the Phase 8/9 Custom Harness loopback-server shell. The upstream shell has the stronger runtime boundary: it opens no listening port, carries a version-matched Node and pnpm runtime, installs a signed offline package seed, validates renderer IPC origins, and stages runtime releases with recovery. The rehearsal now wires the Custom Harness identity, profile bundle, isolated data roots, disabled automatic-updater policy, Windows icon, and release containment into that shell. Packaging, installed migration, and rollback qualification remain incomplete, so this note stays proposed.

## Proposal

Adopt the upstream Desktop application as the only active desktop package and add a narrow product configuration seam for Custom Harness. The seam must select the Custom Harness bundle after the base and Web bundles, set the public product name, application identifier, icon and artifact names, resolve the product-owned Harness and Agents roots, and keep automatic updates disabled until signed update metadata, migration, and recovery have passed the product release matrix.

Keep the Phase 8/9 JavaScript shell only as temporary comparison material during the rehearsal. Delete it, its Windows Job launcher, and its retired NSIS recipe once equivalent lifecycle, data ownership, browser, failure-recovery, and packaging coverage exists for the configured upstream shell.

The product seam is implemented as one shared runtime/build configuration consumed by the Electron main process, packaging configuration, client build, and release scripts. Packaged state resolves beneath `%LOCALAPPDATA%\CustomHarness`; development accepts only explicit absolute overrides. The release pack records a publish-disabled marker whenever it contains the Custom Harness bundle, and the publisher rejects that marker before registry access. After installed qualification and removal of the comparison shell, this note supersedes the earlier loopback-host architecture note.

## Alternatives considered

**Continue shipping the loopback-server shell.** This preserves the existing code with fewer immediate changes, but duplicates an upstream implementation that has a smaller network attack surface and a more rigorous runtime/package transaction model.

**Take the upstream Desktop package unchanged.** This is the merge baseline, but it would ship the DeepSeek Harness identity and official profile instead of the independently branded product, and it would re-enable an updater that Phase 9 intentionally deferred.

**Fork the upstream Desktop implementation into another application directory.** This avoids configuration work but creates two large shells that must receive the same security, signing, protocol, and recovery fixes.

## Acceptance criteria

- One package manifest and one Electron main entry own desktop production builds.
- The installed renderer contains the Custom Harness brand, Workspace Brief, and both feedback-disablement rows.
- The shell opens no listening port and retains sandbox, context isolation, IPC-origin checks, signed resource verification, and staged release recovery.
- Default writable roots remain isolated under the Custom Harness product root, with explicit test-only overrides.
- Automatic update UI and background checks remain absent until a separate signed-update decision is implemented.
- A clean Windows VM passes signed install, upgrade, restart, uninstall, data-migration, and cold restore rollback tests.

## Risks

The official Desktop package is new developer-preview code and its package seed assumes one release version across first-party packages. The predecessor opens suffixless Session V0 data; after the candidate creates a V3 generation, a binary-only downgrade can reopen the retained V0 generation and silently fork history rather than fail clearly. Removing the legacy shell too early would discard already-tested failure and lifecycle behavior before equivalent upstream-shell coverage exists.
