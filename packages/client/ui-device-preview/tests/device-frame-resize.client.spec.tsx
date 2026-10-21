// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { DeviceFrame, type DeviceFrameProps } from '../src/client/DeviceFrame.tsx'
import { initialPreviewView } from '../src/client/store.ts'
import { en } from '../src/client/copy.ts'
import type { DeviceSurfaceGeometry } from '../src/client/model.ts'
import type { DeviceOrientation, DeviceViewport } from '../src/client/viewport.ts'

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.isPrimary = init.isPrimary ?? true
  }
}

let measurePanel: (viewport: DeviceViewport) => void
class PanelObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    measurePanel = ({ width, height }) => {
      this.callback([{ target, contentRect: new DOMRectReadOnly(0, 0, width, height),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this)
    }
    measurePanel({ width: 228, height: 428 })
  }
  unobserve(): void {}
  disconnect(): void {}
}

const translate: DeviceFrameProps['t'] = (key, params) => {
  const template: string = en[key as keyof typeof en]
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
}

function mountFrame(options: { zoom?: 'actual' | 'fit'; orientation?: DeviceOrientation; image?: boolean } = {}) {
  const writes: DeviceViewport[] = []
  const updates: { geometry: DeviceSurfaceGeometry; visible: boolean }[] = []
  const detach = vi.fn()
  const guest = document.createElement('webview')
  guest.setAttribute('data-history', 'retained-history')
  guest.setAttribute('data-scroll', '120')
  const mountSurface = vi.fn<DeviceFrameProps['mountSurface']>((_tab, _lane, host) => {
    host.append(guest)
    return detach
  })
  const updateSurface: DeviceFrameProps['updateSurface'] = (_tab, _lane, geometry, visible) => { updates.push({ geometry, visible }) }
  const publishScale = vi.fn()
  function Harness({ visible }: { visible: boolean }) {
    const [dimensions, setDimensions] = useState({ width: 400, height: 800 })
    const orientation = options.orientation ?? 'portrait'
    const view = { ...initialPreviewView().phone, dimensions, orientation, zoom: options.zoom ?? 'fit' }
    if (options.image) {
      view.source = 'image'
      view.images = { portrait: { name: 'phone.png', src: 'data:image/png;base64,AA==' } }
    }
    return <DeviceFrame tabId={'resize-tab' as TabId} lane="phone" view={view} t={translate}
      live={!options.image} visible={visible} surface={{ phase: 'ready', canGoBack: true, canGoForward: false }}
      mountSurface={mountSurface} updateSurface={updateSurface} publishScale={publishScale}
      resizeViewport={(viewport) => {
        writes.push(viewport)
        setDimensions(orientation === 'portrait' ? viewport : { width: viewport.height, height: viewport.width })
      }} />
  }
  const rendered = render(<Harness visible />)
  return { ...rendered, writes, updates, detach, guest, mountSurface, publishScale,
    hide: () => { rendered.rerender(<Harness visible={false} />) },
    handle: (direction: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') => rendered.getByRole('button', { name: en[`resize.${direction}`] }),
    geometry: () => updates.at(-1)!.geometry,
  }
}

function pointer(target: Element | Window, type: string, init: PointerEventInit = {}): void {
  fireEvent(target, new TestPointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true,
    clientX: 100, clientY: 100, button: 0, ...init }))
}

function captureOn(handle: HTMLElement) {
  let captured: number | undefined
  const set = vi.fn((id: number) => { captured = id })
  const release = vi.fn(() => { captured = undefined })
  Object.assign(handle, { setPointerCapture: set, releasePointerCapture: release, hasPointerCapture: (id: number) => captured === id })
  return { set, release }
}

