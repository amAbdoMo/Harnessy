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

The Windows staging launcher opens a verified, self-contained runtime under `apps/desktop/.desktop-build/staging-runtime`. Normal startup never compiles the checkout. Source-driven `pnpm run dev:desktop` still reads generated workspace artifacts and must stay offline during full builds. A successful source build does not confirm that an existing window rendered successfully.

1. While the owner uses the staging app, finish source edits with relevant checks that do not rebuild browser artifacts or run full Desktop builds, commit, and push normally. Host-only validation and normal hooks remain allowed; if a required check would rebuild the browser or run a full Desktop build, stop and arrange an offline build rather than bypassing the check. Do not run full builds, browser bundle commands, or rebuild watchers underneath that app, including the launcher's `--build-only` mode.
2. Leave runtime rebuilding to the owner after they fully quit staging, not merely close its window to the tray. Do not stop or restart the app hosting the current conversation. Documentation-only changes do not require a rebuild.
3. Run [Update-Harnessy-Staging-App.cmd](Update-Harnessy-Staging-App.cmd) to prepare an update. `Start-Harnessy-Staging-App.cmd --build-only` is an alias. The updater builds production dependencies with the existing release preparation code, materializes its own Electron, shell and runtime files, verifies runtime integrity and Host startup, and requires a rendered native window using disposable data. Only then does it atomically select the candidate. Installer compilation, publication and installed-app replacement are excluded.
4. Run [Start-Harnessy-Staging-App.cmd](Start-Harnessy-Staging-App.cmd) to open the selected runtime; `-SkipBuild` remains accepted with the same behavior. The first launch requires a successful update. Staging and the installed app can run together: staging uses `%LOCALAPPDATA%/CustomHarnessStaging` for its Harness home, Agents, logs, cache, Electron user data and Desktop profile, with a separate unpackaged Windows identity. It ignores inherited installed-app directory overrides and does not copy existing chats, accounts, MCP settings or browser logins; configure staging separately. The main app keeps `%LOCALAPPDATA%/CustomHarness`. Normal startup checks recorded critical-file hashes and prints persistent application log paths. Pass both `-RemoteUrl` and `-ListenPort` explicitly for legacy private browser access on a separate staging port; inherited listener settings are ignored.
5. An unsuccessful update leaves the current selection unchanged. The preceding runtime remains recorded in `active.json`; generations are retained for diagnosis and are never selected automatically after a startup failure. Runtime recovery must account for persisted Session/schema compatibility: older runtime files do not imply permission or support for a data downgrade. `pnpm run clean` retains the protected store and development profile when the store exists. Do not delete the runtime store while staging is running. Update logs live under `%LOCALAPPDATA%/CustomHarnessStaging/StagingDesktopLauncher` and the store's `logs` directory.
6. Report source validation, artifact verification, and actual window verification separately. If a window is blank, capture its renderer errors and launcher output before closing it; diagnostics from a reopened window cannot establish the previous failure's cause. Do not repeat successful builds as a substitute for diagnosis.

Leave sufficient free memory for the compiler and other applications during updates. Run `pnpm install --frozen-lockfile` after pulling dependency changes. The updater's packaging journal retains compiler output under the runtime store's `logs` directory even when the PowerShell transcript contains only its header.

For diagnosis after preparing artifacts separately, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/staging-launcher.ps1 -Action Update -PreparedRuntime` explicitly reuses those artifacts. It checks the declared version, verifies the materialized runtime, and runs the same copied-runtime and native-window checks before selection; it does not establish that source was freshly compiled. Normal updates always build from source.

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
