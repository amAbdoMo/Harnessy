/** Real Main transactions; inert Electron adapters control only native display and observation settlement. */
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type {
  DevicePreviewHostRequest, DevicePreviewObservation, DevicePreviewObserveRequest, DevicePreviewOpenRequest,
  DevicePreviewResponse,
} from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { DesktopDevicePreviews, type DesktopDevicePreviewOptions } from '../src/device-preview.ts'
import {
  isDevicePreviewHostRequest, parseDevicePreviewAcknowledgement, parseDevicePreviewBinding,
  parseDevicePreviewOpenRequest,
} from '../src/device-preview-protocol.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const SCREENSHOT_BYTES = 8 * 1024 * 1024
const LAYOUT_BYTES = 32 * 1024
const dispose: Array<() => Promise<void>> = []

afterEach(async () => {
  try { await Promise.all(dispose.splice(0).map(cleanup => cleanup())) }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function openingWire() {
  return {
    type: 'device-preview-open', requestId: uuid(1), previewId: uuid(2), sessionId: 'preview-session',
    server: { cwd: '/preview-project', url: 'http://localhost:4321/', ownership: 'external', status: 'external' },
  }
}

function validated(input: unknown): DevicePreviewHostRequest {
  if (!isDevicePreviewHostRequest(input)) throw new Error('Invalid test wire request')
  return input
}

function layoutText(width = 390, height = 844): string {
  return JSON.stringify({ viewport: { width, height }, document: { width, height },
    horizontalOverflow: false, truncated: false, overflow: [] })
}

async function png(width = 390, height = 844): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: '#123456' } }).png().toBuffer()
}

// A valid ancillary chunk fixes response size without depending on native PNG compression ratios.
function paddedPng(image: Buffer, bytes: number): Buffer {
  const chunk = Buffer.alloc(bytes - image.length, 0x61)
  chunk.writeUInt32BE(chunk.length - 12, 0)
  chunk.write('tEXt', 4, 'ascii')
  chunk.write('padding\0', 8, 'ascii')
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)])
}

function success(request: DevicePreviewObserveRequest, result: Extract<DevicePreviewResponse, { ok: true }>['result']): DevicePreviewResponse {
  return { type: 'device-preview-result', requestId: request.requestId, ok: true, result }
}

