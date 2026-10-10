/** Registration-facing callbacks and observable facts; page ownership stays in the parent. */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeviceLane, DeviceViewport } from './viewport.ts'
import type { DevicePreviewId } from '../types.ts'

/** Adapter-reported state, not an optimistic UI navigation result. */
export interface DeviceSurfaceState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  readonly url?: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  /** Locale key for the failure; parent owns validation and browser failures. */
  readonly failure?: 'address' | 'load' | 'approval'
}
/** Optional parent-owned project launch projection. */
export interface DeviceProjectState {
  readonly phase: 'idle' | 'external' | 'starting' | 'running' | 'stopping' | 'error'
  readonly url?: string
  readonly canStop: boolean
}
/** Live state belonging to one tab's independent browser controllers. */
export interface DevicePreviewTabRuntime {
  readonly phone: DeviceSurfaceState
  readonly tablet: DeviceSurfaceState
  readonly project?: DeviceProjectState
}
/** Stable observable snapshot; parent republishes on capability or tab changes. */
export interface DevicePreviewRuntime {
  readonly liveAvailable: boolean
  readonly byTab: Readonly<Partial<Record<TabId, DevicePreviewTabRuntime>>>
}
/** Screen dimensions and display scale consumed by a native viewport adapter. */
export interface DeviceSurfaceGeometry extends DeviceViewport { readonly scale: number }
/**
 * Inject from the registration's apply closure. Allocate controllers outside components,
 * retain them across detach/remount and orientation changes, and dispose on tab closure.
 * All callbacks contain/report operation failures through the runtime source or a parent toast.
 */
export interface DevicePreviewInjected {
  /**
   * Attach or update an existing controller. Cleanup detaches DOM, never destroys the page.
   * Width/height are unscaled CSS pixels; scale is presentation-only and must not change
   * page zoom, responsive breakpoints, history or navigation. The UI already scales its frame.
   */
  readonly retainTab: (tabId: TabId, signal: AbortSignal, url?: string, previewId?: DevicePreviewId) => boolean
  readonly mountSurface: (tabId: TabId, lane: DeviceLane, host: HTMLElement, geometry: DeviceSurfaceGeometry) => (() => void)
  /** Update a retained guest without removing its DOM or resetting its history. */
  readonly updateSurface: (tabId: TabId, lane: DeviceLane, geometry: DeviceSurfaceGeometry, visible: boolean) => void
  /** Expand the existing Sidebar for a user-requested two-device comparison. */
  readonly expandComparison: () => void
  /** Called only by an explicit Start/Go gesture; validates URL and authorization in the parent. */
  readonly navigate: (tabId: TabId, lane: DeviceLane, url: string) => void
  readonly reload: (tabId: TabId, lane: DeviceLane) => void
  readonly goBack: (tabId: TabId, lane: DeviceLane) => void
  readonly goForward: (tabId: TabId, lane: DeviceLane) => void
  /** Explicit Stop affects only the owned launcher recorded by this tab's opening request. */
  readonly stopProject: (tabId: TabId) => void
  readonly hooks: { readonly devicePreview: HostObservable<DevicePreviewRuntime> }
}
