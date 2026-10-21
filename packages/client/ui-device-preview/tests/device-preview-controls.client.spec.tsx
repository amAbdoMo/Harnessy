// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DevicePreview, type DevicePreviewProps } from '../src/client/DevicePreview.tsx'
import type { DevicePreviewRuntime, DeviceSurfaceGeometry } from '../src/client/model.ts'
import { createDevicePreviewStore } from '../src/client/store.ts'
import type { DeviceLane } from '../src/client/viewport.ts'
import { en } from '../src/client/copy.ts'

const TAB = 'device-tab' as TabId

function selectorHook<Snapshot>(source: HostObservable<Snapshot>) {
  return function useSelector<Selected>(select: (snapshot: Snapshot) => Selected): Selected {
    return select(useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot()))
  }
}

class PanelResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, contentRect: new DOMRectReadOnly(0, 0, 600, 900),
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this)
  }
  unobserve(): void {}
  disconnect(): void {}
}

function mountPreview(liveAvailable = true) {
  const store = createDevicePreviewStore().create()
  const idle = { phase: 'idle', canGoBack: false, canGoForward: false } as const
  const runtime = createSnapshotStore<DevicePreviewRuntime>({ liveAvailable, byTab: { [TAB]: { phone: idle, tablet: idle } } })
  const requests: { lane: DeviceLane; url: string }[] = []
  const mounts: { lane: DeviceLane; geometry: DeviceSurfaceGeometry; host: HTMLElement }[] = []
  const geometries: { lane: DeviceLane; geometry: DeviceSurfaceGeometry; visible: boolean }[] = []
  const detach = vi.fn()
  const lifetime = new AbortController()
  let refresh: (() => void) | undefined
  const props: Pick<DevicePreviewProps, 'sessionId' | 'tab' | 'mode' | 'navigation' | 'fullscreen' | 'selectMobile' | 'useStore' | 'actions' | 't' | 'useDevicePreview'
    | 'mountSurface' | 'updateSurface' | 'retainTab' | 'expandComparison' | 'stopProject' | 'navigate' | 'reload' | 'goBack' | 'goForward'> = {
    sessionId: 'device-session' as SessionId,
    mode: 'mobile', navigation: undefined, fullscreen: false, selectMobile: vi.fn(),
    tab: { id: TAB, kind: 'browser', title: 'Browser', contentId: 'sidebar://browser/1', visible: true,
      navigation: { address: 'sidebar://browser/1', params: { url: 'https://example.test/' }, revision: 0 },
      signal: lifetime.signal, actions: { bindCommands: (commands) => {
        refresh = commands.refresh
        return () => { if (refresh === commands.refresh) refresh = undefined }
      }, openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() } },
    useStore: selectorHook(store), actions: store.actions, useDevicePreview: selectorHook(runtime),
    t: (key, params) => {
      const template: string = en[key as keyof typeof en]
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
    },
    mountSurface: (_tabId, lane, host, geometry) => { mounts.push({ lane, geometry, host }); return detach },
    updateSurface: (_tabId, lane, geometry, visible) => { geometries.push({ lane, geometry, visible }) },
    retainTab: vi.fn(() => false), expandComparison: vi.fn(), stopProject: vi.fn(),
    navigate: (_tabId, lane, url) => {
      requests.push({ lane, url })
      const snapshot = runtime.getSnapshot()
      runtime.set({ ...snapshot, byTab: { ...snapshot.byTab, [TAB]: { ...snapshot.byTab[TAB]!, [lane]: { ...idle, phase: 'ready', url } } } })
    },
    reload: vi.fn(), goBack: vi.fn(), goForward: vi.fn(),
  }
  const view = render(<DevicePreview {...props as DevicePreviewProps} />)
  return { view, store, runtime, requests, mounts, geometries, detach, lifetime,
    refresh: () => { refresh?.() }, reload: props.reload,
    present: (mode: DevicePreviewProps['mode'], navigation: DevicePreviewProps['navigation']) => {
      view.rerender(<DevicePreview {...props as DevicePreviewProps} mode={mode} navigation={navigation} />)
    },
    remount: () => render(<DevicePreview {...props as DevicePreviewProps} />) }
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', PanelResizeObserver) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Device preview human controls', () => {
  it('imports each Desktop navigation revision once and preserves subsequent edits on rerender', () => {
    const preview = mountPreview()
    const navigation = { url: 'https://updated.test/', revision: 1 }
    preview.present('mobile', navigation)
    expect(preview.view.getAllByRole('textbox', { name: en.url })).toHaveLength(1)
    const address = preview.view.getByRole('textbox', { name: en.url })
    expect(address).toHaveProperty('value', navigation.url)
    expect(preview.requests).toEqual([{ lane: 'phone', url: navigation.url }])
    fireEvent.change(address, { target: { value: 'https://draft.test/' } })
    preview.present('mobile', { ...navigation })
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://draft.test/')
    expect(preview.requests).toHaveLength(1)
    const next = { url: 'https://next.test/', revision: 2 }
    preview.present('mobile', next)
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', next.url)
    fireEvent.change(preview.view.getByRole('textbox', { name: en.url }), { target: { value: 'https://next-draft.test/' } })
    preview.present('mobile', { ...next })
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://next-draft.test/')
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    expect(preview.requests).toEqual([
      { lane: 'phone', url: navigation.url }, { lane: 'phone', url: next.url },
      { lane: 'phone', url: 'https://next-draft.test/' },
    ])
  })

  it('seeds an unstarted comparison lane and targets only the selected lane without resetting the other page', () => {
    const preview = mountPreview()
    expect(preview.requests).toEqual([])
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    expect(preview.requests).toEqual([{ lane: 'phone', url: 'https://example.test/' }])
    fireEvent.change(preview.view.getByRole('textbox', { name: en.url }), { target: { value: 'https://unsubmitted.test/' } })
    fireEvent.click(preview.view.getByRole('button', { name: en.compare }))
    expect(preview.view.getAllByRole('region', { name: /^(Mobile|Tablet)$/ })).toHaveLength(2)
    expect(preview.view.getAllByRole('textbox', { name: en.url })).toHaveLength(1)
    expect(preview.requests).toEqual([{ lane: 'phone', url: 'https://example.test/' }, { lane: 'tablet', url: 'https://example.test/' }])
    preview.present('tablet', undefined)
    fireEvent.change(preview.view.getByRole('textbox', { name: en.url }), { target: { value: 'https://tablet.test/' } })
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    preview.present('mobile', undefined)
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://example.test/')
    fireEvent.change(preview.view.getByRole('textbox', { name: en.url }), { target: { value: 'https://phone.test/' } })
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    fireEvent.click(preview.view.getByRole('button', { name: en.single }))
    fireEvent.click(preview.view.getByRole('button', { name: en.compare }))
    preview.present('tablet', undefined)
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://tablet.test/')
    expect(preview.requests).toEqual([
      { lane: 'phone', url: 'https://example.test/' }, { lane: 'tablet', url: 'https://example.test/' },
      { lane: 'tablet', url: 'https://tablet.test/' }, { lane: 'phone', url: 'https://phone.test/' },
    ])
  })

  it('opens the recorded project URL in the selected lane without replacing the other page', () => {
    const preview = mountPreview()
    act(() => {
      const state = preview.runtime.getSnapshot()
      preview.runtime.set({ ...state, byTab: { ...state.byTab, [TAB]: { ...state.byTab[TAB]!,
        project: { phase: 'external', url: 'https://project.test/', canStop: false },
      } } })
    })
    fireEvent.click(preview.view.getByRole('button', { name: en['project.open'] }))
    expect(preview.requests).toEqual([{ lane: 'phone', url: 'https://project.test/' }])
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://project.test/')
  })

  it('preserves an image-only Tablet when comparing it with a live Mobile page', () => {
    const preview = mountPreview()
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    act(() => { preview.store.actions.setImage(TAB, 'tablet', 'portrait', { name: 'tablet.png', src: 'data:image/png;base64,AA==' }) })
    fireEvent.click(preview.view.getByRole('button', { name: en.compare }))
    const tablet = within(preview.view.getByRole('region', { name: en.tablet }))
    expect(tablet.getByRole('img').getAttribute('alt')).toContain('tablet.png')
    expect(tablet.getByText(en['image.label'])).toBeTruthy()
    expect(preview.requests).toEqual([{ lane: 'phone', url: 'https://example.test/' }])
  })

  it('does not navigate or refresh retained history while an image is displayed', () => {
    const preview = mountPreview()
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    act(() => {
      const state = preview.runtime.getSnapshot()
      preview.runtime.set({ ...state, byTab: { ...state.byTab, [TAB]: { ...state.byTab[TAB]!, phone: {
        phase: 'ready', url: 'https://example.test/', canGoBack: true, canGoForward: true,
      } } } })
    })
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    fireEvent.click(phone.getByRole('button', { name: en.settings }))
    fireEvent.click(phone.getByRole('button', { name: en.image }))
    for (const name of [en.back, en.forward, en.reload]) expect(preview.view.getByRole('button', { name })).toHaveProperty('disabled', true)
    act(() => { preview.refresh() })
    expect(preview.reload).not.toHaveBeenCalled()
    fireEvent.click(phone.getByRole('button', { name: en.live }))
    for (const name of [en.back, en.forward, en.reload]) expect(preview.view.getByRole('button', { name })).toHaveProperty('disabled', false)
    act(() => { preview.refresh() })
    expect(preview.reload).toHaveBeenCalledOnce()
  })

  it('keeps advanced controls collapsed until Settings opens and closes them with Escape', () => {
    const preview = mountPreview()
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    expect(preview.view.getAllByRole('textbox', { name: en.url })).toHaveLength(1)
    expect(preview.view.queryByRole('button', { name: 'Start preview' })).toBeNull()
    expect(preview.view.queryByRole('heading', { name: en.phone })).toBeNull()
    expect(phone.getByRole('button', { name: en.device })).toBeTruthy()
    expect(phone.getByRole('group', { name: en.orientation })).toBeTruthy()
    expect(phone.queryByRole('button', { name: en.custom })).toBeNull()
    expect(phone.queryByRole('group', { name: en.source })).toBeNull()
    expect(preview.view.queryByText(en.limitation)).toBeNull()
    const settings = phone.getByRole('button', { name: en.settings })
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(settings)
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(phone.getByRole('button', { name: en.custom })).toBeTruthy()
    expect(phone.getByRole('group', { name: en.source })).toBeTruthy()
    fireEvent.keyDown(phone.getByRole('button', { name: en.image }), { key: 'Escape' })
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(settings)
    expect(phone.queryByRole('group', { name: en.source })).toBeNull()
    expect(preview.requests).toEqual([])
  })

  it('changes display scale and orientation without navigating or changing the CSS viewport to panel size', () => {
    const preview = mountPreview()
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    const initial = preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry
    expect(initial.width).toBe(393)
    expect(initial.height).toBe(852)
    fireEvent.click(phone.getByRole('button', { name: en.landscape }))
    fireEvent.click(phone.getByRole('button', { name: en.scale }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: en.actual }))
    expect(preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry).toEqual({ width: 852, height: 393, scale: 1 })
    expect(phone.getByText('852 × 393 CSS px · 100%')).toBeTruthy()
    expect(preview.requests).toEqual([])
    expect(preview.detach).not.toHaveBeenCalled()
    preview.view.unmount()
    preview.remount()
    expect(preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry).toEqual({ width: 852, height: 393, scale: 1 })
    expect(preview.lifetime.signal.aborted).toBe(false)
    expect(preview.detach).toHaveBeenCalled()
  })

  it('rejects invalid custom input without replacing the last viewport, and applies landscape width as shown', () => {
    const preview = mountPreview()
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    fireEvent.click(phone.getByRole('button', { name: en.landscape }))
    fireEvent.click(phone.getByRole('button', { name: en.settings }))
    fireEvent.click(phone.getByRole('button', { name: en.custom }))
    fireEvent.change(phone.getByLabelText(en.width), { target: { value: '2561' } })
    fireEvent.click(phone.getByRole('button', { name: en.apply }))
    expect(phone.getByRole('alert').textContent).toContain('240 to 2560')
    expect(preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry.width).toBe(852)
    fireEvent.change(phone.getByLabelText(en.width), { target: { value: '1000' } })
    fireEvent.change(phone.getByLabelText(en.height), { target: { value: '500' } })
    fireEvent.click(phone.getByRole('button', { name: en.apply }))
    expect(preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry).toMatchObject({ width: 1000, height: 500 })
    expect(phone.getByRole('button', { name: en.preset }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(phone.getByRole('button', { name: en.preset }))
    expect(phone.getByRole('button', { name: en.preset }).getAttribute('aria-pressed')).toBe('true')
    expect(phone.queryByRole('textbox', { name: en.width })).toBeNull()
    expect(preview.geometries.filter(item => item.lane === 'phone').at(-1)!.geometry).toMatchObject({ width: 852, height: 393 })
    expect(preview.requests).toEqual([])
  })

  it('offers labeled human-selected images without native live support and never reuses portrait for landscape', async () => {
    const preview = mountPreview(false)
    expect((preview.view.getByRole('button', { name: en.go }) as HTMLButtonElement).disabled).toBe(true)
    expect(preview.view.getByText(en.desktopOnly)).toBeTruthy()
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    fireEvent.click(phone.getByRole('button', { name: en.settings }))
    const selectLabel = en['image.select'].replace('{orientation}', en.portrait)
    fireEvent.change(phone.getByLabelText(selectLabel), { target: { files: [new File(['image bytes'], 'phone.png', { type: 'image/png' })] } })
    await waitFor(() => { expect(phone.getByRole('img').getAttribute('alt')).toContain('phone.png — Portrait image preview, noninteractive') })
    expect(phone.getByText(en['image.label'])).toBeTruthy()
    fireEvent.click(phone.getByRole('button', { name: en.landscape }))
    expect(phone.queryByRole('img')).toBeNull()
    expect(phone.getByText(en['image.missing'].replace('{orientation}', en.landscape))).toBeTruthy()
    fireEvent.click(phone.getByRole('button', { name: en.portrait }))
    expect(phone.getByRole('img').getAttribute('src')).toContain('data:image/png;base64,')
    fireEvent.error(phone.getByRole('img'))
    expect(phone.getByText(en['image.failed'])).toBeTruthy()
    expect(preview.mounts).toEqual([])
    expect(preview.requests).toEqual([])
  })

  it('keeps a failed page address visible and offers image fallback when the adapter reports unavailability', () => {
    const preview = mountPreview()
    fireEvent.click(preview.view.getByRole('button', { name: en.go }))
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    act(() => {
      const snapshot = preview.runtime.getSnapshot()
      preview.runtime.set({ ...snapshot, byTab: { [TAB]: { ...snapshot.byTab[TAB]!, phone: {
        phase: 'error', url: 'https://example.test/', canGoBack: false, canGoForward: false,
      } } } })
    })
    expect(phone.getByText(en['error.load'])).toBeTruthy()
    expect(preview.view.getByRole('textbox', { name: en.url })).toHaveProperty('value', 'https://example.test/')
    act(() => {
      const snapshot = preview.runtime.getSnapshot()
      preview.runtime.set({ ...snapshot, byTab: { [TAB]: { ...snapshot.byTab[TAB]!, phone: {
        phase: 'unavailable', url: 'https://example.test/', canGoBack: false, canGoForward: false,
      } } } })
    })
    expect(phone.getByText(en.unavailable)).toBeTruthy()
    expect(phone.getByText(en['image.label'])).toBeTruthy()
    fireEvent.click(phone.getByRole('button', { name: en.settings }))
    expect(phone.getByRole('button', { name: en['image.select'].replace('{orientation}', en.portrait) })).toBeTruthy()
    expect(preview.requests).toEqual([{ lane: 'phone', url: 'https://example.test/' }])
    expect(preview.detach).toHaveBeenCalled()
  })

  it('keeps image selection errors beside the file control and does not replace a chosen image', async () => {
    const preview = mountPreview(false)
    act(() => { preview.store.actions.setImage(TAB, 'phone', 'portrait', { name: 'kept.png', src: 'data:image/png;base64,AA==' }) })
    const phone = within(preview.view.getByRole('region', { name: en.phone }))
    fireEvent.click(phone.getByRole('button', { name: en.settings }))
    const input = phone.getByLabelText(en['image.select'].replace('{orientation}', en.portrait))
    fireEvent.change(input, { target: { files: [new File(['text'], 'not-an-image.txt', { type: 'text/plain' })] } })
    expect(phone.getByRole('alert').textContent).toBe(en['image.failed'])
    expect(phone.getByRole('img').getAttribute('alt')).toContain('kept.png')
    fireEvent.click(phone.getByRole('button', { name: en['image.remove'] }))
    await waitFor(() => { expect(phone.queryByRole('img')).toBeNull() })
  })
})