function fixture(open: DevicePreviewOpenRequest = parseDevicePreviewOpenRequest(openingWire()),
  callbacks: Pick<DesktopDevicePreviewOptions, 'retired'> = {}) {
  const host = {}
  const otherHost = {}
  let currentHost: object | undefined = host
  let visible = true
  let minimized = false
  let windowDestroyed = false
  let ownerDestroyed = false
  let guestDestroyed = false
  let url = open.server.url
  let loading = false
  let attached = true
  let lookupHook: (() => void) | undefined
  const releases: Array<() => void> = []
  const nativeCancellations = new Set<() => void>()
  const operations: Array<Promise<unknown>> = []
  const sent = Promise.withResolvers<undefined>()
  const send = vi.fn((_channel: string, _request: DevicePreviewOpenRequest) => { sent.resolve(undefined) })
  // Assertions adapt Electron's large native interfaces, not validated preview values.
  const ownerPartial: Partial<WebContents> = { isDestroyed: () => ownerDestroyed, send }
  const owner = ownerPartial as WebContents
  const otherOwnerPartial: Partial<WebContents> = { isDestroyed: () => false, send: vi.fn() }
  const otherOwner = otherOwnerPartial as WebContents
  const debuggerApi = {
    isAttached: () => attached,
    attach: vi.fn(), detach: vi.fn(),
    sendCommand: vi.fn<(_method: string, _parameters: object) => Promise<unknown>>(),
  }
  const executeJavaScriptInIsolatedWorld = vi.fn<
    (worldId: number, scripts: readonly { code: string }[], userGesture: boolean) => Promise<unknown>
  >(async () => layoutText())
  const nativePartial: Partial<WebContents> = { getURL: () => url, isDestroyed: () => guestDestroyed, isLoadingMainFrame: () => loading }
  Object.assign(nativePartial, { executeJavaScriptInIsolatedWorld, debugger: debuggerApi })
  const nativeGuest = nativePartial as WebContents
  const window = { webContents: owner, isDestroyed: () => windowDestroyed,
    isVisible: () => visible, isMinimized: () => minimized } as BrowserWindow
  const binding = parseDevicePreviewBinding({ previewId: open.previewId, slot: 'phone', lease: uuid(3),
    width: 390, height: 844, visible: true })
  const foreignBinding = parseDevicePreviewBinding({ ...binding, lease: uuid(4) })
  const profileBinding = parseDevicePreviewBinding({ ...binding, lease: uuid(5) })
  const reservations = new Map<DesktopBrowserLeaseId, { owner: WebContents; profile: boolean; guest: WebContents }>([
    [binding.lease, { owner, profile: false, guest: nativeGuest }],
    [foreignBinding.lease, { owner: otherOwner, profile: false, guest: nativeGuest }],
    [profileBinding.lease, { owner, profile: true, guest: nativeGuest }],
  ])
  // The injected lookup represents inspectPreview: saved-account and foreign-owner leases are unavailable.
  const guest = (caller: WebContents, lease: DesktopBrowserLeaseId) => {
    lookupHook?.()
    const reservation = reservations.get(lease)
    return reservation?.owner === caller && !reservation.profile && !(reservation.guest === nativeGuest && guestDestroyed)
      ? reservation.guest : undefined
  }
  const cancelGuest = vi.fn((caller: WebContents, lease: DesktopBrowserLeaseId, captured: WebContents) => {
    if (caller !== owner || lease !== binding.lease || captured !== nativeGuest) return
    if (reservations.get(lease)?.guest === captured) reservations.delete(lease)
    manager.invalidate(caller, lease)
    guestDestroyed = true
    for (const cancel of nativeCancellations) cancel()
  })
  const manager = new DesktopDevicePreviews({ window: () => window, currentHost: () => currentHost, guest, cancelGuest, ...callbacks })
  const acknowledgement = parseDevicePreviewAcknowledgement({ requestId: open.requestId, previewId: open.previewId, opened: true })
  let next = 10
  const observe = (operation: 'layout' | 'screenshot' = 'layout', fields: Partial<DevicePreviewObserveRequest> = {}): DevicePreviewObserveRequest => {
    const request = validated({ type: 'device-preview-observe', requestId: uuid(next++), previewId: open.previewId,
      sessionId: open.sessionId, slot: 'phone', operation, ...fields })
    if (request.type !== 'device-preview-observe') throw new Error('Expected observation request')
    return request
  }
  const request = (input: DevicePreviewHostRequest, capturedHost = host) => {
    const pending = manager.request(capturedHost, input)
    operations.push(pending)
    return pending
  }
  const start = () => request(open)
  const commit = async () => {
    const pending = start()
    await sent.promise
    manager.bind(owner, binding)
    manager.acknowledge(owner, acknowledgement)
    await expect(pending).resolves.toEqual({ type: 'device-preview-result', requestId: open.requestId,
      ok: true, result: { kind: 'opened', previewId: open.previewId } })
  }
  const hold = (operation: 'layout' | 'screenshot', cancellation: 'reject' | 'manual' = 'reject') => {
    const entered = Promise.withResolvers<undefined>()
    const cancelled = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<unknown>()
    const fallback = operation === 'layout' ? layoutText() : { data: '' }
    const cancel = () => {
      cancelled.resolve(undefined)
      if (cancellation === 'reject') finish.reject(new Error('Native guest closed'))
    }
    releases.push(() => { finish.resolve(fallback) })
    const run = async () => {
      nativeCancellations.add(cancel)
      entered.resolve(undefined)
      try { return await finish.promise }
      finally { nativeCancellations.delete(cancel); settled.resolve(undefined) }
    }
    if (operation === 'layout') executeJavaScriptInIsolatedWorld.mockImplementationOnce(run)
    else debuggerApi.sendCommand.mockImplementationOnce(run)
    return { entered: entered.promise, cancelled: cancelled.promise, settled: settled.promise,
      finish: finish.resolve, reject: finish.reject }
  }
  dispose.push(async () => {
    for (const release of releases) release()
    await Promise.all([manager.retireHost(host), manager.retireHost(otherHost)])
    await Promise.all(operations)
  })
  return { manager, host, otherHost, owner, otherOwner, open, binding, foreignBinding, profileBinding,
    acknowledgement, sent: sent.promise, send, nativeGuest, cancelGuest, debuggerApi, executeJavaScriptInIsolatedWorld, reservations,
    request, observe, start, commit, hold,
    setHost: (value: object | undefined) => { currentHost = value },
    setLoading: (value: boolean) => { loading = value },
    setVisible: (value: boolean) => { visible = value },
    setMinimized: (value: boolean) => { minimized = value },
    destroyWindow: () => { windowDestroyed = true },
    destroyOwner: () => { ownerDestroyed = true },
    destroyGuest: () => { guestDestroyed = true },
    navigate: (value: string) => { url = value },
    setAttached: (value: boolean) => { attached = value },
    setLookupHook: (hook: () => void) => { lookupHook = hook },
  }
}

