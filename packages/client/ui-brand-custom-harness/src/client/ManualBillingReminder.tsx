/** User-entered calendar reminders, independent of provider usage and reset credits. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ManagedAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountsManagerCardProps, AccountsManagerOperations } from './AccountsManagerCard.tsx'
import { useUsageClock } from './account-usage-clock.ts'
import css from './ManualBillingReminder.module.css'

function validCalendarDate(date: string): boolean {
  if (date.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || date.startsWith('0000')) return false
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

function localCalendarDate(nowMs: number): string {
  const today = new Date(nowMs)
  return `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

/**
 * Render the selected membership's exact date; only an explicit save or clear writes it.
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
  const date = account.manualBillingDate
  const nowMs = useUsageClock(date !== undefined)
  const overdue = date !== undefined && date < localCalendarDate(nowMs)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const commit = async (nextDate: string | null): Promise<void> => {
    if (inFlight.current || !writable || (nextDate !== null && !validCalendarDate(nextDate))) return
    inFlight.current = true
    setPending(true)
    setFailure(false)
    const response = await saveDate(account.provider, account.id, nextDate)
    inFlight.current = false
    if (!alive.current) return
    setPending(false)
    if (response.error !== undefined || response.state === undefined) setFailure(true)
    else setEditing(false)
  }

  return <div className={css.reminder} role="group" aria-label={t('accountsBillingReminder')}>
    <div className={css.row}>
      <span className={css.label}>{t('accountsBillingReminder')}</span>
      {date === undefined ? null : <time dateTime={date} className={css.date}>{date}</time>}
      {overdue ? <span className={css.overdue}>{t('accountsBillingOverdue')}</span> : null}
      {editing ? null : <Button variant="ghost" size="sm" disabled={!writable || pending} onClick={() => {
        setDraft(date ?? '')
        setFailure(false)
        setEditing(true)
      }}>{date === undefined ? t('accountsBillingAdd') : t('accountsBillingEdit')}</Button>}
    </div>
    {editing ? <form className={css.editor} onSubmit={(event) => {
      event.preventDefault()
      void commit(draft)
    }}>
      <Input type="date" min="0001-01-01" max="9999-12-31" required value={draft}
        disabled={pending || !writable} aria-label={t('accountsBillingDate')}
        onChange={(event) => { setDraft(event.currentTarget.value); setFailure(false) }} />
      <div className={css.actions}>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => {
          setEditing(false)
          setFailure(false)
        }}>{t('cancel')}</Button>
        {date === undefined ? null : <Button variant="ghost" size="sm" disabled={pending || !writable}
          onClick={() => { void commit(null) }}>{t('accountsBillingClear')}</Button>}
        <Button type="submit" variant="outline" size="sm" disabled={pending || !writable || !validCalendarDate(draft)}>
          {pending ? t('accountsBillingSaving') : t('accountsSave')}
        </Button>
      </div>
      <p className={css.hint}>{t('accountsBillingManualHint')}</p>
      <p className={css.failure} role={failure ? 'alert' : undefined}>{failure ? t('accountsBillingFailed') : null}</p>
    </form> : null}
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
