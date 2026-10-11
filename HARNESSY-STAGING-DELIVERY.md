---
description: "Finish successful Harnessy staging changes with a verified remote backup while keeping master, tags, and releases explicit."
---

# Cookbook: delivering Harnessy staging changes

## Summary

Use this procedure after changing the Harnessy `staging` branch. A completed change is tested, committed without unrelated files or secrets, and pushed to `origin/staging` so another computer can recover it. This backup does not update the installed application or publish a release.

## Table of Contents

- [Delivery rule](#delivery-rule)
- [Failure and release limits](#limits)
- [Safe staging builds](#safe-builds)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="delivery-rule"></a>
## Delivery rule

After the relevant checks pass, commit only the intended files, push the commit to `origin/staging`, verify that the remote branch names the commit, and report the commit hash, checks, and clean worktree status. A review-only task or an explicit no-commit request remains read-only.

-----

<a id="limits"></a>
## Failure and release limits

Stop and report instead of committing or pushing when checks fail, conflicts or unexplained changes exist, secrets may be included, or the remote moved unexpectedly. Never push `master`, create or move a tag, approve a release, create a GitHub release, or publish a release without a direct user request for that operation.

-----

<a id="safe-builds"></a>
## Safe staging builds

The staging app reads generated artifacts from this checkout. Client HMR publishes rebuilt plugin bundles while the process is running; a successful build or artifact digest check does not confirm that an existing window rendered successfully.

1. While the owner uses the staging app, finish source edits with relevant checks that do not rebuild browser artifacts or run full Desktop builds, commit, and push normally. Host-only validation and normal hooks remain allowed; if a required check would rebuild the browser or run a full Desktop build, stop and arrange an offline build rather than bypassing the check. Do not run full builds, browser bundle commands, or rebuild watchers underneath that app, including the launcher's `--build-only` mode.
2. Leave runtime rebuilding to the owner after they fully quit staging, not merely close its window to the tray. Do not stop or restart the app hosting the current conversation. Documentation-only changes do not require a rebuild.
3. From the checkout, run [Start-Harnessy-Staging-App.cmd](Start-Harnessy-Staging-App.cmd) to build, prepare, and open staging. To separate building from opening, run `Start-Harnessy-Staging-App.cmd --build-only`, then `Start-Harnessy-Staging-App.cmd -SkipBuild` after the build succeeds. Quit the installed Harnessy app before opening staging, as required by the launcher.
4. Report source validation, artifact verification, and actual window verification separately. If a window is blank, capture its renderer errors and launcher output before closing it; diagnostics from a reopened window cannot establish the previous failure's cause. Do not repeat successful builds as a substitute for diagnosis.

-----

<a id="verification"></a>
## Verification

Confirm the local and remote commits after pushing:

```sh
git status --short --branch
git rev-parse HEAD
git ls-remote --heads origin staging
```

The `HEAD` and `refs/heads/staging` hashes must match, and the worktree must contain no unintended changes.

-----

<a id="dev-note"></a>
## Dev Note

None.
