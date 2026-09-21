import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  Toast, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createPortal } from 'react-dom'
import { NotificationActivityObserver } from './notification-activity.ts'
import type {
  HarnessNotificationEvent, NotificationHistoryItem, NotificationHistoryState,
} from './notification-history.ts'
import { notificationPresentation } from './notification-presentation.ts'
import css from './NotificationCenter.module.css'

const MEASURE_STYLE = { left: 0, top: 0, visibility: 'hidden' as const }

/** Browser-owned notification history and mutations supplied by the brand plugin. */
export interface NotificationCenterInjected {
  hooks: {
    notifications: ObservableSnapshot<NotificationHistoryState>
    notificationToast: ObservableSnapshot<HarnessNotificationEvent | undefined>
  }
  addNotification: (event: HarnessNotificationEvent) => void
  markAllRead: () => void
  clearNotifications: () => void
  dismissToast: (id: string) => void
}

/** Complete Workspaces-toolbar notification-center props. */
export type NotificationCenterProps = PropsRuntime<'sidebar.workspaces.headerActions'>
  & PropsLocale<'customHarnessBrand'>
  & InjectFace<NotificationCenterInjected>

function BellIcon({ filled = false }: { readonly filled?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.75 6.65a4.25 4.25 0 0 1 8.5 0v2.07c0 .7.2 1.38.58 1.97l.42.66H2.75l.42-.66c.38-.59.58-1.27.58-1.97V6.65Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M6.6 13.1c.32.38.79.6 1.4.6s1.08-.22 1.4-.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function NotificationIcon({ kind }: { readonly kind: HarnessNotificationEvent['kind'] }) {
  if (kind === 'task-completed') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 8 2.4 2.4L12 4.8" /></svg>
  }
  if (kind === 'task-stopped') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1" /></svg>
  }
  if (kind === 'task-failed') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
  }
  if (kind === 'approval-required') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.8 13 4v3.5c0 3.1-2 5.5-5 6.7-3-1.2-5-3.6-5-6.7V4l5-2.2Z" /><path d="M8 5.1v3.4M8 11h.01" /></svg>
  }
  if (kind === 'question-required') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.9 5.8A2.2 2.2 0 0 1 8.2 4c1.3 0 2.3.8 2.3 2 0 1.7-2.2 1.8-2.2 3.4M8.3 12h.01" /></svg>
  }
  if (kind === 'plan-review-required') {
    return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5h8v11H4zM6.2 5.2h3.6M6.2 7.8h3.6M6.2 10.4h2" /></svg>
  }
  return <BellIcon />
}

function eventTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(timestamp)
}

function NotificationPanel({
  panelRef, position, items, markAllRead, clearNotifications, t,
}: {
  readonly panelRef: RefObject<HTMLDivElement>
  readonly position: CSSProperties | null
  readonly items: readonly NotificationHistoryItem[]
  readonly markAllRead: () => void
  readonly clearNotifications: () => void
  readonly t: NotificationCenterProps['t']
}) {
  return createPortal((
    <div ref={panelRef} className={css.panel} style={position ?? MEASURE_STYLE}
      role="dialog" aria-label={t('notificationsTitle')}>
      <div className={css.panelHeader}>
        <div><strong>{t('notificationsTitle')}</strong><span>{t('notificationsDescription')}</span></div>
        {items.some(item => !item.read) && <button type="button" className={css.textAction} onClick={markAllRead}>
          {t('notificationsMarkAllRead')}
        </button>}
      </div>
      <div className={css.list}>
        {items.length === 0 ? <NotificationEmpty t={t} /> : items.map((item) => {
          const presentation = notificationPresentation(item, t)
          return (
            <div key={item.id} className={css.item} data-read={item.read}>
              <span className={css.itemIcon}><NotificationIcon kind={item.kind} /></span>
              <span className={css.itemBody}>
                <strong>{presentation.title}</strong>
                <span>{presentation.message}</span>
                <time dateTime={new Date(item.occurredAt).toISOString()}>{eventTime(item.occurredAt)}</time>
              </span>
            </div>
          )
        })}
      </div>
      {items.length > 0 && <div className={css.panelFooter}>
        <button type="button" className={css.clearAction} onClick={clearNotifications}>
          {t('notificationsClear')}
        </button>
      </div>}
    </div>
  ), document.body)
}

function NotificationEmpty({ t }: { readonly t: NotificationCenterProps['t'] }) {
  return (
    <div className={css.empty}>
      <BellIcon />
      <strong>{t('notificationsEmptyTitle')}</strong>
      <span>{t('notificationsEmptyDescription')}</span>
    </div>
  )
}

function NotificationToast({ event, t, dismiss }: {
  readonly event: HarnessNotificationEvent
  readonly t: NotificationCenterProps['t']
  readonly dismiss: (id: string) => void
}) {
  return <Toast
    text={notificationPresentation(event, t).message}
    icon={<NotificationIcon kind={event.kind} />}
    holdMs={5000}
    onDone={() => { dismiss(event.id) }}
  />
}

/** Render the Workspaces-toolbar bell, persisted history panel, and activity toast. */
export function NotificationCenter({
  useNotifications,
  useNotificationToast,
  useSessions,
  useSessionPendingInteraction,
  addNotification,
  markAllRead,
  clearNotifications,
  dismissToast,
  t,
}: NotificationCenterProps) {
  const history = useNotifications(state => state)
  const toast = useNotificationToast(state => state)
  const sessions = useSessions(state => state)
  const pendingInteractions = useSessionPendingInteraction(state => state)
  const observerRef = useRef<NotificationActivityObserver>()
  if (observerRef.current === undefined) observerRef.current = new NotificationActivityObserver()
  const unread = history.items.filter(item => !item.read).length
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    gap: 6,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    for (const event of observerRef.current?.observe(sessions, pendingInteractions) ?? []) {
      addNotification(event)
    }
  }, [addNotification, pendingInteractions, sessions])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('keydown', closeOnEscape) }
  }, [open])

  const toggle = (): void => {
    if (!open) markAllRead()
    setOpen(!open)
  }

  return (
    <div ref={rootRef} className={css.root}>
      <Tooltip label={t('notificationsOpen')} side="bottom" delayMs={500} disabled={open}>
        <button
          ref={triggerRef}
          type="button"
          className={css.trigger}
          aria-label={unread === 0
            ? t('notificationsOpen')
            : t('notificationsUnread').replace('{count}', String(unread))}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
        >
          <BellIcon filled={open} />
          {unread > 0 && <span className={css.unreadDot} aria-hidden="true" />}
        </button>
      </Tooltip>
      {open && <NotificationPanel panelRef={panelRef} position={position} items={history.items}
        markAllRead={markAllRead} clearNotifications={clearNotifications} t={t} />}
      {toast !== undefined && (
        <NotificationToast key={toast.id} event={toast} t={t} dismiss={dismissToast} />
      )}
    </div>
  )
}
