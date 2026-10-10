/** Type-only Desktop device-preview transport; opening never authorizes page observation. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobView } from '@deepseek-ai/dsh-jobs/view'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Host-created identity of a project launch plan for the current app run. */
export type DevicePreviewProjectId = Branded<'DevicePreviewProjectId'>
/** Main/Host-created identity of one explicitly opened preview. */
export type DevicePreviewId = Branded<'DevicePreviewId'>
/** Correlation identity of one private, cancellable Desktop request. */
export type DevicePreviewRequestId = Branded<'DevicePreviewRequestId'>
/** Independent guest location within one preview. */
export type DevicePreviewSlot = 'phone' | 'tablet'

/** Secret-free launcher status; an external endpoint never carries termination authority. */
export interface DevicePreviewServerState {
  readonly projectId?: DevicePreviewProjectId
  readonly cwd: string
  readonly command?: string
  readonly url: string
  readonly ownership: 'external' | 'owned'
  readonly status: 'external' | 'starting' | 'running' | 'stopped' | 'failed'
  readonly jobId?: JobView['id']
  readonly error?: string
}

/** An explicit opening request, tied to its initiating Session rather than the selected chat. */
export interface DevicePreviewOpenRequest {
  readonly type: 'device-preview-open'
  readonly requestId: DevicePreviewRequestId
  readonly previewId: DevicePreviewId
  readonly sessionId: SessionId
  readonly server: DevicePreviewServerState
}

/** Request-only observation of an exact preview occurrence; no interaction operation exists. */
export interface DevicePreviewObserveRequest {
  readonly type: 'device-preview-observe'
  readonly requestId: DevicePreviewRequestId
  readonly previewId: DevicePreviewId
  readonly sessionId: SessionId
  readonly slot: DevicePreviewSlot
  readonly operation: 'screenshot' | 'layout'
}

/** Abort an in-flight private request; correlation alone grants no guest access. */
export interface DevicePreviewCancelRequest {
  readonly type: 'device-preview-cancel'
  readonly requestId: DevicePreviewRequestId
}

/** Commands sent from Host to Main after launch/observation permission checks. */
export type DevicePreviewHostRequest = DevicePreviewOpenRequest | DevicePreviewObserveRequest | DevicePreviewCancelRequest

/** Bounded screenshot or layout information produced by the actually displayed live guest. */
export type DevicePreviewObservation =
  | { readonly kind: 'screenshot'; readonly base64: string; readonly mimeType: 'image/png'; readonly width: number; readonly height: number }
  | { readonly kind: 'layout'; readonly text: string; readonly width: number; readonly height: number }

/** Result of a private Desktop request; errors never masquerade as a committed display. */
export type DevicePreviewResponse =
  | { readonly type: 'device-preview-result'; readonly requestId: DevicePreviewRequestId; readonly ok: false; readonly error: string }
  | {
    readonly type: 'device-preview-result'
    readonly requestId: DevicePreviewRequestId
    readonly ok: true
    readonly result:
      | { readonly kind: 'opened'; readonly previewId: DevicePreviewId }
      | DevicePreviewObservation
      | { readonly kind: 'stopped'; readonly projectId: DevicePreviewProjectId }
  }

/** Trusted Main request to stop an owned launcher; closing a preview never sends this. */
export interface DevicePreviewStopRequest {
  readonly type: 'device-preview-stop'
  readonly requestId: DevicePreviewRequestId
  readonly projectId: DevicePreviewProjectId
}

/** Main-owned occurrence retirement; removes Host observation records without stopping a launcher. */
export interface DevicePreviewRetirement {
  readonly type: 'device-preview-retired'
  readonly previewId: DevicePreviewId
}

/** Native registration of the exact guest attached to one device frame. */
export interface DevicePreviewBinding {
  readonly previewId: DevicePreviewId
  readonly slot: DevicePreviewSlot
  readonly lease: DesktopBrowserLeaseId
  readonly width: number
  readonly height: number
  readonly visible: boolean
}

/** Committed UI opening acknowledgement; receipt of an event is not success. */
export interface DevicePreviewOpenAcknowledgement {
  readonly requestId: DevicePreviewRequestId
  readonly previewId: DevicePreviewId
  readonly opened: boolean
  readonly error?: string
}

/** Trusted application-renderer controls; absent on Web and older Desktop carriers. */
export interface DesktopDevicePreviewBridge {
  /** @param listener - explicit, Session-addressed opening consumer. @returns subscription disposer. */
  onOpenRequested(listener: (request: DevicePreviewOpenRequest) => void): () => void
  /** @param acknowledgement - commit or failure of the exact requested UI occurrence. @returns after native settlement. */
  acknowledge(acknowledgement: DevicePreviewOpenAcknowledgement): Promise<void>
  /** @param binding - displayed device frame and its caller-owned guest. @returns after native association. */
  bind(binding: DevicePreviewBinding): Promise<void>
  /** @param binding - exact retired frame; a stale release cannot clear a replacement. @returns after native association removal. */
  unbind(binding: Pick<DevicePreviewBinding, 'previewId' | 'slot' | 'lease'>): Promise<void>
  /** @param previewId - closed tab occurrence. @returns after its native observations settle, without stopping its server. */
  close(previewId: DevicePreviewId): Promise<void>
  /** @param projectId - owned launcher recorded in an opening request. @returns after the owned process range settles. */
  stop(projectId: DevicePreviewProjectId): Promise<void>
}
