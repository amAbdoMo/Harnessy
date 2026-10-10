/** Tab-scoped viewing state only; browser state and project processes are parent-owned. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { DEVICE_PRESETS, type DeviceKind, type DeviceLane, type DeviceOrientation, type DeviceViewport } from './viewport.ts'

/** A human-selected image, retained only for the tab lifetime. */
export interface DeviceImageAsset { readonly name: string; readonly src: string }
/** One lane's viewing choices, independent of page navigation state. */
export interface DeviceLaneView {
  kind: DeviceKind
  orientation: DeviceOrientation
  /** Portrait baseline; orientation swaps width/height without mutating it. */
  dimensions: DeviceViewport
  sizing: 'preset' | 'custom'
  zoom: 'fit' | 'actual'
  scale: number
  source: 'live' | 'image'
  images: Partial<Record<DeviceOrientation, DeviceImageAsset>>
}
/** Choices survive pane remounts but never persist image bytes or browser addresses to disk. */
export interface DevicePreviewView {
  urlDraft: string
  compare: boolean
  selected: DeviceLane
  phone: DeviceLaneView
  tablet: DeviceLaneView
}
/** Session store whose entries are removed by the parent's tab-lifetime controller. */
export interface DevicePreviewState { byTab: Partial<Record<TabId, DevicePreviewView>> }

function initialLane(kind: DeviceKind): DeviceLaneView {
  return { kind, orientation: 'portrait', dimensions: DEVICE_PRESETS[kind], sizing: 'preset', zoom: 'fit', scale: 0, source: 'live', images: {} }
}
/**
 * Build an unstarted viewing state; an initial URL is only an editable draft.
 * @param url - explicit tab-open address, if any.
 * @returns independent phone and tablet choices.
 */
export function initialPreviewView(url = ''): DevicePreviewView {
  return { urlDraft: url, compare: false, selected: 'phone', phone: initialLane('ios-phone'), tablet: initialLane('ios-tablet') }
}
function tabView(draft: DevicePreviewState, tabId: TabId): DevicePreviewView {
  return draft.byTab[tabId] ??= initialPreviewView()
}
type DevicePreviewActions = {
  initialize: (draft: DevicePreviewState, tabId: TabId, url: string) => void
  setUrl: (draft: DevicePreviewState, tabId: TabId, url: string) => void
  setCompare: (draft: DevicePreviewState, tabId: TabId, compare: boolean) => void
  selectLane: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane) => void
  setKind: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, kind: DeviceKind) => void
  setOrientation: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, orientation: DeviceOrientation) => void
  /** Accept already bounded portrait-baseline dimensions from the custom-input parser. */
  setDimensions: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, dimensions: DeviceViewport) => void
  setPreset: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane) => void
  setZoom: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, zoom: DeviceLaneView['zoom']) => void
  setScale: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, scale: number) => void
  setSource: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane, source: DeviceLaneView['source']) => void
  setImage: (draft: DevicePreviewState, tabId: TabId, lane: DeviceLane,
    orientation: DeviceOrientation, asset: DeviceImageAsset | undefined) => void
  forget: (draft: DevicePreviewState, tabId: TabId) => void
}
/**
 * Declare a fresh view-state store for parent Slot registration.
 * @returns store handle; the parent removes closed tabs with forget.
 */
export function createDevicePreviewStore(): EngineStoreHandle<DevicePreviewState, DevicePreviewActions> {
  return defineStore<DevicePreviewState, DevicePreviewActions>({
    init: (): DevicePreviewState => ({ byTab: {} }),
    actions: {
      initialize: (draft, tabId, url) => { draft.byTab[tabId] ??= initialPreviewView(url) },
      setUrl: (draft, tabId, url) => { tabView(draft, tabId).urlDraft = url },
      setCompare: (draft, tabId, compare) => { tabView(draft, tabId).compare = compare },
      selectLane: (draft, tabId, lane) => { tabView(draft, tabId).selected = lane },
      setKind: (draft, tabId, lane, kind) => {
        const preview = tabView(draft, tabId)[lane]
        preview.kind = kind
        if (preview.sizing === 'preset') preview.dimensions = DEVICE_PRESETS[kind]
      },
      setOrientation: (draft, tabId, lane, orientation) => { tabView(draft, tabId)[lane].orientation = orientation },
      setDimensions: (draft, tabId, lane, dimensions) => {
        const preview = tabView(draft, tabId)[lane]
        preview.dimensions = dimensions
        preview.sizing = 'custom'
      },
      setPreset: (draft, tabId, lane) => {
        const preview = tabView(draft, tabId)[lane]
        preview.dimensions = DEVICE_PRESETS[preview.kind]
        preview.sizing = 'preset'
      },
      setZoom: (draft, tabId, lane, zoom) => { tabView(draft, tabId)[lane].zoom = zoom },
      setScale: (draft, tabId, lane, scale) => { tabView(draft, tabId)[lane].scale = scale },
      setSource: (draft, tabId, lane, source) => { tabView(draft, tabId)[lane].source = source },
      setImage: (draft, tabId, lane, orientation, asset) => {
        const preview = tabView(draft, tabId)[lane]
        if (asset === undefined) Reflect.deleteProperty(preview.images, orientation)
        else { preview.images[orientation] = asset; preview.source = 'image' }
      },
      forget: (draft, tabId) => { Reflect.deleteProperty(draft.byTab, tabId) },
    },
  })
}
/** Registration store share. */
export type DevicePreviewStore = ReturnType<typeof createDevicePreviewStore>
