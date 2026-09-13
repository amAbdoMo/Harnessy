# Agent Note: Combined model and thinking picker

Status: implemented

English | [中文](2026-09-13-combined-model-thinking-picker.zh.md)

## Problem

The composer split model and reasoning selection across nested menus. Comparing provider models was cramped, changing both values required reopening the control, and the interface could not distinguish an intentional pair change from changing only one dimension.

## Decision

The composer model seat opens one centered, searchable dialog with provider-grouped models on the left and the staged model's advertised thinking levels on the right. A single model click stages that model; the next single thinking-level click submits the complete pair and closes after Host acceptance. A model double-click submits only the model while preserving a supported current effort or falling back to the target default. A thinking-level double-click submits that effort against the persisted current model.

The single thinking-level action waits 230 milliseconds so a browser double-click can cancel the pending pair submission. Closing by the visible button, Escape, or mask discards the draft. Selection rejection keeps the dialog open and uses the existing toast surface. The dialog renders immediately from the shared resident catalog, filters locally, and reloads only from an idle or failed catalog state.

The desktop window now appears before packaged-runtime reconciliation and shows the existing branded startup page while that work completes. Warm launches compare the active profile with the packaged integrity manifest first and skip the expensive file-by-file seed verification when the seed will not be consumed. Installs and upgrades still perform the complete verification before packaged content can enter writable state.

Windows installers keep `com.amabdmo.customharness`, `Harnessy.exe`, and the `Harnessy` shortcut name stable. Installation-directory changes are disabled so an upgrade reuses the registered location and electron-builder retains shortcuts instead of deleting and recreating the target behind a taskbar pin.

## Alternatives considered

- **Keep nested menus** — rejected because they hide model and effort context and require serial reopening.
- **Add an Apply button** — rejected because the requested model-then-effort gesture already creates a complete selection.
- **Submit an effort immediately on click** — rejected because browsers deliver click events before `dblclick`, making effort-only double-click unreliable without the short delay.
- **Keep selectable install directories** — rejected because electron-builder intentionally disables shortcut retention for manually launched installers that may relocate the application.

## Consequences

The picker adds no startup request or dependency. The user sees a responsive Harnessy window during a cold upgrade, and ordinary matching-profile launches avoid the seed scan. A normal pair change has a short, intentional double-click recognition delay before it closes. Models without reasoning metadata complete on their model click. Users may need to pin Harnessy once after upgrading from an older installer whose executable path or shortcut was already replaced; future same-identity upgrades preserve that pin, while a fresh install uses the normal per-user Windows application directory.
