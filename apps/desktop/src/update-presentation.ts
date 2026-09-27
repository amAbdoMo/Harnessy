/** Semantic content for the Web-localized optional Desktop status indicator. */
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateState } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u
const DISK_FAILURE = /\b(?:ENOSPC|not enough (?:free )?space|insufficient disk space)\b/iu
const REVOKED_FAILURE = /\b(?:release|update) (?:was )?(?:revoked|withdrawn|superseded)\b/iu

/**
 * Classify one updater failure for both native and Web-localized summaries.
 * @param state Update failure and its operation.
 * @returns Stable presentation kind without raw diagnostics.
 */
function desktopUpdateFailureKind(state: DesktopUpdateState): DesktopUpdateFailureKind {
  if (state.failedOperation === 'install' && state.preparationFailure !== undefined) return state.preparationFailure
  const message = state.message ?? ''
  if (DISK_FAILURE.test(message)) return 'disk'
  if (REVOKED_FAILURE.test(message)) return 'revoked'
  const operation = state.failedOperation ?? 'install'
  if (operation === 'verify') return 'verify'
  return NETWORK_FAILURE.test(message) ? `${operation}-network` : operation
}

/**
 * Select user-facing error copy independently of raw updater diagnostics.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale.
 * @returns Localized summary suitable for both a dialog and a tooltip.
 */
export function desktopUpdateErrorSummary(state: DesktopUpdateState, messages: DesktopMessages): string {
  const kind = desktopUpdateFailureKind(state)
  const summaries: Readonly<Record<DesktopUpdateFailureKind, string>> = {
    check: messages.updateCheckFailed,
    'check-network': messages.updateCheckNetworkFailed,
    download: messages.updateDownloadFailed,
    'download-network': messages.updateDownloadNetworkFailed,
    verify: messages.updateVerifyFailed,
    disk: messages.updateDiskFailed,
    revoked: messages.updateRevokedFailed,
    install: messages.updateInstallFailed,
    'install-network': messages.updateInstallNetworkFailed,
    'stop-failed': messages.updateStopFailed,
    'tasks-changed': messages.updateTasksChanged,
    'tasks-unavailable': messages.updateTasksUnavailable,
  }
  return summaries[kind]
}

/**
 * @param state - Main-process updater state.
 * @returns Semantic status without localized copy, diagnostics, or installation controls.
 */
export function presentDesktopUpdate(state: DesktopUpdateState): DesktopUpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.transferredBytes === undefined ? {} : { transferredBytes: state.transferredBytes }),
    ...(state.totalBytes === undefined ? {} : { totalBytes: state.totalBytes }),
    ...(state.phase === 'error' ? { failure: desktopUpdateFailureKind(state) } : {}),
  }
}
