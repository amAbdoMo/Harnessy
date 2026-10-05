/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded, BrandedNumber } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** Main-issued identity of a persistent website/account profile. */
export type DesktopWebsiteProfileId = Branded<'DesktopWebsiteProfileId'>

/** Host-created domain request identity; transport correlation numbers never confer authority. */
export type DesktopWebsiteRequestId = Branded<'DesktopWebsiteRequestId'>

/** Main-created logical visibility occurrence; reopening never restores an old grant. */
export type DesktopWebsiteVisibilityId = Branded<'DesktopWebsiteVisibilityId'>

/** Exact native generation, logical visibility occurrence and guest lease; preparation grants no observation. */
export interface DesktopWebsiteRequestReceipt {
  readonly requestId: DesktopWebsiteRequestId
  readonly epoch: number
  readonly visibility: DesktopWebsiteVisibilityId
  readonly lease: DesktopBrowserLeaseId
}

/** Renderer association of an already captured Host request with the initiating Session's native guest. */
export interface DesktopWebsiteRequestPreparation {
  readonly requestId: DesktopWebsiteRequestId
  readonly sessionId: Branded<'SessionId'>
  readonly lease: DesktopBrowserLeaseId
}

/** Human-only, request-specific native controls; no operation accepts a profile-wide grant. */
export interface DesktopWebsiteRequestsBridge {
  /**
   * @param sessionId - initiating Session, never the globally selected Session.
   * @returns captured requests without login data or native objects.
   */
  list(this: void, sessionId: Branded<'SessionId'>): Promise<readonly DesktopWebsiteHostSnapshot[]>
  /** @param input - exact Session/request/lease association. @returns acknowledged native receipt; no access is granted. */
  prepare(this: void, input: DesktopWebsiteRequestPreparation): Promise<DesktopWebsiteRequestReceipt>
  /**
   * @param requestId - prepared request.
   * @param visible - committed logical tab visibility.
   * @returns fresh occurrence, or undefined after revocation.
   */
  visible(this: void, requestId: DesktopWebsiteRequestId, visible: boolean): Promise<DesktopWebsiteRequestReceipt | undefined>
  /** @param receipt - current visible occurrence. @returns after native acknowledgement; grants nothing. */
  acknowledge(this: void, receipt: DesktopWebsiteRequestReceipt): Promise<void>
  /**
   * @param receipt - exact acknowledged request from the explicit human action.
   * @returns committed receipt; stale or lost authority rejects.
   */
  resume(this: void, receipt: DesktopWebsiteRequestReceipt): Promise<DesktopWebsiteRequestReceipt>
  /** @param requestId - exact request being taken over. @returns after synchronous revocation and drainage. */
  takeover(this: void, requestId: DesktopWebsiteRequestId): Promise<void>
  /** @param listener - process-local request-state invalidation. @returns registration disposer. */
  onChanged(this: void, listener: () => void): () => void
}

/** Non-secret saved pairing sent only over the private Main/Host channel. */
export interface DesktopWebsiteHostProfile {
  readonly id: DesktopWebsiteProfileId
  readonly name: string
  readonly accountLabel: string
  readonly url: string
  readonly serverName: string
  readonly mcpBinding: { readonly identity: string; readonly endpoint: string }
}

/** Private process control operations; validation alone never grants website access. */
export type DesktopWebsiteHostCommand =
  | { readonly action: 'sync'; readonly profiles: readonly DesktopWebsiteHostProfile[] }
  | { readonly action: 'validate'; readonly id: DesktopWebsiteRequestId; readonly epoch: number }
  | { readonly action: 'commit'; readonly id: DesktopWebsiteRequestId; readonly epoch: number }
  | { readonly action: 'revoke'; readonly id: DesktopWebsiteRequestId }
  | { readonly action: 'drain'; readonly id: DesktopWebsiteRequestId }
  | { readonly action: 'remove'; readonly id: DesktopWebsiteRequestId }

/** Process-local authority snapshot; no Agent objects, cancellation handles or login data cross IPC. */
export interface DesktopWebsiteHostSnapshot {
  readonly id: DesktopWebsiteRequestId
  readonly profile: DesktopWebsiteProfileId
  readonly sessionId: Branded<'SessionId'>
  readonly epoch: number
  readonly status: 'pending' | 'granted' | 'revoked'
  /** Present only after the original owner ends; reversible hide/Takeover revocation omits it. */
  readonly terminal?: true
}

/** Host-minted monotonic positive safe integer, used only for private operation correlation. */
export type DesktopWebsiteOperationId = BrandedNumber<'DesktopWebsiteOperationId'>

/** Bounded observation of the exact approved guest; origin omits credentials, path, query and fragment. */
export interface DesktopWebsitePageInfo {
  readonly origin: string
  readonly title: string
  readonly titleTruncated: boolean
}

