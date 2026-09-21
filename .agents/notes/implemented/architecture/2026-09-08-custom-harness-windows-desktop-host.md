# Agent Note: Custom Harness Windows desktop host

Status: implemented

English | [中文](2026-09-08-custom-harness-windows-desktop-host.zh.md)

## Problem

The customized Web profile supplies the product UI and authenticated local service, but a Windows desktop application also needs one native lifecycle owner for readiness, focus, failure presentation, browser handoff, and backend process-tree cleanup. Starting the CLI from a synchronous source wrapper cannot provide those guarantees.

## Decision

`apps/desktop` is an Electron main-process application that owns one native BrowserWindow and one customized backend. It acquires Electron's single-instance lock before backend startup and restores and focuses the existing window on another launch. On Windows, closing the primary window keeps the process alive only after the tray supplies a reopen path; the [Windows tray background lifecycle](../feature/2026-09-20-windows-tray-background-lifecycle.md) owns that later decision.

The desktop service starts the built CLI with `--profile custom-harness --host 127.0.0.1 --port 48765 --no-open`. It trusts only the authenticated `dsh web:` readiness URL for that exact loopback port, verifies the Custom Harness manifest and icon before navigation, keeps the token in memory, redacts it from diagnostics, and monitors the manifest after startup.

The BrowserWindow enables context isolation and sandboxing and disables Node integration and webviews. There is no preload bridge. Permissions are denied, navigation stays on the active service origin, and validated HTTP(S) links leave the window through the system browser.

The Windows backend runs below an MIT-attributed native launcher adapted from `deepseek-harness-desktop` v0.3.8. The launcher creates the CLI suspended, assigns it to a kill-on-close Job Object, resumes it, and waits, so stopping the launcher closes the Job handle and terminates the owned backend tree.

The source launcher verifies the named client build record and artifact digest, creates product-owned storage, compiles the Job launcher when needed, and requires either the project-installed Electron executable or an explicitly supplied audited development executable. The packaged entry resolves immutable CLI, Node.js, helper, and icon resources from Electron's resources directory while keeping Harness state, agents, browser profile data, and bounded desktop logs below `%LOCALAPPDATA%\CustomHarness`.

The Windows package recipe produces one per-user NSIS x64 installer from a clean checkout and pinned Node.js, Electron, electron-builder, and pnpm inputs. It preserves product-owned data on uninstall, includes project, wrapper, Electron, and Chromium notices, scans the unpacked application for private material, and writes a source/checksum/Authenticode manifest next to the installer. Automatic updates and a portable target remain absent.

## Recovery contract

Startup timeout, port collision, premature exit, customized-asset mismatch, backend crash, and sustained health failure enter one native Retry/Quit path. Browser-open failure leaves the service running and presents retry guidance. The Windows close control hides the primary window while the tray is available; the tray's explicit Exit action stops the backend before the process quits.

## Alternatives considered

**Adopt the community wrapper unchanged.** Its native patterns are reusable, but it pins an older stock DSH runtime and does not provide the target's customized build-record, post-start health, or recovery contracts.

**Build a WebView2/.NET host.** The installed WebView2 runtime is insufficient by itself: this development machine has no WebView2 SDK, .NET SDK, MSBuild, Visual Studio toolchain, or existing host project, and a new bridge would duplicate isolation work.

**Keep the browser-only launcher.** It retains the smallest native attack surface but cannot own a native window, single-instance focus, or the complete Windows process lifecycle required by the product.

**Select an arbitrary cached Electron archive.** This would make a development launch convenient but bypass supported-release and update review, so the source launcher fails explicitly until an installed or audited runtime is provided.

## Testing

Focused tests cover readiness validation, token redaction, timeout, asset mismatch, health failure, single-instance focus, browser handoff, navigation, renderer settings, product launch environment, bounded log rotation, distributable scanning, packaged path isolation, and representative data survival when a simulated installation directory is replaced or removed. The native helper compiles with the Windows .NET Framework compiler; a real customized backend serves the expected manifest and icon through the helper; a competing port fails with `EADDRINUSE`; and stopping the Job owner closes the service.

The managed task host denies Chromium AppContainer/cache grants before renderer startup. Strict-sandbox native rendering, resizing, focus, repeated second launch, browser sharing, crash recovery presentation, and repeated clean exits remain explicit target-machine checks; this environmental limitation does not justify weakening the product security settings.

## Consequences

Custom Harness gains one native Windows lifecycle owner without forking its Web application or exposing Electron privileges to the renderer. Browser and desktop views share the existing authenticated service, session storage, and interaction owners.

The desktop source adds Electron release maintenance, Chromium notices, native packaging, code-signing, clean-machine installation, upgrade, uninstall, and Windows target validation as ongoing responsibilities. A fixed local port makes collision recovery deterministic but reserves port 48765 while the application runs.