describe('Main device preview display admission', () => {
  it('waits for an exact acknowledgement of a bound visible ordinary guest without observing on open', async () => {
    const f = fixture()
    let settled = false
    const pending = f.start().then((result) => { settled = true; return result })
    await f.sent
    expect(f.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.devicePreviewOpen, f.open)
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
    expect(() => f.manager.acknowledge(f.otherOwner, f.acknowledgement)).toThrow()
    expect(() => f.manager.acknowledge(f.owner, parseDevicePreviewAcknowledgement({
      ...f.acknowledgement, requestId: uuid(100),
    }))).toThrow()
    expect(() => f.manager.acknowledge(f.owner, parseDevicePreviewAcknowledgement({
      ...f.acknowledgement, previewId: uuid(100),
    }))).toThrow()
    f.manager.bind(f.owner, { ...f.binding, visible: false })
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
    await expect(f.request(f.observe(), f.otherHost)).resolves.toMatchObject({ ok: false })
    expect(settled).toBe(false)
    f.manager.bind(f.owner, f.binding)
    f.manager.acknowledge(f.owner, f.acknowledgement)
    await expect(pending).resolves.toMatchObject({ ok: true, result: { kind: 'opened', previewId: f.open.previewId } })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    expect(f.debuggerApi.detach).not.toHaveBeenCalled()
  })

  it.each(['layout', 'screenshot'] as const)('rejects %s while the bound display still awaits acknowledgement', async (operation) => {
    const f = fixture()
    const pending = f.start()
    await f.sent
    await expect(f.request(f.observe(operation))).resolves.toMatchObject({ ok: false })
    f.manager.bind(f.owner, f.binding)
    f.debuggerApi.sendCommand.mockResolvedValue({ data: (await png()).toString('base64') })
    await expect(f.request(f.observe(operation))).resolves.toMatchObject({ ok: false })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
    f.manager.acknowledge(f.owner, f.acknowledgement)
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('rejects foreign renderers, foreign ordinary leases and saved-account leases at binding', async () => {
    const f = fixture()
    const pending = f.start()
    await f.sent
    expect(() => f.manager.bind(f.otherOwner, f.binding)).toThrow()
    expect(() => f.manager.bind(f.owner, f.foreignBinding)).toThrow()
    expect(() => f.manager.bind(f.owner, f.profileBinding)).toThrow()
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
    f.manager.bind(f.owner, f.binding)
    f.reservations.delete(f.binding.lease)
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
    await f.manager.close(f.owner, f.open.previewId)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  })

  it('declines an opening without retaining a bindable occurrence', async () => {
    const f = fixture()
    const pending = f.start()
    await f.sent
    f.manager.acknowledge(f.owner, { ...f.acknowledgement, opened: false })
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(() => f.manager.bind(f.owner, f.binding)).toThrow()
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
  })
})

describe('Main device preview observation', () => {
  it('returns the fixed layout query string with the exact displayed viewport', async () => {
    const f = fixture()
    await f.commit()
    const request = f.observe()
    await expect(f.request(request)).resolves.toEqual(success(request, {
      kind: 'layout', text: layoutText(), width: 390, height: 844,
    }))
    expect(f.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce()
    expect(f.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[0]).toBe(1001)
    expect(f.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[2]).toBe(false)
    const script = f.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[1][0]?.code
    expect(script).toContain('document.createTreeWalker')
    expect(script).toContain('JSON.stringify')
    expect(script).not.toContain(f.open.server.url)
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  })

  it('captures PNG only through the existing debugger and clips to the bound CSS viewport', async () => {
    const f = fixture()
    await f.commit()
    const data = (await png()).toString('base64')
    f.debuggerApi.sendCommand.mockResolvedValue({ data })
    const request = f.observe('screenshot')
    await expect(f.request(request)).resolves.toEqual(success(request, {
      kind: 'screenshot', base64: data, mimeType: 'image/png', width: 390, height: 844,
    }))
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledExactlyOnceWith('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 390, height: 844, scale: 1 },
    })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    expect(f.debuggerApi.detach).not.toHaveBeenCalled()
    f.setAttached(false)
    await expect(f.request(f.observe('screenshot'))).resolves.toMatchObject({ ok: false })
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
  })

  it.each(['host', 'session', 'slot', 'preview', 'hidden-window', 'minimized-window', 'hidden-frame', 'window-destroyed',
    'owner-destroyed', 'guest-destroyed', 'origin', 'lookup'] as const)('rejects %s mismatch before native observation', async (cause) => {
    const f = fixture()
    await f.commit()
    let request = f.observe()
    if (cause === 'host') f.setHost(f.otherHost)
    if (cause === 'session') request = f.observe('layout', { sessionId: parseDevicePreviewOpenRequest({
      ...openingWire(), sessionId: 'another-session',
    }).sessionId })
    if (cause === 'slot') request = f.observe('layout', { slot: 'tablet' })
    if (cause === 'preview') request = f.observe('layout', { previewId: parseDevicePreviewOpenRequest({
      ...openingWire(), previewId: uuid(200),
    }).previewId })
    if (cause === 'hidden-window') f.setVisible(false)
    if (cause === 'minimized-window') f.setMinimized(true)
    if (cause === 'hidden-frame') f.manager.bind(f.owner, { ...f.binding, visible: false })
    if (cause === 'window-destroyed') f.destroyWindow()
    if (cause === 'owner-destroyed') f.destroyOwner()
    if (cause === 'guest-destroyed') f.destroyGuest()
    if (cause === 'origin') f.navigate('https://other-origin.example/')
    if (cause === 'lookup') f.reservations.delete(f.binding.lease)
    await expect(f.request(request)).resolves.toMatchObject({ ok: false })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
    expect(f.cancelGuest).not.toHaveBeenCalled()
  })

  it.each(['width', 'height', 'signature', 'short', 'base64'] as const)('rejects native screenshot %s mismatch', async (cause) => {
    const f = fixture()
    await f.commit()
    const bytes = await png(cause === 'width' ? 391 : 390, cause === 'height' ? 845 : 844)
    if (cause === 'signature') bytes[0] = 0
    const data = cause === 'short' ? bytes.subarray(0, 23).toString('base64')
      : cause === 'base64' ? 'not base64!' : bytes.toString('base64')
    f.debuggerApi.sendCommand.mockResolvedValue({ data })
    await expect(f.request(f.observe('screenshot'))).resolves.toMatchObject({ ok: false })
  })

  it.each(['layout', 'screenshot'] as const)('bounds the complete %s response, not just the native payload', async (operation) => {
    const f = fixture()
    await f.commit()
    const request = f.observe(operation)
    const maximum = operation === 'layout' ? LAYOUT_BYTES : SCREENSHOT_BYTES
    let result: DevicePreviewObservation
    if (operation === 'layout') {
      const empty = JSON.stringify({ type: 'device-preview-result', requestId: request.requestId, ok: true,
        result: { kind: 'layout', text: '', width: 390, height: 844 } })
      // UTF-8 and JSON escaping both count; the text is a real fixed-query JSON result.
      const source = layoutText()
      const overhead = Buffer.byteLength(empty) + Buffer.byteLength(JSON.stringify(source)) - 2
      const text = source + ' '.repeat(maximum - overhead)
      result = { kind: 'layout', text, width: 390, height: 844 }
      f.executeJavaScriptInIsolatedWorld.mockResolvedValue(text)
    } else {
      const empty = JSON.stringify(success(request, { kind: 'screenshot', base64: '', mimeType: 'image/png', width: 390, height: 844 }))
      const length = Math.floor((maximum - Buffer.byteLength(empty)) / 4) * 4
      const base64 = paddedPng(await png(), length / 4 * 3).toString('base64')
      result = { kind: 'screenshot', base64, mimeType: 'image/png', width: 390, height: 844 }
      f.debuggerApi.sendCommand.mockResolvedValue({ data: base64 })
    }
    const response = success(request, result)
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(maximum)
    expect(maximum - Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4)
    await expect(f.request(request)).resolves.toEqual(response)
    const next = f.observe(operation)
    const enlarged = result.kind === 'layout' ? { ...result, text: result.text + ' ' }
      : { ...result, base64: paddedPng(await png(), Buffer.from(result.base64, 'base64').length + 3).toString('base64') }
    expect(Buffer.byteLength(JSON.stringify(success(next, enlarged)))).toBeGreaterThan(maximum)
    expect(Buffer.byteLength(JSON.stringify(enlarged))).toBeLessThanOrEqual(maximum)
    if (enlarged.kind === 'layout') f.executeJavaScriptInIsolatedWorld.mockResolvedValue(enlarged.text)
    else f.debuggerApi.sendCommand.mockResolvedValue({ data: enlarged.base64 })
    await expect(f.request(next)).resolves.toMatchObject({ ok: false })
  })

  it('counts multibyte layout text inside the emitted JSON envelope', async () => {
    const f = fixture()
    await f.commit()
    const text = JSON.stringify({ viewport: { width: 390, height: 844 }, document: { width: 390, height: 844 },
      horizontalOverflow: true, truncated: false,
      overflow: [{ tag: '界'.repeat(LAYOUT_BYTES / 2), x: 0, y: 0, width: 391, height: 844 }] })
    expect(text.length).toBeLessThan(LAYOUT_BYTES)
    expect(Buffer.byteLength(text)).toBeGreaterThan(LAYOUT_BYTES)
    f.executeJavaScriptInIsolatedWorld.mockResolvedValue(text)
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
  })

  it.each(['non-string', 'invalid-json', 'width', 'height'] as const)('rejects native layout %s output', async (cause) => {
    const f = fixture()
    await f.commit()
    f.executeJavaScriptInIsolatedWorld.mockResolvedValue(cause === 'non-string' ? { viewport: { width: 390, height: 844 } }
      : cause === 'invalid-json' ? 'not JSON' : layoutText(cause === 'width' ? 391 : 390, cause === 'height' ? 845 : 844))
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
  })
})

describe('Main device preview in-flight ownership and drainage', () => {
  describe.each(['layout', 'screenshot'] as const)('%s native cancellation', (operation) => {
    it.each(['cancel', 'deadline'] as const)('%s closes the captured guest and joins native rejection', async (cause) => {
      vi.useFakeTimers()
      const f = fixture()
      await f.commit()
      const barrier = f.hold(operation)
      let nativeSettled = false
      barrier.settled.then(() => { nativeSettled = true })
      const request = f.observe(operation)
      const pending = f.request(request)
      await barrier.entered
      if (cause === 'cancel') await f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))
      else {
        vi.advanceTimersByTime(24_999)
        expect(f.cancelGuest).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
      }
      expect(f.cancelGuest).toHaveBeenCalledExactlyOnceWith(f.owner, f.binding.lease, f.nativeGuest)
      expect(f.nativeGuest.isDestroyed()).toBe(true)
      expect(f.reservations.has(f.binding.lease)).toBe(false)
      await expect(pending).resolves.toMatchObject({ ok: false })
      expect(nativeSettled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each(['cancel', 'deadline'] as const)('%s retains the request until delayed native close settlement', async (cause) => {
      vi.useFakeTimers()
      const f = fixture()
      await f.commit()
      const barrier = f.hold(operation, 'manual')
      const request = f.observe(operation)
      let returned = false
      const pending = f.request(request).then((response) => { returned = true; return response })
      await barrier.entered
      if (cause === 'cancel') await f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))
      else vi.advanceTimersByTime(25_000)
      await barrier.cancelled
      expect(f.cancelGuest).toHaveBeenCalledExactlyOnceWith(f.owner, f.binding.lease, f.nativeGuest)
      await expect(f.request(request)).resolves.toMatchObject({ ok: false, error: 'Device preview request is already pending' })
      expect(returned).toBe(false)
      barrier.reject(new Error('Native close completed'))
      await expect(pending).resolves.toMatchObject({ ok: false })
      await barrier.settled
      expect(returned).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels the captured guest without revoking its replacement reservation', async () => {
      const f = fixture()
      await f.commit()
      const barrier = f.hold(operation)
      const request = f.observe(operation)
      const pending = f.request(request)
      await barrier.entered
      const replacement = { getURL: () => f.open.server.url, isDestroyed: () => false } as WebContents
      f.reservations.set(f.binding.lease, { owner: f.owner, profile: false, guest: replacement })
      await f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))
      await expect(pending).resolves.toMatchObject({ ok: false })
      expect(f.cancelGuest).toHaveBeenCalledExactlyOnceWith(f.owner, f.binding.lease, f.nativeGuest)
      expect(f.reservations.get(f.binding.lease)?.guest).toBe(replacement)
      expect(replacement.isDestroyed()).toBe(false)
    })
  })

  it('does not close a guest when cancellation arrives before native capture starts', async () => {
    const f = fixture()
    await f.commit()
    const request = f.observe()
    f.setLookupHook(() => { f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId })) })
    await expect(f.request(request)).resolves.toMatchObject({ ok: false })
    expect(f.cancelGuest).not.toHaveBeenCalled()
    expect(f.nativeGuest.isDestroyed()).toBe(false)
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  })

  it.each(['success', 'native-rejection', 'native-throw'] as const)('cleans native deadlines after %s', async (outcome) => {
    vi.useFakeTimers()
    const f = fixture()
    await f.commit()
    const error = new Error('Native query failed')
    if (outcome === 'native-rejection') f.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(error)
    if (outcome === 'native-throw') f.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => { throw error })
    const request = f.observe()
    await expect(f.request(request)).resolves.toMatchObject({ ok: outcome === 'success' })
    expect(vi.getTimerCount()).toBe(0)
    await f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))
    vi.advanceTimersByTime(30_000)
    expect(f.cancelGuest).not.toHaveBeenCalled()
  })

  it('contains and reports cancellation callback errors without abandoning native settlement', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fixture()
    await f.commit()
    const barrier = f.hold('layout', 'manual')
    const request = f.observe()
    let returned = false
    const pending = f.request(request).then((response) => { returned = true; return response })
    await barrier.entered
    const error = new Error('Guest close callback failed')
    f.cancelGuest.mockImplementationOnce(() => { throw error })
    await expect(f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))).resolves.toBeUndefined()
    expect(reported).toHaveBeenCalledWith('Device preview guest cancellation failed', error)
    await expect(f.request(request)).resolves.toMatchObject({ ok: false })
    expect(returned).toBe(false)
    barrier.reject(new Error('Native work ended'))
    await expect(pending).resolves.toMatchObject({ ok: false })
    await barrier.settled
  })

  it('bounds admitted Main requests at 64 while admitting cancellation at capacity', async () => {
    const f = fixture()
    const openings = Array.from({ length: 64 }, (_, index) => parseDevicePreviewOpenRequest({
      ...openingWire(), requestId: uuid(1000 + index), previewId: uuid(2000 + index),
    }))
    const pending = openings.map(open => f.request(open))
    expect(f.send).toHaveBeenCalledTimes(64)
    const overflow = parseDevicePreviewOpenRequest({ ...openingWire(), requestId: uuid(3000), previewId: uuid(3001) })
    await expect(f.request(overflow)).resolves.toMatchObject({ ok: false, error: 'Device preview request limit reached' })
    expect(f.send).toHaveBeenCalledTimes(64)
    await expect(f.request(validated({ type: 'device-preview-cancel', requestId: uuid(1000) }))).resolves.toBeUndefined()
    await expect(pending[0]).resolves.toMatchObject({ ok: false })
    const admitted = f.request(overflow)
    expect(f.send).toHaveBeenCalledTimes(65)
    await f.manager.retireHost(f.host)
    await expect(admitted).resolves.toMatchObject({ ok: false })
    expect((await Promise.all(pending)).every(response => response?.ok === false)).toBe(true)
    expect(f.cancelGuest).not.toHaveBeenCalled()
  })

  it.each(['revokeOwner', 'retireOwner', 'retireHost'] as const)('%s and concurrent close join an already closing occurrence', async (action) => {
    const retired = vi.fn<NonNullable<DesktopDevicePreviewOptions['retired']>>()
    const f = fixture(undefined, { retired })
    await f.commit()
    const barrier = f.hold('layout', 'manual')
    const pending = f.request(f.observe())
    await barrier.entered
    const closing = f.manager.close(f.owner, f.open.previewId)
    const duplicate = f.manager.close(f.owner, f.open.previewId)
    expect(duplicate).toBe(closing)
    expect(retired).toHaveBeenCalledExactlyOnceWith(f.host, f.open.previewId)
    await expect(f.manager.close(f.otherOwner, f.open.previewId)).rejects.toThrow('another window')
    const joining = action === 'retireHost' ? f.manager.retireHost(f.host)
      : f.manager.revokeOwner(f.owner, action === 'retireOwner')
    let closeSettled = false
    let joinSettled = false
    closing.then(() => { closeSettled = true })
    joining.then(() => { joinSettled = true })
    await barrier.cancelled
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
    expect(closeSettled).toBe(false)
    expect(joinSettled).toBe(false)
    const reopening = parseDevicePreviewOpenRequest({ ...f.open, requestId: uuid(4000) })
    await expect(f.request(reopening)).resolves.toMatchObject({ ok: false })
    barrier.reject(new Error('Native close completed'))
    await expect(pending).resolves.toMatchObject({ ok: false })
    await Promise.all([closing, duplicate, joining])
    expect(closeSettled).toBe(true)
    expect(joinSettled).toBe(true)
    await f.manager.close(f.owner, f.open.previewId)
    expect(retired).toHaveBeenCalledOnce()
  })

  it('contains retirement callback errors after removing authority and still drains native work', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('Retirement notification failed')
    const retired = vi.fn<NonNullable<DesktopDevicePreviewOptions['retired']>>(() => { throw error })
    const f = fixture(undefined, { retired })
    await f.commit()
    const barrier = f.hold('layout', 'manual')
    const pending = f.request(f.observe())
    await barrier.entered
    let drained = false
    const closing = f.manager.close(f.owner, f.open.previewId).then(() => { drained = true })
    expect(reported).toHaveBeenCalledWith('Device preview retirement callback failed', error)
    expect(() => f.manager.bind(f.owner, f.binding)).toThrow()
    await barrier.cancelled
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
    expect(drained).toBe(false)
    barrier.reject(new Error('Native close completed'))
    await expect(pending).resolves.toMatchObject({ ok: false })
    await closing
    expect(drained).toBe(true)
    expect(retired).toHaveBeenCalledOnce()
  })

  describe.each(['layout', 'screenshot'] as const)('late %s observations', (operation) => {
    it.each(['origin', 'window', 'minimized', 'frame', 'resize', 'invalidate', 'host', 'replacement-guest'] as const)(
      'rejects %s changes after native work has begun', async (cause) => {
        const f = fixture()
        await f.commit()
        const barrier = f.hold(operation)
        const pending = f.request(f.observe(operation))
        await barrier.entered
        if (cause === 'origin') f.navigate('https://another-origin.example/')
        if (cause === 'window') f.setVisible(false)
        if (cause === 'minimized') f.setMinimized(true)
        if (cause === 'frame') f.manager.bind(f.owner, { ...f.binding, visible: false })
        if (cause === 'resize') f.manager.bind(f.owner, { ...f.binding, width: 391 })
        if (cause === 'invalidate') f.manager.invalidate(f.owner, f.binding.lease)
        if (cause === 'host') f.setHost(f.otherHost)
        if (cause === 'replacement-guest') {
          const replacement = { getURL: () => f.open.server.url, isDestroyed: () => false } as WebContents
          f.reservations.set(f.binding.lease, { owner: f.owner, profile: false, guest: replacement })
        }
        barrier.finish(operation === 'layout' ? layoutText() : { data: (await png()).toString('base64') })
        await expect(pending).resolves.toMatchObject({ ok: false })
      },
    )
  })

  it.each(['close', 'retireHost'] as const)('%s cancels and awaits both native operations before returning', async (action) => {
    const f = fixture()
    await f.commit()
    const layout = f.hold('layout', 'manual')
    const screenshot = f.hold('screenshot', 'manual')
    const first = f.request(f.observe())
    const second = f.request(f.observe('screenshot'))
    await Promise.all([layout.entered, screenshot.entered])
    let drained = false
    const closing = (action === 'close' ? f.manager.close(f.owner, f.open.previewId) : f.manager.retireHost(f.host))
      .then(() => { drained = true })
    await Promise.all([layout.cancelled, screenshot.cancelled])
    expect(f.cancelGuest).toHaveBeenCalledWith(f.owner, f.binding.lease, f.nativeGuest)
    // A completed admission attempt is a promise checkpoint while native work remains blocked.
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
    expect(drained).toBe(false)
    layout.finish(layoutText())
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(drained).toBe(false)
    screenshot.finish({ data: (await png()).toString('base64') })
    await expect(second).resolves.toMatchObject({ ok: false })
    await closing
    expect(drained).toBe(true)
    expect(f.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce()
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledOnce()
    expect(f.debuggerApi.attach).not.toHaveBeenCalled()
    expect(f.debuggerApi.detach).not.toHaveBeenCalled()
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
  })

  it.each(['cancel', 'close', 'retireHost'] as const)('%s releases an opening that is waiting for display', async (action) => {
    const f = fixture()
    const pending = f.start()
    await f.sent
    if (action === 'cancel') await f.request(validated({ type: 'device-preview-cancel', requestId: f.open.requestId }))
    if (action === 'close') await f.manager.close(f.owner, f.open.previewId)
    if (action === 'retireHost') await f.manager.retireHost(f.host)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(() => f.manager.bind(f.owner, f.binding)).toThrow()
    expect(() => f.manager.acknowledge(f.owner, f.acknowledgement)).toThrow()
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
  })

  it('ignores cancellation and retirement from another Host and close from another renderer', async () => {
    const f = fixture()
    const pending = f.start()
    await f.sent
    await expect(f.request(validated({ type: 'device-preview-cancel', requestId: f.open.requestId }), f.otherHost)).resolves.toBeUndefined()
    await f.manager.retireHost(f.otherHost)
    await expect(f.manager.close(f.otherOwner, f.open.previewId)).rejects.toThrow()
    f.manager.bind(f.owner, f.binding)
    f.manager.acknowledge(f.owner, f.acknowledgement)
    await expect(pending).resolves.toMatchObject({ ok: true })
    f.manager.invalidate(f.otherOwner, f.binding.lease)
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: true })
  })

  it.each(['layout', 'screenshot'] as const)('rejects %s while the main document is loading without entering native work', async (operation) => {
    const f = fixture()
    await f.commit()
    f.setLoading(true)
    await expect(f.request(f.observe(operation))).resolves.toMatchObject({ ok: false })
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
    expect(f.cancelGuest).not.toHaveBeenCalled()
  })

  it('keeps a cancelled observation pending until native settlement and then allows correlation reuse', async () => {
    const f = fixture()
    await f.commit()
    const barrier = f.hold('layout', 'manual')
    const request = f.observe()
    const pending = f.request(request)
    await barrier.entered
    await expect(f.request(validated({ type: 'device-preview-cancel', requestId: request.requestId }))).resolves.toBeUndefined()
    await expect(f.request(request)).resolves.toMatchObject({ ok: false })
    barrier.finish(layoutText())
    await expect(pending).resolves.toMatchObject({ ok: false })
    const replacementPartial: Partial<WebContents> = {
      getURL: () => f.open.server.url, isDestroyed: () => false, isLoadingMainFrame: () => false,
    }
    Object.assign(replacementPartial, { executeJavaScriptInIsolatedWorld: f.executeJavaScriptInIsolatedWorld, debugger: f.debuggerApi })
    const replacement = replacementPartial as WebContents
    const binding = parseDevicePreviewBinding({ ...f.binding, lease: uuid(987) })
    f.reservations.set(binding.lease, { owner: f.owner, profile: false, guest: replacement })
    f.manager.bind(f.owner, binding)
    await expect(f.request(request)).resolves.toMatchObject({ ok: true, result: { kind: 'layout' } })
  })

  it.each(['close', 'revokeOwner', 'retireHost'] as const)('%s forgets an owned preview without stopping or changing its server', async (action) => {
    const open = parseDevicePreviewOpenRequest({ ...openingWire(), server: { ...openingWire().server,
      ownership: 'owned', status: 'running', projectId: uuid(300), command: 'npm run dev', jobId: 'owned-job' } })
    const retired = vi.fn<NonNullable<DesktopDevicePreviewOptions['retired']>>()
    const f = fixture(open, { retired })
    await f.commit()
    const server = { ...open.server }
    expect(f.manager.canStop(f.owner, uuid(300))).toBe(true)
    const closing = action === 'close' ? f.manager.close(f.owner, open.previewId)
      : action === 'revokeOwner' ? f.manager.revokeOwner(f.owner, true) : f.manager.retireHost(f.host)
    expect(f.manager.canStop(f.owner, uuid(300))).toBe(false)
    expect(retired).toHaveBeenCalledExactlyOnceWith(f.host, open.previewId)
    await closing
    expect(open.server).toEqual(server)
    // The native options intentionally have no launcher API; only the opening renderer event is emitted.
    expect(f.send.mock.calls.map(([channel]) => channel)).toEqual([DESKTOP_IPC.devicePreviewOpen])
    expect(f.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled()
    await expect(f.request(f.observe())).resolves.toMatchObject({ ok: false })
  })
})