/** Explicit bounded operations on one approved guest; Host supplies one-call fallback/action consent. */
export type DesktopWebsiteBrowserOperation =
  | { readonly kind: 'dom-read'; readonly selector: string; readonly maxElements: number; readonly maxTextChars: number }
  | { readonly kind: 'click'; readonly selector: string }
  | { readonly kind: 'fill'; readonly selector: string; readonly text: string }
  | { readonly kind: 'navigate'; readonly url: string }
  /** Reserved wire tag; Main rejects it before observing or executing page code. */
  | { readonly kind: 'evaluate'; readonly code: string }
  | { readonly kind: 'screenshot'; readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }

/** Bounded JSON page observations; no native objects or accessors cross the private process channel. */
export type DesktopWebsiteBrowserJson =
  | null | boolean | number | string | DesktopWebsiteBrowserJson[] | { [key: string]: DesktopWebsiteBrowserJson }

/** Screenshot bytes are private transport data, never a tool JSON value or a renderer bridge response. */
export type DesktopWebsiteBrowserResult =
  | { readonly kind: 'json'; readonly value: DesktopWebsiteBrowserJson }
  | { readonly kind: 'screenshot'; readonly png: string; readonly width: number; readonly height: number }

/** Private Host-to-Main operation packets; no operation is exposed through the renderer bridge. */
export type DesktopWebsiteOperationCommand =
  | { readonly type: 'website-operation'; readonly operationId: DesktopWebsiteOperationId; readonly snapshot: DesktopWebsiteHostSnapshot; readonly operation: 'page-info' | DesktopWebsiteBrowserOperation }
  | { readonly type: 'website-operation-cancel'; readonly operationId: DesktopWebsiteOperationId }

/** Main emits exactly one terminal answer after native settlement; errors never include guest data. */
export type DesktopWebsiteOperationResponse =
  | { readonly type: 'website-operation-result'; readonly operationId: DesktopWebsiteOperationId; readonly snapshot: DesktopWebsiteHostSnapshot; readonly outcome: 'success'; readonly value: DesktopWebsitePageInfo | DesktopWebsiteBrowserResult }
  | { readonly type: 'website-operation-result'; readonly operationId: DesktopWebsiteOperationId; readonly snapshot: DesktopWebsiteHostSnapshot; readonly outcome: 'rejected' }

/** Saved-profile list status: `agent` projects an account reservation, not permission for a page; cleanup blocks Resume. */
export type DesktopWebsiteControl = 'human' | 'agent' | 'clearing' | 'cleanup-failed'

/** Non-secret website/account association and current main-process control state. */
export interface DesktopWebsiteProfile {
  readonly id: DesktopWebsiteProfileId
  readonly name: string
  readonly accountLabel: string
  readonly url: string
  readonly mcpServerName: string
  readonly control: DesktopWebsiteControl
}

/** User-confirmed website/account association; authentication is entered directly in the page. */
export interface DesktopWebsiteProfileInput {
  readonly name: string
  readonly accountLabel: string
  readonly url: string
  readonly mcpServerName: string
}

/** User-only profile operations, never exposed through an agent's browser transport. */
export interface DesktopWebsiteProfilesBridge {
  /** @returns profiles without passwords, cookies or filesystem paths. */
  list(this: void): Promise<readonly DesktopWebsiteProfile[]>
  /** @param input - user-confirmed pairing. @returns saved profile in human-control mode. */
  create(this: void, input: DesktopWebsiteProfileInput): Promise<DesktopWebsiteProfile>
  /** @param profile - approved profile identity. @returns one persistent guest reservation. */
  acquire(this: void, profile: DesktopWebsiteProfileId): Promise<DesktopBrowserReservation>
  /** @param profile - account being controlled. @param control - user's takeover or explicit resume decision. */
  setControl(this: void, profile: DesktopWebsiteProfileId, control: 'human' | 'agent'): Promise<void>
  /** @param profile - account whose guests are closed and authentication/storage cleared before returning. */
  signOut(this: void, profile: DesktopWebsiteProfileId): Promise<void>
  /** @param profile - account cleared before its saved association is removed; cleanup failures retain it. */
  forget(this: void, profile: DesktopWebsiteProfileId): Promise<void>
  /** @param listener - invalidation consumer. @returns unsubscribe callback. */
  onChanged(this: void, listener: () => void): () => void
}

/** A guest's approved storage partition, ephemeral unless acquired through website profiles. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Human toolbar actions; Main checks the exact lease and account reservation immediately before execution. */
export type DesktopBrowserHumanCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' }

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  readonly profiles: DesktopWebsiteProfilesBridge
  readonly requests: DesktopWebsiteRequestsBridge
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /**
   * @param lease - exact native guest.
   * @param command - Human action, including a deferred load.
   * @returns after dispatch or load settlement; reserved accounts reject.
   */
  command(lease: DesktopBrowserLeaseId, command: DesktopBrowserHumanCommand): Promise<void>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
