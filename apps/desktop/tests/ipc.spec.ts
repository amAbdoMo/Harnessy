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
