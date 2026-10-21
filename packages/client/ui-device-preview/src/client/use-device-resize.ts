/** Local pointer ownership for one frame; every termination retains the last published viewport. */
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { resizeFromKey, resizeFromPointer, type ResizeDirection } from './device-resize.ts'
import type { DeviceViewport } from './viewport.ts'

/** Frozen display geometry, independent of dimensions echoed by the parent during a drag. */
export interface DeviceResizeDrag {
  readonly direction: ResizeDirection
  readonly viewport: DeviceViewport
  readonly scale: number
  readonly left: number
  readonly top: number
  readonly scrollWidth: number
  readonly scrollHeight: number
}

interface ResizeInputs {
  readonly viewport: DeviceViewport
  readonly scale: number
  readonly visible: boolean
  readonly presentation: string
  readonly frame: RefObject<HTMLDivElement | null>
  readonly scroll: RefObject<HTMLDivElement | null>
  readonly resizeViewport: (viewport: DeviceViewport) => void
}

/**
 * Own capture and window followers for a single primary pointer. Escape, cancel, lost capture,
 * hide and unmount commit the latest applied size rather than rolling back a live page reflow.
 * @param inputs - current presentation and parent-owned oriented dimension writer.
 * @returns frozen drag geometry and handlers for frame handles.
 */
export function useDeviceResize(inputs: ResizeInputs) {
  const [drag, setDrag] = useState<DeviceResizeDrag>()
  const active = useRef<{ stop: () => void; finish: () => void } | undefined>(undefined)
  const latest = useRef(inputs)
  latest.current = inputs

  useLayoutEffect(() => () => {
    active.current?.stop()
    active.current = undefined
  }, [])
  useLayoutEffect(() => { active.current?.finish() }, [inputs.visible, inputs.presentation])

  function begin(direction: ResizeDirection, event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0 || !event.isPrimary || active.current !== undefined || !inputs.visible || inputs.scale <= 0) return
    const frame = inputs.frame.current
    const scroll = inputs.scroll.current
    if (frame === null || scroll === null) return
    event.preventDefault()
    event.stopPropagation()
    const element: HTMLButtonElement = event.currentTarget
    element.focus({ preventScroll: true })
    const pointerId = event.pointerId
    const x = event.clientX
    const y = event.clientY
    const rect = frame.getBoundingClientRect()
    const container = scroll.getBoundingClientRect()
    const start: DeviceResizeDrag = { direction, viewport: inputs.viewport, scale: inputs.scale,
      left: rect.left - container.left + scroll.scrollLeft, top: rect.top - container.top + scroll.scrollTop,
      scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight }
    const controller = new AbortController()
    const { signal } = controller
    const stop = (): void => {
      controller.abort()
      if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    }
    const finish = (): void => {
      active.current = undefined
      stop()
      setDrag(undefined)
    }
    active.current = { stop, finish }
    const update = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== pointerId) return
      latest.current.resizeViewport(resizeFromPointer(start.viewport, direction,
        { x: pointer.clientX - x, y: pointer.clientY - y }, start.scale))
    }
    window.addEventListener('pointermove', update, { signal })
    window.addEventListener('pointerup', (pointer) => {
      if (pointer.pointerId !== pointerId) return
      update(pointer)
      finish()
    }, { signal })
    window.addEventListener('pointercancel', (pointer) => {
      if (pointer.pointerId === pointerId) finish()
    }, { signal })
    element.addEventListener('lostpointercapture', (pointer) => {
      if (pointer.pointerId === pointerId) finish()
    }, { signal })
    window.addEventListener('keydown', (key) => {
      if (key.key !== 'Escape') return
      key.preventDefault()
      key.stopPropagation()
      finish()
    }, { capture: true, signal })
    window.addEventListener('blur', finish, { signal })
    if (typeof element.setPointerCapture === 'function') element.setPointerCapture(pointerId)
    setDrag(start)
  }

  function keyboard(direction: ResizeDirection, event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (!inputs.visible || active.current !== undefined || event.altKey || event.ctrlKey || event.metaKey) return
    const next = resizeFromKey(inputs.viewport, direction, event)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    inputs.resizeViewport(next)
  }

  return { drag, begin, keyboard }
}
