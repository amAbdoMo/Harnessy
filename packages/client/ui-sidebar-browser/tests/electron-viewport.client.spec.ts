// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { DesktopWebsiteProfileId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }

it('retains a premount viewport and sends metrics before the deferred native load', async () => {
  const h = electronFixture()
  const viewport = { width: 390, height: 844, scale: 0.5 }
  try {
    expect(h.frame.setViewport).toBeDefined()
    h.frame.setViewport?.(viewport)
    h.frame.loadUrl(target)
    expect(h.bridge.command).not.toHaveBeenCalled()
    h.mount()
    const guest = await h.guest()
    guest.emit('dom-ready')
    expect(h.bridge.command.mock.calls.map(([, command]) => command)).toEqual([
      { kind: 'preview-viewport', viewport, revision: 1 },
      { kind: 'navigate', url: target.url, revision: 1 },
    ])
    h.frame.setViewport?.({ ...viewport, scale: 0.25 })
    expect(h.bridge.command.mock.lastCall?.[1]).toEqual({ kind: 'preview-viewport', viewport: { ...viewport, scale: 0.25 }, revision: 1 })
    expect(h.persist.mock.calls).toHaveLength(1)
  } finally { await h.dispose() }
})

it('keeps fit changes from superseding an approved storage transition and reapplies on replacement', async () => {
  const h = electronFixture()
  const viewport = { width: 1280, height: 800, scale: 0.5 }
  try {
    h.frame.setViewport?.(viewport)
    h.mount()
    h.frame.loadUrl(target)
    const first = await h.guest()
    first.emit('dom-ready')
    h.frame.setViewport?.({ ...viewport, scale: 0.4 })
    for (const reacquire of h.reacquires) reacquire('https://localhost/', 1)
    await vi.waitFor(() => { expect(h.guests).toHaveLength(2) })
    const second = await h.guest()
    second.emit('dom-ready')
    expect(h.bridge.command.mock.calls.at(-2)?.[1]).toEqual({ kind: 'preview-viewport', viewport: { ...viewport, scale: 0.4 }, revision: 2 })
    expect(h.bridge.command.mock.lastCall?.[1]).toEqual({ kind: 'navigate', url: 'https://localhost/', revision: 2 })
  } finally { await h.dispose() }
})

it('publishes native viewport failures and makes no late command after disposal', async () => {
  const h = electronFixture()
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    h.mount()
    h.frame.loadUrl(target)
    const guest = await h.guest()
    guest.emit('dom-ready')
    h.bridge.command.mockRejectedValueOnce(new Error('Native metrics unavailable'))
    h.frame.setViewport?.({ width: 390, height: 844, scale: 0.5 })
    await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
    await h.frame.dispose()
    const count = h.bridge.command.mock.calls.length
    h.frame.setViewport?.({ width: 390, height: 844, scale: 1 })
    guest.emit('dom-ready')
    expect(h.bridge.command).toHaveBeenCalledTimes(count)
  } finally { await h.dispose(); errorLog.mockRestore() }
})

it('offers no viewport capability on a saved-account page', async () => {
  const h = electronFixture(undefined, 'saved' as DesktopWebsiteProfileId)
  try { expect(h.frame.setViewport).toBeUndefined() }
  finally { await h.dispose() }
})
