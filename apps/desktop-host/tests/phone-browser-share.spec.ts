import { describe, expect, it, vi } from 'vitest'
import type { BrowserShareRequest } from '@deepseek-ai/dsh-companion-host'
import { createPhoneBrowserShare } from '../src/phone-browser-share.ts'

const shareId = '00000000-0000-4000-8000-000000000000' as Extract<BrowserShareRequest, { kind: 'stop' }>['shareId']

describe('Desktop Host browser share channel', () => {
  it('delivers stop independently of a pending watch and ignores an unrelated reply', async () => {
    const host = new AbortController()
    const send = vi.fn<(message: object) => Promise<void>>().mockResolvedValue(undefined)
    const bridge = createPhoneBrowserShare(host.signal, send)
    const watch = bridge.request({ kind: 'watch', shareId, highResolution: true }, host.signal)
    try {
      await expect(bridge.request({ kind: 'watch' }, host.signal)).resolves.toEqual({ status: 'busy' })
      const stop = bridge.request({ kind: 'stop', shareId }, host.signal)
      try {
        expect(send.mock.calls.map(([message]) => message)).toEqual([
          { type: 'phone-browser-share-watch', requestId: expect.any(String), id: shareId, highResolution: true },
          { type: 'phone-browser-share-stop', requestId: expect.any(String), id: shareId },
        ])
        const [watchMessage, stopMessage] = send.mock.calls.map(([message]) => message)
        bridge.receive({ type: 'phone-browser-share-result', requestId: 'unrelated', status: 'idle' })
        bridge.receive({ ...stopMessage, type: 'phone-browser-share-result', status: 'ended' })
        await expect(stop).resolves.toEqual({ status: 'ended' })
        bridge.receive({ ...watchMessage, type: 'phone-browser-share-result', status: 'ended' })
        await expect(watch).resolves.toEqual({ status: 'ended' })
      } finally { host.abort(); await Promise.allSettled([stop]) }
    } finally { host.abort(); await Promise.allSettled([watch]) }
  })
})
