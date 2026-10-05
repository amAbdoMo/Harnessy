import { describe, expect, it } from 'vitest'
import { parseDesktopNotificationPayload } from '../src/ipc.ts'

describe('desktop notification IPC', () => {
  it('accepts bounded secret-free display copy', () => {
    expect(parseDesktopNotificationPayload({
      title: ' Approval needed ',
      body: ' Session A needs access approval. ',
    })).toEqual({
      title: 'Approval needed',
      body: 'Session A needs access approval.',
    })
  })

  it('retains the opaque Session target but drops arbitrary activation and icon fields', () => {
    expect(parseDesktopNotificationPayload({ title: 'Task finished', body: 'Review the result.', sessionId: 's1',
      url: 'https://untrusted.invalid', icon: 'C:\\untrusted.png', args: '--inspect' })).toEqual({
      title: 'Task finished', body: 'Review the result.', sessionId: 's1',
    })
  })

  it.each([null, 7, '', 'x'.repeat(201), ' session', 'session\nother'])('rejects invalid Session targets %s', (sessionId) => {
    expect(() => parseDesktopNotificationPayload({ title: 'Task finished', body: 'Review the result.', sessionId })).toThrow(/session id/)
  })

  it.each([
    undefined,
    { title: '', body: 'message' },
    { title: 'title', body: '' },
    { title: 'x'.repeat(121), body: 'message' },
    { title: 'title', body: 'x'.repeat(501) },
    { title: 7, body: 'message' },
  ])('rejects invalid native notification payloads', (payload) => {
    expect(() => parseDesktopNotificationPayload(payload)).toThrow(/notification/)
  })
})
