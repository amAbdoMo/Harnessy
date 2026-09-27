---
description: "Finish successful Harnessy staging changes with a verified remote backup while keeping master, tags, and releases explicit."
---

# Cookbook: delivering Harnessy staging changes

## Summary

Use this procedure after changing the Harnessy `staging` branch. A completed change is tested, committed without unrelated files or secrets, and pushed to `origin/staging` so another computer can recover it. This backup does not update the installed application or publish a release.

## Table of Contents

- [Delivery rule](#delivery-rule)
- [Failure and release limits](#limits)
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
