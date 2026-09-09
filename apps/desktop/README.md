# `@deepseek-ai/dsh-custom-harness-desktop`

English | [中文](README.zh.md)

This private package is the Windows Electron host for the Custom Harness profile. The Electron main process owns one native window and one built `dsh --profile custom-harness` backend; it does not ship another frontend or expose a preload bridge.

## Source execution

Build the customized artifacts with `npm run build:custom-harness`, set `CUSTOM_HARNESS_ELECTRON_EXECUTABLE` to an explicitly audited Electron 44.2.0 executable, then run `npm run custom-harness:desktop`. The launcher also accepts an exact project-installed runtime; it does not download or select arbitrary cached archives.

The launcher uses `%LOCALAPPDATA%\CustomHarness` by default and accepts the existing `CUSTOM_HARNESS_DATA_DIR`, `CUSTOM_HARNESS_HOME`, `CUSTOM_HARNESS_AGENTS_DIR`, `CUSTOM_HARNESS_LOG_DIR`, and `CUSTOM_HARNESS_CACHE_DIR` test/development overrides. It verifies `.dsh-build/client-build-environment.json` before opening the host.

## Windows packaging

`npm run package:custom-harness:win` builds the NSIS x64 installer from a clean checkout. Packaging requires `CUSTOM_HARNESS_NODE_RUNTIME` to identify the audited Node.js 24.19.0 Windows runtime, `CUSTOM_HARNESS_ELECTRON_DIST` to identify the audited Electron 44.2.0 distribution, and `CUSTOM_HARNESS_PUBLISHER_NAME` to contain the product owner's exact legal publisher name. The package recipe pins electron-builder 26.15.7 and pnpm 11.7.0.

A successful build writes `apps/desktop/dist/CustomHarness-Setup-0.1.2-rc.1-windows-x64.exe` and a neighboring JSON manifest containing source, input, checksum, artifact-scan, and Authenticode status. An unsigned artifact remains labeled `UNSIGNED` and is not distribution-ready. Automatic updates and a portable target are not enabled.

## Installed data

Immutable application resources remain under the selected installation directory. Sessions, settings, credentials, and Harness state use `%LOCALAPPDATA%\CustomHarness\Harness`; skills use `%LOCALAPPDATA%\CustomHarness\Agents`; Electron profile data uses `%LOCALAPPDATA%\CustomHarness\Cache\DesktopUserData`; and desktop diagnostics use `%LOCALAPPDATA%\CustomHarness\Logs`.

The NSIS uninstall recipe preserves this product-owned data by default. Desktop diagnostics rotate at 1 MiB and retain three archives. The package-level lifecycle test proves that changing or removing a simulated installation directory leaves representative product-owned state intact; a release still requires clean-machine install, upgrade, and uninstall validation.

## Lifecycle and failure behavior

Electron acquires the single-instance lock before backend startup. The backend binds `127.0.0.1:48765`, emits an authenticated readiness URL, and runs below the Windows Job launcher. Startup timeout, port collision, early exit, product-asset mismatch, backend crash, and sustained health failure present Retry/Quit recovery; File → Open in Browser reuses the authenticated service URL.

Closing the window exits the application and stops the Job owner. The product intentionally has no tray lifecycle. Browser-open failure leaves the service running so the command can be retried.

## Security

The BrowserWindow enables context isolation and sandboxing while disabling Node integration and webviews. No preload script is installed. Permission requests are denied, window navigation is restricted to the active loopback origin, external HTTP(S) destinations open in the system browser, and launch tokens are redacted from desktop diagnostics.

## Windows helper license

`native/windows-job-launcher.cs` is adapted from the MIT-licensed DeepSeek Harness Desktop wrapper. The original notice and terms are retained in [`third-party-licenses/deepseek-harness-desktop-LICENSE`](third-party-licenses/deepseek-harness-desktop-LICENSE).

## Model Experience

The desktop host does not alter prompts, tools, model context, sessions, or command execution. Desktop and browser clients use the same customized backend and Web application; native lifecycle failures remain outside model-visible conversation content.
