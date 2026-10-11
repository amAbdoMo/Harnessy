/** User-entered calendar reminders, independent of provider usage and reset credits. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconAlarmClockOutlineRegular, Input, MenuSurface, Toast, Tooltip,
  useAnchoredPosition, useDismissOnOutsidePointer, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ManagedAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountsManagerCardProps, AccountsManagerOperations } from './AccountsManagerCard.tsx'
import { useBillingDay } from './billing-reminder-clock.ts'
import { billingDateLabel, nextBillingDate, validBillingDate } from './billing-reminder-date.ts'
import css from './ManualBillingReminder.module.css'

/**
 * Render the next monthly occurrence and a popup that edits the membership's original anchor.
 * @param props - membership, write permission, Host mutation callback, and localized copy.
 * @returns the compact reminder and optional date-only editor.
 */
export function ManualBillingReminder({ account, writable, saveDate, t }: {
  readonly account: ManagedAccountView
  readonly writable: boolean
  readonly saveDate: AccountsManagerOperations['setManualBillingDate']
  readonly t: AccountsManagerCardProps['t']
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(false)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const editorGeneration = useRef(0)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const popupId = useId()
  const anchor = account.manualBillingDate
  const today = useBillingDay(anchor !== undefined)
  const date = nextBillingDate(anchor, today)
  const position = useAnchoredPosition({ open: editing, anchorRef: trigger, panelRef: panel, gap: 6, margin: 12 })
  const dismiss = useCallback((): void => {
    editorGeneration.current += 1
    setEditing(false)
    setFailure(false)
  }, [])
  useDismissOnOutsidePointer(root, editing, dismiss, panel)
  useModalLayer(panel, editing, dismiss)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const commit = async (nextDate: string | null): Promise<void> => {
    if (inFlight.current || !writable || (nextDate !== null && !validBillingDate(nextDate))) return
    const generation = editorGeneration.current
    inFlight.current = true
    setPending(true)
    setFailure(false)
    let response: Awaited<ReturnType<typeof saveDate>>
    try {
      response = await saveDate(account.provider, account.id, nextDate)
    } catch (error) {
      response = { error: String(error) }
    }
    inFlight.current = false
    if (!alive.current) return
    setPending(false)
    if (generation !== editorGeneration.current) return
    if (response.error !== undefined || response.state === undefined) setFailure(true)
    else dismiss()
  }

  const actionLabel = anchor === undefined ? t('accountsBillingAdd') : t('accountsBillingEdit')
  return <div ref={root} className={css.reminder} role="group" aria-label={t('accountsBillingReminder')}>
    <Tooltip label={actionLabel} portal>
      <Button ref={trigger} variant="ghost" size="sm" className={css.trigger} aria-label={actionLabel} disabled={!writable}
        aria-haspopup="dialog" aria-expanded={editing} aria-controls={editing ? popupId : undefined}
        onClick={() => {
          if (editing) { dismiss(); return }
          trigger.current?.focus()
          editorGeneration.current += 1
          setDraft(anchor ?? '')
          setFailure(false)
          setEditing(true)
        }}><IconAlarmClockOutlineRegular size={16} /></Button>
    </Tooltip>
    {date === undefined ? null : <time dateTime={date} className={css.date}>{billingDateLabel(date)}</time>}
    {editing ? createPortal(<MenuSurface ref={panel} compact id={popupId} className={css.popup}
      role="dialog" aria-modal="true" aria-label={t('accountsBillingReminder')} tabIndex={-1}
      style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      <form className={css.editor} onSubmit={(event) => {
        event.preventDefault()
        void commit(draft)
      }}>
        <label className={css.label} htmlFor={`${popupId}-date`}>{t('accountsBillingDate')}</label>
        <Input id={`${popupId}-date`} type="date" min="0001-01-01" max="9999-12-31" required value={draft}
          data-modal-autofocus disabled={pending || !writable}
          onChange={(event) => { setDraft(event.currentTarget.value); setFailure(false) }} />
        <p className={css.hint}>{t('accountsBillingManualHint')}</p>
        {anchor !== undefined && date === undefined ? <p className={css.hint}>{t('accountsBillingRangeEnded')}</p> : null}
        <p className={css.failure} role={failure ? 'alert' : undefined}>{failure ? t('accountsBillingFailed') : null}</p>
        <div className={css.actions}>
          <Button variant="ghost" size="sm" onClick={dismiss}>{t('cancel')}</Button>
          {anchor === undefined ? null : <Button variant="ghost" size="sm" disabled={pending || !writable}
            onClick={() => { void commit(null) }}>{t('accountsBillingClear')}</Button>}
          <Button type="submit" variant="outline" size="sm" disabled={pending || !writable || !validBillingDate(draft)}>
            {pending ? t('accountsBillingSaving') : t('accountsSave')}
          </Button>
        </div>
      </form>
    </MenuSurface>, document.body) : null}
  </div>
}

/** Application-owned outcome that survives closing or switching memberships. */
export interface BillingReminderNotice {
  readonly id: string
  readonly outcome: 'saved' | 'cleared' | 'failed'
}

/** Root toast inputs supplied through the registration's inject face. */
export interface BillingReminderToastInjected {
  readonly hooks: { readonly billingReminderNotice: ObservableSnapshot<BillingReminderNotice | undefined> }
  readonly dismiss: (id: string) => void
}

type BillingReminderToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'customHarnessBrand'> & InjectFace<BillingReminderToastInjected>

/**
 * Announce reminder mutations without coupling their lifetime to the editor.
 * @param props - renderer-bound notice, dismissal callback, and localized copy.
 * @returns the current outcome toast, or null when no outcome is pending.
 */
export function BillingReminderToast({ useBillingReminderNotice, dismiss, t }: BillingReminderToastProps) {
  const notice = useBillingReminderNotice(snapshot => snapshot)
  if (notice === undefined) return null
  const text = notice.outcome === 'failed' ? t('accountsBillingFailed')
    : notice.outcome === 'cleared' ? t('accountsBillingCleared') : t('accountsBillingSaved')
  return <Toast key={notice.id} text={text} {...(notice.outcome === 'failed' ? {} : { tone: 'success' as const })}
    onDone={() => { dismiss(notice.id) }} />
}
