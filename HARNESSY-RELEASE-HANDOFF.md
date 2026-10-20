---
description: "Agent instructions for publishing Harnessy Windows in-app updates without manually installing or restarting the main app."
---

# Harnessy Windows release handoff

## Summary

Read this file before planning or performing a Harnessy release. Publish a verified stable GitHub update that the installed application can discover through **Check for Updates**. Do not manually install it, replace installed files, or restart the main app.

## Table of Contents

- [Request meaning and saved preferences](#request-meaning-and-saved-preferences)
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

## Preflight

1. Determine the actual working directory, branch, linked worktrees, remote URLs, and live local/remote commits. Never infer them from an old handoff or a previous job id.
2. Query the latest published stable release and inspect the root and Desktop manifest versions. Choose a strictly newer stable version; never hardcode a previous “next version” or reuse an existing tag for different code.
3. Inspect the installed updater configuration without launching the app or reading credentials. The established feed is GitHub owner `amAbdoMo`, repository `Harnessy`, channel `latest`, release type `release`. Publication alone does not prove the installed app has upgraded.
4. Preserve unrelated tracked and untracked work. The local approval command requires clean staging and linked `master` worktrees; the cloud route below also supports an explicitly approved remote-only promotion with local master untouched. Obtain permission before temporarily shelving unrelated files; save exact hashes and the scoped stash identity, and never discard, commit, or silently ignore those files to pass the clean-tree check.
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

### GitHub-hosted package builds

When the user approves a cloud build instead of installing a local Windows compiler, use the existing [Harnessy Windows workflow](.github/workflows/custom-harness-windows.yml) with its `release_version` input. This route moves compilation and native qualification to GitHub's Windows runner; it does not waive the toolchain check or publish automatically. Keep the same exact human version approval and use `pnpm run release:dsh "$version"` for the complete family bump. Commit and deliver the approved source to staging before dispatch:

```sh
gh workflow run custom-harness-windows.yml --repo amAbdoMo/Harnessy --ref staging --field release_version="$version"
```

The read-only release-package job requires the official staging ref, matching stable root/Desktop versions, and the exact dispatched commit. It runs the product checks, updater qualification, production unsigned packaging and existing release-input byte checks. Its artifact contains only the installer, blockmap, feed, completion record and a readback of the actual packaged updater settings; it cannot push tags or refs, create drafts, or publish releases.

Before using the downloaded package, verify the successful workflow run's repository, workflow, event, ref and source SHA, then verify the completion record and every artifact hash against that same commit and approved version. Download into the existing isolated Desktop target artifact directory, not the installed app. Create or accept only an exact local release tag and run `release:github:win:x64:check`. Only then push that tag and run the existing draft and verify commands. With permission to shelve owner work, fast-forward the clean linked master and restore that work as in the local workflow. If the user chooses to leave a dirty local master untouched, preserve its HEAD, index, files and stashes, and push only GitHub's master from the clean qualified checkout with the same ancestry check, normal hooks and explicit captured remote lease; the local branch may remain behind. Verify local owner work and installed artifacts are unchanged, then continue with the normal publication command below. A failed cloud build or mismatched artifact, tag, draft or ref stops publication; never relabel an older package or replace a published identity.

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