function shield(): Element | null {
  return document.body.querySelector(':scope > [aria-hidden="true"]')
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', PanelObserver)
  vi.stubGlobal('PointerEvent', TestPointerEvent)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('resizes larger and smaller from one press, freezes fit and retains the native page and history', () => {
  const frame = mountFrame()
  expect(frame.getAllByRole('button')).toHaveLength(8)
  expect(frame.geometry()).toEqual({ width: 400, height: 800, scale: 0.5 })
  const host = frame.getByLabelText(en['device.ios-phone'])
  const handle = frame.handle('se')
  const capture = captureOn(handle)
  pointer(handle, 'pointerdown')
  expect(document.activeElement).toBe(handle)
  expect(capture.set).toHaveBeenCalledWith(7)
  expect(shield()).not.toBeNull()
  pointer(shield()!, 'pointermove', { clientX: 120, clientY: 130 })
  expect(frame.geometry()).toEqual({ width: 440, height: 860, scale: 0.5 })
  pointer(window, 'pointermove', { clientX: 110, clientY: 115 })
  expect(frame.geometry()).toEqual({ width: 420, height: 830, scale: 0.5 })
  pointer(window, 'pointermove', { clientX: 90, clientY: 80 })
  expect(frame.geometry()).toEqual({ width: 380, height: 760, scale: 0.5 })
  act(() => { measurePanel({ width: 180, height: 300 }) })
  expect(frame.geometry().scale).toBe(0.5)
  pointer(window, 'pointerup', { clientX: 90, clientY: 80 })
  expect(frame.geometry().width).toBe(380)
  expect(frame.geometry().scale).toBeCloseTo(Math.min(164 / 404, 284 / 784))
  expect(frame.getByLabelText(en['device.ios-phone'])).toBe(host)
  expect(host.firstElementChild).toBe(frame.guest)
  expect(frame.guest.getAttribute('data-history')).toBe('retained-history')
  expect(frame.guest.getAttribute('data-scroll')).toBe('120')
  expect(frame.mountSurface).toHaveBeenCalledTimes(1)
  expect(frame.detach).not.toHaveBeenCalled()
  expect(capture.release).toHaveBeenCalledWith(7)
  expect(shield()).toBeNull()
})

it('keeps the opposite corner fixed using a captured origin, including a scrolled frame', () => {
  const frame = mountFrame()
  const handle = frame.handle('nw')
  const layout = handle.parentElement!
  const scroll = layout.parentElement!
  vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(new DOMRect(60, 70, 212, 412))
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 30, 228, 428))
  scroll.scrollLeft = 12
  scroll.scrollTop = 18
  pointer(handle, 'pointerdown')
  pointer(window, 'pointermove', { clientX: 90, clientY: 80 })
  expect(frame.geometry()).toEqual({ width: 420, height: 840, scale: 0.5 })
  expect(layout.style.getPropertyValue('--device-resize-left')).toBe('42px')
  expect(layout.style.getPropertyValue('--device-resize-top')).toBe('38px')
  pointer(window, 'pointermove', { clientX: 110, clientY: 120 })
  expect(frame.geometry()).toEqual({ width: 380, height: 760, scale: 0.5 })
  expect(layout.style.getPropertyValue('--device-resize-left')).toBe('62px')
  expect(layout.style.getPropertyValue('--device-resize-top')).toBe('78px')
  pointer(window, 'pointercancel')
})

it('ignores nonprimary presses, other buttons and stray pointers without ending the active gesture', () => {
  const frame = mountFrame({ zoom: 'actual' })
  const handle = frame.handle('e')
  pointer(handle, 'pointerdown', { isPrimary: false })
  pointer(handle, 'pointerdown', { button: 2 })
  pointer(window, 'pointermove', { clientX: 150 })
  expect(frame.writes).toEqual([])
  expect(shield()).toBeNull()
  pointer(handle, 'pointerdown')
  pointer(frame.handle('w'), 'pointerdown', { pointerId: 8 })
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) pointer(window, type, { pointerId: 8, clientX: 500 })
  pointer(handle, 'lostpointercapture', { pointerId: 8 })
  expect(shield()).not.toBeNull()
  expect(frame.writes).toEqual([])
  pointer(window, 'pointermove', { clientX: 130 })
  expect(frame.geometry()).toEqual({ width: 430, height: 800, scale: 1 })
  pointer(window, 'pointerup', { clientX: 140 })
  expect(frame.geometry()).toEqual({ width: 440, height: 800, scale: 1 })
})

