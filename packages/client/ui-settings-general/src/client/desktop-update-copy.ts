/**
 * Copy projection for the Desktop update surfaces. Every string resolves from
 * the active `settings` locale, so the sidebar control, the collapsed badge,
 * and the General row stay in step through an in-application language change.
 * @module @deepseek-ai/dsh-client-ui-settings-general/desktop-update-copy
 */

import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateFailureKind, DesktopUpdatePhase, DesktopUpdatePresentation } from '../types.ts'
import type { SettingsKey } from './locales.ts'

/** Phases whose shell operation is already running. */
const BUSY_PHASES: ReadonlySet<DesktopUpdatePhase> = new Set([
  'checking', 'downloading', 'verifying', 'installing',
])

/**
 * Whether a repeat shell request must join the operation already running.
 * @param phase - current shell update phase.
 * @returns true while a check, transfer, verification, or installation is active.
 */
export function updateBusy(phase: DesktopUpdatePhase): boolean {
  return BUSY_PHASES.has(phase)
}

/** The dictionary-bound translate seat the settings components receive. */
export type SettingsTranslate = PropsLocale<'settings'>['t']

/** Accessible name and hover/focus tooltip of one update state. */
export interface DesktopUpdateCopy {
  readonly label: string
  readonly detail: string
}

/** Phase labels other than `downloading`, whose label carries the live percentage. */
const PHASE_LABELS: Readonly<Record<
  Exclude<DesktopUpdatePresentation['phase'], 'idle' | 'downloading'>,
  SettingsKey
>> = {
  checking: 'desktop.update.checking',
  available: 'desktop.update.available',
  verifying: 'desktop.update.verifying',
  ready: 'desktop.update.ready',
  waiting: 'desktop.update.waiting',
  installing: 'desktop.update.installing',
  error: 'desktop.update.retry',
}

/** One copy key per classifier the shell can report. */
const FAILURE_LABELS: Readonly<Record<DesktopUpdateFailureKind, SettingsKey>> = {
  check: 'desktop.update.checkFailed',
  'check-network': 'desktop.update.checkNetworkFailed',
  download: 'desktop.update.downloadFailed',
  'download-network': 'desktop.update.downloadNetworkFailed',
  verify: 'desktop.update.verifyFailed',
  disk: 'desktop.update.diskFailed',
  revoked: 'desktop.update.revokedFailed',
  install: 'desktop.update.installFailed',
  'install-network': 'desktop.update.installNetworkFailed',
  'stop-failed': 'desktop.update.stopFailed',
  'tasks-changed': 'desktop.update.tasksChanged',
  'tasks-unavailable': 'desktop.update.tasksUnavailable',
}

/**
 * Shell progress as a whole percentage inside 0–100. The preload crosses a
 * process boundary, so a missing or out-of-range value is clamped rather than
 * trusted into the progress ring's geometry.
 * @param state - the presentation carrying the optional percentage.
 * @returns the percentage to render.
 */
export function updatePercent(state: DesktopUpdatePresentation): number {
  return Math.min(100, Math.max(0, Math.round(state.percent ?? 0)))
}

/**
 * Transfer sizes for the progress popover.
 * @param state - the presentation carrying the optional byte counts.
 * @returns the localized size text, or nothing while the shell reports neither count.
 */
export function updateBytesText(state: DesktopUpdatePresentation): string | undefined {
  const { transferredBytes, totalBytes } = state
  if (transferredBytes === undefined) return totalBytes === undefined ? undefined : fileSizeText(totalBytes)
  if (totalBytes === undefined) return fileSizeText(transferredBytes)
  return `${fileSizeText(transferredBytes)} / ${fileSizeText(totalBytes)}`
}

/**
 * Whether any surface shows this status at all.
 * @param view - carrier status: the last presentation plus the failure flag.
 * @returns true when a surface must paint, false for a browser or an idle carrier.
 */
export function updateVisible(view: { failed: boolean; presentation?: DesktopUpdatePresentation }): boolean {
  return view.failed || (view.presentation !== undefined && view.presentation.phase !== 'idle')
}

/**
 * Resolve one state's accessible name and tooltip detail.
 * @param state - the last published presentation, absent before the first status reply.
 * @param failed - a rejected status read or shell action, which supersedes the state.
 * @param t - the dictionary-bound translate seat.
 * @returns the label and detail; both are empty for an idle or unknown carrier.
 */
export function desktopUpdateCopy(
  state: DesktopUpdatePresentation | undefined,
  failed: boolean,
  t: SettingsTranslate,
): DesktopUpdateCopy {
  if (failed) {
    const retry = t('desktop.update.retry')
    return { label: retry, detail: retry }
  }
  if (state === undefined || state.phase === 'idle') return { label: '', detail: '' }
  const percent = updatePercent(state)
  const label = state.phase === 'downloading'
    ? t('desktop.update.progressLabel', { percent })
    : t(PHASE_LABELS[state.phase])
  if (state.phase === 'error') {
    const failure = FAILURE_LABELS[state.failure ?? 'install']
    return { label, detail: t(failure) }
  }
  if (state.phase === 'downloading') {
    return { label, detail: state.version === undefined
      ? label
      : t('desktop.update.downloadDetail', { percent, version: state.version }) }
  }
  if (state.phase === 'waiting') {
    const scheduled = t('desktop.update.waitingDetail')
    return { label, detail: state.version === undefined
      ? scheduled
      : t('desktop.update.versionDetail', { label: scheduled, version: state.version }) }
  }
  return { label, detail: state.version === undefined
    ? label
    : t('desktop.update.versionDetail', { label, version: state.version }) }
}
