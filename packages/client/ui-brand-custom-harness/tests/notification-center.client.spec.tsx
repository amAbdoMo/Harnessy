// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AccountAutoSwitchEvent } from '@deepseek-ai/dsh-api-remotes/client'
import {
  NotificationCenter, type NotificationCenterProps,
} from '../src/client/NotificationCenter.tsx'
import {
  accountSwitchNotification, type HarnessNotificationEvent, NotificationHistoryController,
} from '../src/client/notification-history.ts'
import { en } from '../src/client/locales.ts'

const switchEvent: AccountAutoSwitchEvent = {
  id: 'switch-1',
  occurredAt: Date.UTC(2026, 8, 18, 10, 30),
  provider: 'openai-codex',
  limit: '5h',
  from: { name: 'Abdo', usageScope: 'personal' },
  to: { name: 'Abdo Work', usageScope: 'workspace' },
}

const t = (key: keyof typeof en): string => en[key]

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

function mount(controller: NotificationHistoryController) {
  const useNotifications: NotificationCenterProps['useNotifications'] = selector => selector(useSyncExternalStore(
    listener => controller.history.subscribe(listener),
    () => controller.history.getSnapshot(),
  ))
  const useNotificationToast: NotificationCenterProps['useNotificationToast'] = selector => selector(useSyncExternalStore(
    listener => controller.toast.subscribe(listener),
    () => controller.toast.getSnapshot(),
  ))
  const useSessions: NotificationCenterProps['useSessions'] = selector => selector({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const useSessionPendingInteraction: NotificationCenterProps['useSessionPendingInteraction'] = selector => selector(new Map())
  render(<NotificationCenter {...({
    useNotifications,
    useNotificationToast,
    useSessions,
    useSessionPendingInteraction,
    addNotification: (event: HarnessNotificationEvent) => { controller.add(event) },
    markAllRead: () => { controller.markAllRead() },
    clearNotifications: () => { controller.clear() },
    dismissToast: (id: string) => { controller.dismissToast(id) },
    t,
  } as unknown as NotificationCenterProps)} />)
}

describe('Harnessy notification center', () => {
  it('persists switch history, marks it read on open, and clears it explicitly', async () => {
    const first = new NotificationHistoryController()
    first.add(accountSwitchNotification(switchEvent))
    const restored = new NotificationHistoryController()
    expect(restored.history.getSnapshot().items).toEqual([
      expect.objectContaining({ id: 'switch-1', read: false }),
    ])

    mount(restored)
    const notificationButton = screen.getByRole('button', { name: '1 unread notifications' })
    expect(notificationButton.textContent).not.toContain('1')
    expect(notificationButton.querySelector('[class*="unreadDot"]')).toBeTruthy()
    fireEvent.click(notificationButton)
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy()
    expect(screen.getByText('Abdo (Personal) was near its 5h limit. Now using Abdo Work (Workspace).')).toBeTruthy()
    await waitFor(() => {
      expect(restored.history.getSnapshot().items[0]?.read).toBe(true)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    expect(screen.getByText('You’re all caught up')).toBeTruthy()
    expect(restored.history.getSnapshot().items).toEqual([])
  })

  it('drops malformed persisted data instead of trusting local storage', () => {
    localStorage.setItem('harnessy.account-switch-notifications.v1', JSON.stringify({ items: [{ id: 7 }] }))
    const controller = new NotificationHistoryController()
    expect(controller.history.getSnapshot()).toEqual({ items: [] })
  })

  it('renders Session and required-action activity with one unread dot', () => {
    const controller = new NotificationHistoryController()
    controller.add({
      id: 'completed:1', occurredAt: 1, kind: 'task-completed', sessionId: 's1', sessionTitle: 'Build release',
    })
    controller.add({
      id: 'approval:1', occurredAt: 2, kind: 'approval-required', sessionId: 's1', sessionTitle: 'Build release',
    })
    controller.add({
      id: 'question:1', occurredAt: 3, kind: 'question-required', sessionId: 's1', sessionTitle: 'Build release',
    })
    controller.add({
      id: 'plan:1', occurredAt: 4, kind: 'plan-review-required', sessionId: 's1', sessionTitle: 'Build release',
    })

    mount(controller)
    const notificationButton = screen.getByRole('button', { name: '4 unread notifications' })
    expect(notificationButton.textContent).not.toContain('4')
    expect(notificationButton.querySelectorAll('[class*="unreadDot"]')).toHaveLength(1)
    fireEvent.click(notificationButton)
    expect(screen.getByText('Task completed')).toBeTruthy()
    expect(screen.getByText('Approval needed')).toBeTruthy()
    expect(screen.getByText('Answer needed')).toBeTruthy()
    expect(screen.getByText('Plan review needed')).toBeTruthy()
  })
})
