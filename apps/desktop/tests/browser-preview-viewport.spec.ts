/** Chromium transport is controlled; metrics ordering and ownership remain real. */
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { BrowserPreviewViewport } from '../src/browser-preview-viewport.ts'
import { executeHumanBrowserCommand } from '../src/browser-human-command.ts'

function fixture() {
  let attached = false
  let devToolsOpened = false
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn((_version: string) => { attached = true }),
    isAttached: () => attached,
    sendCommand: vi.fn(async (_method: string, _parameters: Readonly<Record<string, number | boolean>>) => ({})),
  })
  const lost = vi.fn()
  const metrics = new BrowserPreviewViewport({ debugger: debuggerApi, isDestroyed: () => false,
    isDevToolsOpened: () => devToolsOpened }, () => true, lost)
  const native = {
    navigationHistory: { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() },
    loadURL: vi.fn(async (_url: string) => {}), reload: vi.fn(),
    setViewport: (viewport: { readonly width: number; readonly height: number; readonly scale: number }) => metrics.set(viewport),
  }
  return { metrics, debuggerApi, native, lost,
    run: (input: unknown) => executeHumanBrowserCommand(native, input, () => true, () => true),
    external: () => { attached = true },
    openDevTools: () => { devToolsOpened = true },
  }
}

it('uses fixed CSS metrics and native fit without device identity spoofing', async () => {
  const f = fixture()
  try {
    await f.run({ kind: 'preview-viewport', viewport: { width: 390, height: 844, scale: 0.5 } })
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledExactlyOnceWith('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false, scale: 0.5,
      screenWidth: 390, screenHeight: 844, positionX: 0, positionY: 0, dontSetVisibleSize: true,
    })
    await f.metrics.reapply()
    expect(f.debuggerApi.sendCommand.mock.calls[1]).toEqual(f.debuggerApi.sendCommand.mock.calls[0])
  } finally { await f.metrics.dispose() }
})

it.each([
  { width: 0, height: 844, scale: 1 }, { width: 8193, height: 844, scale: 1 },
  { width: 390.5, height: 844, scale: 1 }, { width: 390, height: -1, scale: 1 },
  { width: 390, height: 8193, scale: 1 }, { width: 390, height: 844.5, scale: 1 },
  { width: 390, height: 844, scale: 0 }, { width: 390, height: 844, scale: -1 },
  { width: 390, height: 844, scale: 1.01 }, { width: 390, height: 844, scale: NaN },
  { width: 390, height: 844, scale: Infinity }, { width: Infinity, height: 844, scale: 1 },
  { width: 390, height: 844, scale: 1, mobile: true }, { width: '390', height: 844, scale: 1 },
  { width: 390, height: 844 }, null, [],
])('rejects invalid viewport packet %# before debugger acquisition', async (viewport) => {
  const f = fixture()
  try {
    await expect(f.run({ kind: 'preview-viewport', viewport })).rejects.toThrow('command rejected')
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
  } finally { await f.metrics.dispose() }
})

it('rejects unknown command keys and unsupported saved-account adapters before native metrics', async () => {
  const f = fixture()
  const viewport = { width: 390, height: 844, scale: 1 }
  try {
    await expect(f.run({ kind: 'preview-viewport', viewport, code: 'unexpected' })).rejects.toThrow('command rejected')
    const profile = { navigationHistory: f.native.navigationHistory, loadURL: f.native.loadURL, reload: f.native.reload }
    const admission = vi.fn(() => true)
    await expect(executeHumanBrowserCommand(profile, { kind: 'preview-viewport', viewport }, () => true, admission))
      .rejects.toThrow('native command failed')
    expect(admission).not.toHaveBeenCalled()
    await executeHumanBrowserCommand(profile, { kind: 'reload' }, () => true, admission)
    expect(f.native.reload).toHaveBeenCalledOnce()
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
  } finally { await f.metrics.dispose() }
})

