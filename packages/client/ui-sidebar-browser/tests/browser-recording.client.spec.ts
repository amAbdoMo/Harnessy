// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrowserRecording } from '../src/client/view/useBrowserRecording.ts'
import type { BrowserRecordingDocumentId, BrowserRecordingFrame } from '../src/types.ts'

const DOCUMENT = 'fixture-document' as BrowserRecordingDocumentId
const FRAME = { documentId: DOCUMENT, jpeg: 'anBlZw==' }
const streamDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'captureStream')
const stopTrack = vi.fn()
const drawFrame = vi.fn()

class FixtureRecorder {
  static isTypeSupported(): boolean { return true }
  readonly mimeType = 'video/webm'
  state = 'inactive'
  onstart?: () => void
  onstop?: () => void
  ondataavailable?: (event: { readonly data: Blob }) => void

  start(): void {
    this.state = 'recording'
    queueMicrotask(() => { this.onstart?.() })
  }

  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['fixture video']) })
      this.onstop?.()
    })
  }
}

beforeEach(() => {
  stopTrack.mockClear()
  drawFrame.mockClear()
  vi.stubGlobal('MediaRecorder', FixtureRecorder)
  vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 450, close: vi.fn() }))
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true, value: () => ({ getTracks: () => [{ stop: stopTrack }] }),
  })
  const context: Pick<CanvasRenderingContext2D, 'drawImage'> = { drawImage: () => { drawFrame() } }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (streamDescriptor === undefined) Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  else Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', streamDescriptor)
})

it('encodes successive frames from the same document and preserves the video after stopping', async () => {
  const hook = renderHook(() => useBrowserRecording('first page'))
  const capture = vi.fn(async (_id?: BrowserRecordingDocumentId) => FRAME)
  act(() => { hook.result.current.start(capture) })
  await waitFor(() => { expect(hook.result.current.state?.phase).toBe('recording') })
  await vi.waitFor(() => { expect(capture).toHaveBeenCalledWith(DOCUMENT) })
  expect(drawFrame).toHaveBeenCalled()
  act(() => { hook.result.current.stop() })
  await waitFor(() => { expect(hook.result.current.state).toMatchObject({ phase: 'ready', video: { type: 'video/webm', size: 13 } }) })
  expect(stopTrack).toHaveBeenCalledOnce()
  act(() => { hook.result.current.discard() })
  expect(hook.result.current.state).toBeUndefined()
  hook.unmount()
})

it('discards a capture whose first frame reaches the recorder after navigation', async () => {
  const first = Promise.withResolvers<BrowserRecordingFrame>()
  const hook = renderHook(({ page }) => useBrowserRecording(page), { initialProps: { page: 'first page' } })
  const capture = vi.fn(() => first.promise)
  act(() => { hook.result.current.start(capture) })
  expect(hook.result.current.state?.phase).toBe('starting')
  hook.rerender({ page: 'other page' })
  await act(async () => { first.resolve(FRAME); await first.promise })
  expect(drawFrame).not.toHaveBeenCalled()
  expect(hook.result.current.state).toBeUndefined()
  hook.unmount()
})

it('offers no saved video when native capture fails', async () => {
  const hook = renderHook(() => useBrowserRecording('first page'))
  act(() => { hook.result.current.start(async () => { throw new Error('capture unavailable') }) })
  await waitFor(() => { expect(hook.result.current.state).toEqual({ phase: 'failed' }) })
  hook.unmount()
})
