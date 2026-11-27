/** Local video encoding for frames captured from the current native tab. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { BrowserRecordingDocumentId, BrowserRecordingFrame } from '../../types.ts'

const DEFAULT_FRAME_RATE = 8
const MAX_DURATION_MS = 60_000
const MAX_RECORDING_BYTES = 32 * 1024 * 1024

type CaptureFrame = (documentId?: BrowserRecordingDocumentId) => Promise<BrowserRecordingFrame>
type RecordingState = { readonly phase: 'starting' | 'recording' | 'finishing' | 'failed' }
  | { readonly phase: 'ready'; readonly video: Blob }

interface Attempt {
  recorder?: MediaRecorder
  stream?: MediaStream
  frameTimer?: ReturnType<typeof setTimeout>
  endTimer?: ReturnType<typeof setTimeout>
}

function release(attempt: Attempt): void {
  clearTimeout(attempt.frameTimer)
  clearTimeout(attempt.endTimer)
  const recorder = attempt.recorder
  if (recorder !== undefined && recorder.state !== 'inactive') recorder.stop()
  attempt.stream?.getTracks().forEach((track) => { track.stop() })
}

function drawMarks(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, marks: BrowserRecordingFrame['marks'], maskedKey: string): void {
  if (marks === undefined) return
  context.save()
  try {
    if (marks.click !== undefined) {
      const x = marks.click.x * canvas.width
      const y = marks.click.y * canvas.height
      context.beginPath()
      context.arc(x, y, 15, 0, 2 * Math.PI)
      context.strokeStyle = '#19212c'
      context.lineWidth = 7
      context.stroke()
      context.strokeStyle = '#ffce54'
      context.lineWidth = 4
      context.stroke()
    }
    if (marks.key !== undefined) {
      const label = marks.key === 'masked' ? maskedKey : marks.key
      context.font = 'bold 16px system-ui'
      const width = Math.min(context.measureText(label).width + 24, canvas.width)
      const x = (canvas.width - width) / 2
      const y = Math.max(0, canvas.height - 48)
      context.fillStyle = '#19212c'
      context.fillRect(x, y, width, 32)
      context.fillStyle = '#fff'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, canvas.width / 2, y + 16, width)
    }
  } finally { context.restore() }
}

/** Detect the renderer's video encoding support.
 * @returns Whether this renderer can encode a WebM from a canvas.
 */
export function canRecordBrowser(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && MediaRecorder.isTypeSupported('video/webm')
}

/**
 * Encode only while the same visible, human-controlled page remains current.
 * @param pageKey - current page and navigation generation, absent when capture is unavailable.
 * @returns Recording state and explicit start, stop and discard actions.
 */
export function useBrowserRecording(pageKey: string | undefined): {
  readonly state: RecordingState | undefined
  readonly start: (capture: CaptureFrame, framesPerSecond?: number, maskedKey?: string) => void
  readonly stop: () => void
  readonly discard: () => void
} {
  const [state, setState] = useState<RecordingState>()
  const current = useRef<Attempt>()
  const abandon = (): void => {
    const attempt = current.current
    current.current = undefined
    if (attempt !== undefined) release(attempt)
  }
  const discard = (): void => { abandon(); setState(undefined) }
  useLayoutEffect(() => {
    setState(undefined)
    const visibilityChanged = (): void => { if (document.hidden) { abandon(); setState(undefined) } }
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => { document.removeEventListener('visibilitychange', visibilityChanged); abandon() }
  }, [pageKey])

  const stop = (): void => {
    const attempt = current.current
    if (attempt?.recorder === undefined) { discard(); return }
    setState({ phase: 'finishing' })
    clearTimeout(attempt.frameTimer)
    clearTimeout(attempt.endTimer)
    if (attempt.recorder.state !== 'inactive') attempt.recorder.stop()
  }
  const start = (capture: CaptureFrame, framesPerSecond = DEFAULT_FRAME_RATE, maskedKey = '•'): void => {
    if (pageKey === undefined || current.current !== undefined || document.hidden || !canRecordBrowser()) return
    const attempt: Attempt = {}
    current.current = attempt
    setState({ phase: 'starting' })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: false })
    const chunks: Blob[] = []
    let byteLength = 0
    let documentId: BrowserRecordingDocumentId | undefined
    const frameDelay = 1000 / framesPerSecond
    const fail = (): void => {
      if (current.current !== attempt) return
      abandon()
      setState({ phase: 'failed' })
    }
    const sample = async (): Promise<void> => {
      const started = performance.now()
      try {
        const frame = await capture(documentId)
        if (current.current !== attempt || attempt.recorder?.state === 'inactive') return
        if (context === null || documentId !== undefined && documentId !== frame.documentId) { fail(); return }
        documentId = frame.documentId
        const bytes = Uint8Array.from(atob(frame.jpeg), character => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        try {
          if (current.current !== attempt || attempt.recorder !== undefined && attempt.recorder.state !== 'recording') return
          if (attempt.recorder === undefined) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            attempt.stream = canvas.captureStream(framesPerSecond)
            const recorder = attempt.recorder = new MediaRecorder(attempt.stream, { mimeType: 'video/webm', videoBitsPerSecond: 2_000_000 })
            recorder.ondataavailable = ({ data }) => {
              if (current.current !== attempt || data.size === 0) return
              byteLength += data.size
              if (byteLength > MAX_RECORDING_BYTES) { fail(); return }
              chunks.push(data)
            }
            recorder.onerror = fail
            recorder.onstop = () => {
              if (current.current !== attempt) return
              abandon()
              if (chunks.length === 0) setState({ phase: 'failed' })
              else setState({ phase: 'ready', video: new Blob(chunks, { type: recorder.mimeType }) })
            }
            recorder.onstart = () => { if (current.current === attempt && recorder.state === 'recording') setState({ phase: 'recording' }) }
            recorder.start(1000)
          }
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          drawMarks(context, canvas, frame.marks, maskedKey)
        } finally { bitmap.close() }
        attempt.frameTimer = setTimeout(() => { void sample() }, Math.max(4, frameDelay - (performance.now() - started)))
      } catch (_error: unknown) {
        if (attempt.recorder === undefined || attempt.recorder.state === 'recording') fail()
      }
    }
    attempt.endTimer = setTimeout(stop, MAX_DURATION_MS)
    void sample()
  }
  return { state, start, stop, discard }
}