it('accepts inclusive CSS bounds and a fit of one', async () => {
  const f = fixture()
  try {
    await f.run({ kind: 'preview-viewport', viewport: { width: 1, height: 8192, scale: 1 } })
    await f.run({ kind: 'preview-viewport', viewport: { width: 8192, height: 1, scale: 0.01 } })
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledTimes(2)
  } finally { await f.metrics.dispose() }
})

it('orders rapid viewport settings and navigation behind Chromium acknowledgement', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<object>()
  f.debuggerApi.sendCommand.mockImplementationOnce(async () => { entered.resolve(undefined); return finish.promise })
  const first = f.metrics.set({ width: 390, height: 844, scale: 1 })
  const second = f.metrics.set({ width: 1280, height: 800, scale: 0.5 })
  const native = { ...f.native, navigationReady: () => f.metrics.settled() }
  const navigate = executeHumanBrowserCommand(native, { kind: 'navigate', url: 'https://example.test/' }, () => true, () => true)
  try {
    await entered.promise
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
    expect(f.native.loadURL).not.toHaveBeenCalled()
    finish.resolve({})
    await Promise.all([first, second, navigate])
    expect(f.debuggerApi.sendCommand.mock.calls.map(([, metrics]) => [metrics.width, metrics.height, metrics.scale]))
      .toEqual([[390, 844, 1], [1280, 800, 0.5]])
    expect(f.native.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.test/')
  } finally { finish.resolve({}); await f.metrics.dispose() }
})

it('serializes rapid fit changes and joins an in-flight update on disposal', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<object>()
  f.debuggerApi.sendCommand.mockImplementationOnce(async () => { entered.resolve(undefined); return finish.promise })
  const first = f.metrics.set({ width: 390, height: 844, scale: 1 })
  const second = f.metrics.set({ width: 390, height: 844, scale: 0.5 })
  const rejected = expect(second).rejects.toThrow('guest unavailable')
  try {
    await entered.promise
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
    const disposal = f.metrics.dispose()
    finish.resolve({})
    await Promise.all([first, rejected, disposal])
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
  } finally { finish.resolve({}); await f.metrics.dispose() }
})

it('does not acquire a debugger until used and never steals an existing attachment', async () => {
  const f = fixture()
  try {
    await f.metrics.reapply()
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    f.external()
    await expect(f.metrics.set({ width: 390, height: 844, scale: 1 })).rejects.toThrow('already owned')
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  } finally { await f.metrics.dispose() }
})

it('leaves preexisting native DevTools untouched without acquiring a debugger', async () => {
  const f = fixture()
  try {
    f.openDevTools()
    await expect(f.metrics.set({ width: 390, height: 844, scale: 1 })).rejects.toThrow('DevTools already open')
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  } finally { await f.metrics.dispose() }
})

it('reports ownership loss without reattaching to a replacement debugger', async () => {
  const f = fixture()
  try {
    await f.metrics.set({ width: 390, height: 844, scale: 1 })
    f.debuggerApi.emit('detach')
    expect(f.lost).toHaveBeenCalledOnce()
    await expect(f.metrics.reapply()).rejects.toThrow('ownership lost')
    expect(f.debuggerApi.attach).toHaveBeenCalledOnce()
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
  } finally { await f.metrics.dispose() }
})

it('blocks navigation after a metrics rejection until an explicit successful update', async () => {
  const f = fixture()
  const viewport = { width: 390, height: 844, scale: 1 }
  f.debuggerApi.sendCommand.mockRejectedValueOnce(new Error('Chromium rejected metrics'))
  try {
    await expect(f.metrics.set(viewport)).rejects.toThrow('Chromium rejected metrics')
    await expect(f.metrics.settled()).rejects.toThrow('viewport native command failed')
    await f.metrics.set(viewport)
    await expect(f.metrics.settled()).resolves.toBeUndefined()
  } finally { await f.metrics.dispose() }
})
