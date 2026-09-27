/**
 * Sidebar workspace-header control for the optional Desktop update carrier: one
 * icon-only 28px control beside the notification bell, registering into
 * `sidebar.workspaces.headerActions`. It paints nothing in a browser (no
 * carrier) and nothing while the shell reports `idle`. Download progress, a
 * staged restart, and failures each open or announce their own state; every
 * shell action stays with the preload bridge.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Button, IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconWarningTriangleOutlineRegular,
  Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CSSProperties, RefObject } from 'react'
import type { DesktopUpdatePresentation, DesktopUpdateView } from '../types.ts'
import {
  desktopUpdateCopy, type SettingsTranslate, updateBytesText, updatePercent, updateVisible,
} from './desktop-update-copy.ts'
import css from './DesktopUpdateControl.module.css'

const MEASURE_STYLE = { left: 0, top: 0, visibility: 'hidden' as const }

/** Progress-ring geometry; the arc is a fraction of this circumference. */
const RING_RADIUS = 8.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Carrier status and the two shell actions this control may request. */
export interface DesktopUpdateControlInjected {
  hooks: { desktopUpdate: ObservableSnapshot<DesktopUpdateView> }
  /** Open the shell's update flow: download, install, or retry. */
  open(): void
  /** Cancel a staged restart that is waiting for running tasks. */
  cancelRestart(): void
}

/** Phrases during which the control reports work and accepts no action. */
function isIndeterminate(phase: DesktopUpdatePresentation['phase']): boolean {
  return phase === 'checking' || phase === 'verifying' || phase === 'installing'
}

/** The staged and in-progress phases whose detail lives in the popover. */
function popoverPhase(phase: DesktopUpdatePresentation['phase']): boolean {
  return phase === 'downloading' || phase === 'waiting'
}

function UpdateIcon({ phase, percent }: { phase: DesktopUpdatePresentation['phase']; percent: number }) {
  if (isIndeterminate(phase)) return <IconLoadingOutlineRegular className={css.spinner} size={14} />
  if (phase === 'error') return <IconWarningTriangleOutlineRegular size={14} />
  if (phase !== 'downloading') return <IconDownloadOutlineRegular size={14} />
  return <span className={css.ring}>
    <svg className={css.ringArt} viewBox="0 0 20 20" aria-hidden="true">
      <circle className={css.ringTrack} cx="10" cy="10" r={RING_RADIUS} />
      <circle
        className={css.ringValue}
        cx="10"
        cy="10"
        r={RING_RADIUS}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
      />
    </svg>
    <IconDownloadOutlineRegular size={12} />
  </span>
}

/** Detail rows and the one action a staged restart offers. */
function UpdatePopover({
  panelRef, position, state, onCancel, busy, t,
}: {
  readonly panelRef: RefObject<HTMLDivElement>
  readonly position: CSSProperties | null
  readonly state: DesktopUpdatePresentation
  readonly onCancel: () => void
  readonly busy: boolean
  readonly t: SettingsTranslate
}) {
  const percent = updatePercent(state)
  const bytes = updateBytesText(state)
  const title = t(state.phase === 'waiting' ? 'desktop.update.waiting' : 'desktop.update.downloading')
  return createPortal((
    <div ref={panelRef} className={css.popover} style={position ?? MEASURE_STYLE} role="dialog" aria-label={title}>
      <div className={css.popoverHead}>
        <span className={css.popoverTitle}>{title}</span>
        {state.phase === 'downloading' && <span className={css.popoverPercent}>{t('desktop.update.progress', { percent })}</span>}
      </div>
      {state.phase === 'waiting' && <p className={css.popoverBody}>{t('desktop.update.waitingDetail')}</p>}
      {state.phase === 'downloading' && <div
        className={css.progress}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className={css.progressFill} style={{ inlineSize: `${percent}%` }} />
      </div>}
      <div className={css.popoverRows}>
        {state.version !== undefined && <span>{t('desktop.update.targetVersion', { version: state.version })}</span>}
        {state.phase === 'downloading' && bytes !== undefined && <span>{t('desktop.update.transferred', { size: bytes })}</span>}
      </div>
      {state.phase === 'waiting' && <div className={css.popoverFooter}>
        <Button variant="outline" size="sm" disabled={busy} autoFocus onClick={onCancel}>
          {t('desktop.update.cancelRestart')}
        </Button>
      </div>}
    </div>
  ), document.body)
}

/**
 * Render the update control for every Desktop phase that needs one.
 * @param props - shared carrier status, shell actions, and localized copy.
 * @returns the icon control with its optional popover, or nothing outside Desktop or while idle.
 */
export function DesktopUpdateControl({
  useDesktopUpdate, open, cancelRestart, t,
}: PropsRuntime<'sidebar.workspaces.headerActions'> & PropsLocale<'settings'> & InjectFace<DesktopUpdateControlInjected>) {
  const view = useDesktopUpdate(value => value)
  const { presentation: state, failed, busy } = view
  const [popoverOpen, setPopoverOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open: popoverOpen, anchorRef: triggerRef, panelRef, side: 'bottom', align: 'end', gap: 6, margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, popoverOpen, setPopoverOpen, panelRef)

  const popoverCapable = !failed && state !== undefined && popoverPhase(state.phase)
  // A phase that no longer owns the popover closes it: the phase itself is the
  // open state, so a stale panel can never outlive the state that raised it.
  useEffect(() => {
    if (!popoverCapable) setPopoverOpen(false)
  }, [popoverCapable])

  useEffect(() => {
    if (!popoverOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setPopoverOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('keydown', closeOnEscape) }
  }, [popoverOpen])

  if (!updateVisible(view)) return null
  const copy = desktopUpdateCopy(state, failed, t)
  const error = failed || state?.phase === 'error'
  const phase = state?.phase ?? 'error'
  const waiting = !failed && phase === 'waiting'
  const openable = !busy && !isIndeterminate(phase)
  const activate = (): void => {
    if (!openable) return
    // Progress and a staged restart own a popover; every other phase asks the
    // shell to advance (start the download, install, or retry).
    if (popoverCapable) setPopoverOpen(current => !current)
    else open()
  }
  return <div ref={rootRef} className={css.root}>
    <Tooltip label={copy.detail} side="bottom" gap={6} delayMs={500} disabled={popoverOpen}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.control, error && css.error, waiting && css.waiting)}
        aria-label={copy.label}
        aria-disabled={openable ? 'false' : 'true'}
        {...popoverCapable ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': popoverOpen } : {}}
        onClick={activate}
      >
        <UpdateIcon phase={error ? 'error' : phase} percent={state === undefined ? 0 : updatePercent(state)} />
        {!error && (phase === 'ready' || waiting) && <span className={css.accent} aria-hidden="true" />}
      </button>
    </Tooltip>
    {popoverOpen && state !== undefined && <UpdatePopover
      panelRef={panelRef}
      position={position}
      state={state}
      busy={busy}
      onCancel={() => { cancelRestart() }}
      t={t}
    />}
  </div>
}
