import { describe, expect, it } from 'vitest'
import type { HarnessNotificationEvent } from '../src/client/notification-history.ts'
import { shouldShowNativeNotification } from '../src/client/notification-presentation.ts'

function event(kind: HarnessNotificationEvent['kind']): HarnessNotificationEvent {
  if (kind === 'task-completed' || kind === 'task-stopped' || kind === 'task-failed') {
    return { id: kind, kind, occurredAt: 1, sessionId: 's1', sessionTitle: 'Task' }
  }
  throw new Error(`Unsupported fixture kind: ${kind}`)
}

describe('native notification policy', () => {
  it('suppresses only successful completion while the app is foregrounded', () => {
    expect(shouldShowNativeNotification(event('task-completed'), true)).toBe(false)
    expect(shouldShowNativeNotification(event('task-completed'), false)).toBe(true)
    expect(shouldShowNativeNotification(event('task-stopped'), true)).toBe(true)
    expect(shouldShowNativeNotification(event('task-failed'), true)).toBe(true)
  })
})