it.each(['cancel', 'escape', 'lost-capture', 'blur', 'hidden', 'unmount'] as const)('%s retains the latest size and removes followers, capture and the shield', (ending) => {
  const frame = mountFrame({ zoom: 'actual' })
  const handle = frame.handle('e')
  const capture = captureOn(handle)
  const originalCursor = document.body.style.cursor
  pointer(handle, 'pointerdown')
  pointer(window, 'pointermove', { clientX: 130 })
  expect(frame.geometry().width).toBe(430)
  if (ending === 'cancel') pointer(window, 'pointercancel')
  else if (ending === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
  else if (ending === 'lost-capture') pointer(handle, 'lostpointercapture')
  else if (ending === 'blur') fireEvent.blur(window)
  else if (ending === 'hidden') frame.hide()
  else frame.unmount()
  const writes = frame.writes.length
  pointer(window, 'pointermove', { clientX: 500 })
  pointer(window, 'pointerup', { clientX: 500 })
  expect(frame.writes).toHaveLength(writes)
  expect(frame.writes.at(-1)).toEqual({ width: 430, height: 800 })
  expect(shield()).toBeNull()
  expect(capture.release).toHaveBeenCalledWith(7)
  expect(document.body.style.cursor).toBe(originalCursor)
  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  fireEvent(window, escape)
  expect(escape.defaultPrevented).toBe(false)
  if (ending === 'hidden') expect(frame.updates.at(-1)?.visible).toBe(false)
  if (ending === 'unmount') expect(frame.detach).toHaveBeenCalledTimes(1)
  else expect(frame.detach).not.toHaveBeenCalled()
})

it('allows another drag after cancellation and keyboard arrows announce oriented dimensions', () => {
  const frame = mountFrame({ zoom: 'actual', orientation: 'landscape' })
  const handle = frame.handle('e')
  pointer(handle, 'pointerdown')
  pointer(window, 'pointermove', { clientX: 130 })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(frame.geometry()).toEqual({ width: 830, height: 400, scale: 1 })
  fireEvent.keyDown(window, { key: 'Escape' })
  pointer(handle, 'pointerdown')
  pointer(window, 'pointerup', { clientX: 90 })
  expect(frame.geometry()).toEqual({ width: 820, height: 400, scale: 1 })
  act(() => { handle.focus() })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
  fireEvent.keyDown(frame.handle('n'), { key: 'ArrowUp', shiftKey: true })
  expect(frame.geometry()).toEqual({ width: 811, height: 410, scale: 1 })
  const output = frame.getByLabelText(en.scale)
  expect(output.textContent).toBe('811 × 410 CSS px · 100%')
  expect(output.getAttribute('aria-live')).toBe('polite')
  const writes = frame.writes.length
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  fireEvent.keyDown(handle, { key: 'Enter' })
  fireEvent.keyDown(handle, { key: 'ArrowRight', ctrlKey: true })
  expect(frame.writes).toHaveLength(writes)
})

it('disables handles while unmeasurable or hidden and ignores attempted hidden keyboard changes', () => {
  const frame = mountFrame()
  act(() => { measurePanel({ width: 0, height: 0 }) })
  expect(frame.handle('e')).toHaveProperty('disabled', true)
  pointer(frame.handle('e'), 'pointerdown')
  expect(shield()).toBeNull()
  act(() => { measurePanel({ width: 228, height: 428 }) })
  expect(frame.handle('e')).toHaveProperty('disabled', false)
  frame.hide()
  expect(frame.handle('e')).toHaveProperty('disabled', true)
  fireEvent.keyDown(frame.handle('e'), { key: 'ArrowRight' })
  expect(frame.writes).toEqual([])
})

it('resizes only the image frame and preserves the noninteractive fallback distinction', () => {
  const frame = mountFrame({ zoom: 'actual', image: true })
  const image = frame.getByRole('img')
  pointer(frame.handle('se'), 'pointerdown')
  pointer(window, 'pointerup', { clientX: 120, clientY: 130 })
  expect(frame.writes.at(-1)).toEqual({ width: 420, height: 830 })
  expect(frame.getByRole('img')).toBe(image)
  expect(frame.getByText(en['image.label'])).toBeTruthy()
  expect(image.getAttribute('alt')).toContain('noninteractive')
  expect(frame.mountSurface).not.toHaveBeenCalled()
})
