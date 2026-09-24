# Agent Note: Windows tray background lifecycle

Status: implemented

English | [中文](2026-09-20-windows-tray-background-lifecycle.zh.md)

## Problem

Closing the Harnessy window also stopped the Desktop Host, so an active Session could not continue after the user cleared the window from the taskbar. Keeping the process alive without a reliable way to restore its window would be worse because the user could lose control of an invisible application.

## Decision

Harnessy installs a Windows system-tray icon before it enables background mode. Closing the primary window then prevents destruction and hides the window while the Electron process, Desktop Host, and active Sessions continue running. Selecting the tray icon, choosing **Open Harnessy**, launching Harnessy again, or selecting a native notification restores and focuses the same window.

The tray menu provides **Exit Harnessy** as the explicit shutdown operation. Electron records the quit request before window closing begins, stops the Desktop Host to quiescence through the existing asynchronous shutdown path, permits the window to close, and destroys the tray icon during final process exit.

Tray creation is a prerequisite rather than a cosmetic enhancement. If Windows cannot load a non-empty tray image or create the tray object, background mode remains disabled and closing the last window follows the normal exit path. Other operating systems retain their existing window lifecycle.

## Alternatives considered

**Always exit from the window close control.** This keeps shutdown obvious but interrupts active Sessions when the user only wants to remove Harnessy from the taskbar.

**Keep running without requiring a tray.** This preserves work but can leave an inaccessible background process with no visible restore or exit control.

**Add a background-mode preference.** A preference offers per-user choice but adds another lifecycle state and still needs a dependable explicit exit. Windows uses tray-backed persistence consistently, while **Exit Harnessy** remains the direct opt-out for the current process.

## Testing

Focused lifecycle tests prove that Windows hides the primary window only after tray readiness, explicit quit disables hiding and background retention, and other platforms do not enter tray-backed mode. Desktop build and packaged Windows verification exercise the Electron wiring and icon resource.

## Consequences

Active Sessions continue when the primary window closes, and the tray gives the user stable restore and exit controls. Harnessy continues consuming the resources required by its running Sessions until the user chooses **Exit Harnessy** or Windows ends the process.

Background persistence depends on successful tray creation. This condition prevents a silent process from outliving every user-visible control and keeps shutdown recovery on the existing Desktop Host teardown path.