describe('private device preview wire validation', () => {
  it.each([
    ['request UUID', { ...openingWire(), requestId: 'not-a-uuid' }],
    ['preview UUID', { ...openingWire(), previewId: uuid(2).toUpperCase().replace('4000', '1000') }],
    ['unknown request key', { ...openingWire(), javascript: 'arbitrary' }],
    ['credential URL', { ...openingWire(), server: { ...openingWire().server, url: 'https://user:secret@example.com/' } }],
    ['non-HTTP URL', { ...openingWire(), server: { ...openingWire().server, url: 'file:///preview-project/index.html' } }],
    ['unknown server key', { ...openingWire(), server: { ...openingWire().server, password: 'secret' } }],
    ['external termination authority', { ...openingWire(), server: { ...openingWire().server, projectId: uuid(30) } }],
    ['session byte cap', { ...openingWire(), sessionId: '界'.repeat(1366) }],
    ['cwd byte cap', { ...openingWire(), server: { ...openingWire().server, cwd: '界'.repeat(1366) } }],
    ['command byte cap', { ...openingWire(), server: { ...openingWire().server, command: 'x'.repeat(16385) } }],
    ['URL byte cap', { ...openingWire(), server: { ...openingWire().server, url: `https://example.com/${'x'.repeat(4096)}` } }],
  ])('rejects %s at the wire parser', (_name, input) => {
    expect(isDevicePreviewHostRequest(input)).toBe(false)
    expect(() => parseDevicePreviewOpenRequest(input)).toThrow()
  })

  it.each([
    { width: 0 }, { width: 8193 }, { height: 0 }, { height: 8193 }, { width: 390.5 },
    { height: Infinity }, { width: '390' }, { lease: 'not-a-uuid' }, { slot: 'desktop' },
    { visible: 'true' }, { scale: 1 }, { webContentsId: 123 },
  ])('rejects invalid renderer viewport packet %# before native binding', (fields) => {
    expect(() => parseDevicePreviewBinding({ previewId: uuid(2), slot: 'phone', lease: uuid(3),
      width: 390, height: 844, visible: true, ...fields })).toThrow()
  })

  it('accepts inclusive viewport and text byte limits but rejects observation commands and acknowledgement extras', () => {
    expect(parseDevicePreviewBinding({ previewId: uuid(2), slot: 'tablet', lease: uuid(3),
      width: 1, height: 8192, visible: false })).toMatchObject({ width: 1, height: 8192 })
    expect(parseDevicePreviewBinding({ previewId: uuid(2), slot: 'phone', lease: uuid(3),
      width: 8192, height: 1, visible: true })).toMatchObject({ width: 8192, height: 1 })
    expect(parseDevicePreviewOpenRequest({ ...openingWire(), sessionId: '界'.repeat(1365) + 'x',
      server: { ...openingWire().server, cwd: 'x'.repeat(4096), command: 'x'.repeat(16384) } })).toMatchObject({ type: 'device-preview-open' })
    const observation = { type: 'device-preview-observe', requestId: uuid(20), previewId: uuid(2),
      sessionId: 'preview-session', slot: 'phone', operation: 'layout' }
    expect(isDevicePreviewHostRequest(observation)).toBe(true)
    expect(isDevicePreviewHostRequest({ ...observation, operation: 'executeJavaScriptInIsolatedWorld' })).toBe(false)
    expect(isDevicePreviewHostRequest({ ...observation, code: 'arbitrary' })).toBe(false)
    expect(isDevicePreviewHostRequest({ type: 'device-preview-cancel', requestId: uuid(20), previewId: uuid(2) })).toBe(false)
    expect(() => parseDevicePreviewAcknowledgement({ requestId: uuid(1), previewId: uuid(2), opened: true, lease: uuid(3) })).toThrow()
  })
})
