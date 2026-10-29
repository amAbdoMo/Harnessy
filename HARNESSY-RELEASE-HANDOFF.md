---
description: "Agent instructions for publishing Harnessy Windows in-app updates without manually installing or restarting the main app."
---

# Harnessy Windows release handoff

## Summary

Read this file before planning or performing a Harnessy release. Publish a verified stable GitHub update that the installed application can discover through **Check for Updates**. Do not manually install it, replace installed files, or restart the main app.

## Table of Contents

- [Request meaning and saved preferences](#request-meaning-and-saved-preferences)
- [Preserve the customized Harnessy app](#preserve-the-customized-harnessy-app)
- [Preflight](#preflight)
- [Approval and preparation](#approval-and-preparation)
- [Publication and verification](#publication-and-verification)
- [Interrupted runs and local work](#interrupted-runs-and-local-work)
- [Completion report](#completion-report)
- [Dev Note](#dev-note)

## Request meaning and saved preferences

- Requests such as “make a release so the main app gets the update,” “publish the next in-app update,” or “release it like last time” mean the complete release operation: prepare, qualify, package, tag, verify a draft, and publish it as the stable latest release. They do not mean manually applying the update on this computer.
- Do not ask the user to explain this distinction again, choose between an installer and an in-app update, or separately authorize publication when the direct request already asks for a published in-app update.
- A request only to build or push `master` does not authorize a release. Follow the [delivery limits](HARNESSY-STAGING-DELIVERY.md#limits).
- Keep the existing personal unsigned Windows x64 channel. Do not introduce EV signing, change repositories or channels, create an additional app/worktree copy, or reinstall the app without a separate request. Required packaging artifacts belong in the existing Desktop target build directory.
- The user will use the application's updater. The updater may close and relaunch the app after the user confirms installation; the agent must not trigger that action.

## Preserve the customized Harnessy app

A release request is **not an upstream synchronization request**. Build from the approved Harnessy fork source, including its existing custom features and product decisions. Do not substitute a fresh stock DeepSeek Harness checkout, an upstream release, or a bulk feature import for that source. Do not fetch and integrate upstream changes, rebase onto upstream, reset to upstream, or cherry-pick upstream features as an implicit prerequisite to publishing. Ordinary release checks and fetching the fork's `origin/master` remain part of the existing release workflow.

Preserve Harnessy's custom accounts/models, MCP manager, subagent settings and routing, workspaces, notification behavior, branding, local-state isolation, Desktop lifecycle, and any newer custom features. The list is not exhaustive: inspect the current fork and intended release diff, not just this handoff. Compare the candidate against the last published Harnessy tag and verify that the changes are the intended Harnessy work; stop for clarification if the candidate's origin or an unexplained replacement/removal of custom behavior is uncertain. Do not silently include unfinished or unrelated local changes.

Before selecting a clean release checkout, inventory the owner's intended staging workspace, including tracked edits and untracked source files. Record the included features and the changes still pending. If the intended changes are uncommitted, absent from `origin/staging`, or absent from the selected candidate, stop preparation until they are reviewed, committed and delivered; never substitute an older clean checkout without identifying the omissions. Local promotion checks the fetched staging source and allows only its validated family-version successor for interrupted-run recovery. Repeat the source comparison before remote changes. A successful hosted build creates an artifact; only verified publication makes that version available through Check for Updates.

### Saved installation data

Each installation owns its saved default and custom subagents, their settings, added models, MCP definitions/settings, accounts, subscription references and chat history. Release payloads contain application code and defaults, never a developer's saved setup or credentials. Upgrades must retain configured values; shipped defaults may initialize missing values but must not reset or replace saved choices. Any required data migration must preserve the user's configuration and follow the persistence compatibility rules. Keep installed and staging data separate.

Qualify preservation with synthetic settings and opaque credential fixtures, including existing default and custom subagent assignments, models, MCPs, accounts/subscription references and chats. Readiness includes the approved Browser controls, inline annotation and taskbar behavior. Run the product-preservation and upgrade-settings checks before release packaging, and retain their actual results. Do not copy or upload live user settings to perform these checks; remote subscription entitlements remain owned by their provider.

If the user separately requests upstream synchronization, first follow the [upstream handoff](HARNESSY-UPSTREAM-HANDOFF.md#protect-decisions): classify improvements as Adopt, Adapt, or Skip, preserve existing Harnessy owners, and ask before changing custom user-visible behavior. Never resolve a conflict by wholesale taking the upstream side, removing custom code, duplicating an existing feature page, or replacing Harnessy defaults just to get a build to pass. Run the documented product-preservation guard and relevant custom-feature tests before releasing synchronized code; a passing product guard does not establish that every custom feature survived.

## Preflight

1. Determine the actual working directory, branch, linked worktrees, remote URLs, and live local/remote commits. Never infer them from an old handoff or a previous job id.
2. Query the latest published stable release and inspect the root and Desktop manifest versions. Choose a strictly newer stable version; never hardcode a previous “next version” or reuse an existing tag for different code.
3. Inspect the installed updater configuration without launching the app or reading credentials. The established feed is GitHub owner `amAbdoMo`, repository `Harnessy`, channel `latest`, release type `release`. Publication alone does not prove the installed app has upgraded.
4. Preserve unrelated tracked and untracked work. The approval workflow requires clean staging and linked `master` worktrees. Obtain permission before temporarily shelving unrelated files; save exact hashes and the scoped stash identity, and never discard, commit, or silently ignore those files to pass the clean-tree check.
5. Resolve the available Node and pnpm executables from the session/runtime environment; do not assume global `pnpm` exists. Git hooks must also be able to resolve Node and pnpm. On Windows, a library-driven invocation needs the correct `npm_execpath` pointing to pnpm's JavaScript entry.
6. Read the [Desktop release instructions](apps/desktop/README.md) and [approval implementation](apps/desktop/scripts/promote-windows-release.ts). Inspect failed relevant CI before publication; do not describe pending or skipped checks as passed.

## Approval and preparation

Use the existing workflow, not a new release implementation. The command references below are for an actual release request, not commands to rerun merely to validate this document.

```sh
pnpm run release:win:x64:approve -- --version "$version"
```

- Set `version` to the stable version chosen from live state. The exact required confirmation is `APPROVE v<version> win-x64`. Ask for that phrase once per release, explicitly identifying it as approval to publish an **in-app update**, not manual installation. A past version's approval is not authorization for a new version.
- The CLI requires an interactive terminal. In a GUI-only session, use the exported `promoteWindowsRelease` API with a real command adapter and compare its requested phrase with the user's actual typed answer. The adapter must reject nonzero command exits and return real status/stdout for inspections, as the implementation's command adapter does. Never fabricate a TTY, hardcode confirmation to true, use mock runners, or override platform/deployment checks.
- The workflow performs the whole-family version bump, focused updater qualification, exact-commit tagging, production unsigned packaging, local artifact/feed checks, tag push, draft creation and byte verification, then ancestry-checked local `master` fast-forward and lease-protected remote promotion. Do not manually bump only a few manifests or move master before draft verification.
- Preparation finishes with a verified **draft**, not a published update. Read the real result and completion record before advancing. Deliver completed source commits to `origin/staging` under the [staging delivery rule](HARNESSY-STAGING-DELIVERY.md).

### Hosted Windows builds

The saved hosted-build preference uses the existing `release-package` job in [Harnessy Windows](.github/workflows/custom-harness-windows.yml), preserving the local `master` checkout. Apply the reviewed release changes to the existing clean release checkout, retain newer fork fixes, run focused checks, and deliver the exact approved version commit to `origin/staging`. Dispatch that branch with `release_version` set to the confirmed stable version. Never dispatch an older clean commit that omits the reviewed changes.

Require both Desktop checks and the production release job to succeed at that exact commit. Download its five-file qualified artifact into the existing Desktop target output, preserving any earlier artifact separately. Verify the completion record, installer/blockmap/feed hashes and packaged updater settings against the installed feed before creating the exact tag and byte-verified draft through the existing GitHub release commands. Build success alone does not complete publication.

For the saved remote-only promotion preference, leave local `master` files, index, commits and stashes untouched. After draft verification, confirm the fetched live remote `master` is an ancestor of the qualified commit and push only that commit with an explicit lease against the observed remote head. The preserved local `master` head and the remote lease may differ. Stop on concurrent remote movement; retain preservation evidence. Publish through the existing command and complete the public checks below.

## Publication and verification

For the direct in-app release request, proceed to publication after preparation succeeds; do not stop at the draft or ask again whether the user wants it published.

```sh
pnpm run release:win:x64:publish
```

The [GitHub release implementation](apps/desktop/scripts/github-windows-release.ts) checks the production unsigned completion record, tag commit, artifact bytes, installer SHA-512 in the updater feed, and byte-identical draft before publishing as latest.

After publication, independently verify:

- The release is public, stable, not a draft, and selected by GitHub's latest-release endpoint.
- The installer, its `.exe.blockmap`, and `latest.yml` are the complete three-asset set; their sizes and GitHub SHA-256 digests match the package completion record.
- The public `releases/latest/download/latest.yml` endpoint returns the intended version and exact recorded feed bytes. Its installer name, size, and SHA-512 must describe the qualified installer.
- The release tag and promoted `master` name the qualified package commit; `origin/staging` contains the completed source changes.
- The packaged updater configuration still uses the same GitHub feed as the installed application. A generic URL in the build completion record is not a substitute for inspecting the packaged updater configuration.
- Unrelated local work is restored exactly and installed application files have not been replaced by the agent. Do not exercise installation or restart on the main app as a verification step.

## Interrupted runs and local work

- Track every background job. Wait on the real job when blocked; do not busy-poll, repeatedly issue identical calls, or start another build simply because output is slow.
- After a session resume, inspect durable state before rerunning. If a job id is unavailable, inspect the packaging journal and specifically owned processes. An absent completion result is not success, and an interrupted process is not evidence of a failed test.
- Reuse the existing approval workflow's exact-tag and byte-verified artifact/draft recovery. A tag or draft at a different commit is a stop condition, not permission to replace it. If qualified code must change, choose a new release version rather than force-moving the published identity.
- Restore only the scoped user files, including on failure. Never overwrite concurrent edits. Verify their original hashes before dropping the task-owned stash and removing its backups; leave other stashes and files untouched.
- Do not create rollback copies of the installed app, run the setup executable, invoke `quitAndInstall`, close the app, or start a replacement GUI server.

## Completion report

Report the published version and release URL, successful artifact/public-feed verification, actual relevant checks, and preservation of local work. Tell the user to use **Check for Updates inside Harnessy**; do not provide a manual-install task or claim publication already upgraded their running app. Report a concrete blocker instead of claiming completion if publication or verification failed.

## Dev Note

The repository copy is authoritative. A Desktop handoff may include a dated verified snapshot and a copy of these instructions, but every release starts by querying live state and reading the current implementation.
