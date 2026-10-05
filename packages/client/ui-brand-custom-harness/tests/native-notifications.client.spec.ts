import { describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  showNativeNotification, subscribeNativeNotificationActivation, type NativeNotifications,
} from '../src/client/native-notifications.ts'

type SessionId = SessionListState['ids'][number]
const FIRST = 'first' as SessionId
const SECOND = 'second' as SessionId

function catalog(ids: SessionId[], phase: SessionListState['phase'] = 'ready'): SessionListState {
  return { ids, byId: Object.fromEntries(ids.map(id => [id, {
    id, displayTitle: id, running: false, retainedBy: {}, blank: false, updatedAt: 1,
  }])), phase, projectionsBySession: {} }
}

function bridge() {
  let activate: ((sessionId: SessionId) => void) | undefined
  const stop = vi.fn()
  const show = vi.fn(async () => true)
  const api: NativeNotifications = {
    show,
    subscribe(listener) { activate = listener; return stop },
  }
  return { api, show, stop, click(id: SessionId) { activate?.(id) } }
}

describe('Harnessy native notification selection', () => {
  it('sends bounded copy separately from the Session address and omits targets for global events', async () => {
    const native = bridge()
    showNativeNotification(native.api, { title: 't'.repeat(150), message: 'b'.repeat(600) }, FIRST)
    expect(native.show).toHaveBeenCalledWith({ title: `${'t'.repeat(119)}…`, body: `${'b'.repeat(499)}…`, sessionId: FIRST })
    showNativeNotification(native.api, { title: 'Connection restored', message: 'MCP is ready.' })
    expect(native.show).toHaveBeenLastCalledWith({ title: 'Connection restored', body: 'MCP is ready.' })
    showNativeNotification(undefined, { title: 'Unavailable', message: 'Ordinary browser.' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      showNativeNotification({ show: async () => { throw new Error('carrier unavailable') } }, { title: 'Finished', message: 'Review.' })
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledOnce()
    } finally { warn.mockRestore() }
  })

  it('opens only existing catalog ids and removes both subscriptions before late callbacks', () => {
    const native = bridge()
    const list = createSnapshotStore(catalog([FIRST]))
    const stopCatalog = vi.spyOn(list, 'subscribe')
    const open = vi.fn<(sessionId: SessionId) => void>()
    const stop = subscribeNativeNotificationActivation(native.api, list, open)
    expect(stopCatalog).toHaveBeenCalledOnce()
    native.click(SECOND)
    expect(open).not.toHaveBeenCalled()
    native.click(FIRST)
    expect(open.mock.calls).toEqual([[FIRST]])
    stop()
    native.click(FIRST)
    list.set(catalog([SECOND]))
    expect(native.stop).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledOnce()
    stopCatalog.mockRestore()
  })

  it('retains the latest click while the initial catalog is pending and drops missing ids after readiness', () => {
    const native = bridge()
    const list = createSnapshotStore(catalog([], 'pending'))
    const open = vi.fn<(sessionId: SessionId) => void>()
    const stop = subscribeNativeNotificationActivation(native.api, list, open)
    try {
      native.click(FIRST)
      native.click(SECOND)
      list.set(catalog([FIRST], 'pending'))
      expect(open).not.toHaveBeenCalled()
      list.set(catalog([FIRST, SECOND]))
      expect(open.mock.calls).toEqual([[SECOND]])
      list.set(catalog([], 'pending'))
      native.click(FIRST)
      list.set(catalog([]))
      list.set(catalog([FIRST]))
      expect(open).toHaveBeenCalledOnce()
    } finally { stop() }
  })

  it('does not subscribe to the catalog without a compatible carrier', () => {
    const list = createSnapshotStore(catalog([FIRST]))
    const subscribe = vi.spyOn(list, 'subscribe')
    try {
      subscribeNativeNotificationActivation(undefined, list, vi.fn())()
      subscribeNativeNotificationActivation({ show: async () => true }, list, vi.fn())()
      expect(subscribe).not.toHaveBeenCalled()
    } finally { subscribe.mockRestore() }
  })
})
