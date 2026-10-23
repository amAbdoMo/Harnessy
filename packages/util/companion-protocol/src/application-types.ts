/** Closed mobile operations; PC authorization and inbox admission remain PC-owned. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** PC Session identifier, including a preselected empty-chat target; never an operator RPC identifier. */
export type MobileSessionId = Branded<'SessionId'>
/** Existing PC Workspace identifier, never a directory path. */
export type MobileWorkspaceId = Branded<'WorkspaceId'>
/** Fresh 16-byte correlation identifier for one encrypted read or mutation request. */
export type MobileRequestId = Branded<'CompanionRequestId'>
/** One-shot 16-byte mutation correlation, not a durable idempotency or replay key. */
export type MobileOperationId = Branded<'CompanionOperationId'>
/** PC-minted 16-byte offer handle for one advertised model choice, never a provider or model identifier. */
export type MobileModelChoiceId = Branded<'CompanionModelChoiceId'>
/** PC-minted 16-byte revision of the advertised model catalog, never a provider or model identifier. */
export type MobileModelRevision = Branded<'CompanionModelRevision'>
/** Supported PC chat management operations; deletion is not a wire operation. */
export type ManagementAction = 'create' | 'rename' | 'archive' | 'pin'
/** Phone-generated 16-byte identifier scoped to authenticated grant plus Session. */
export type SubmissionId = Branded<'CompanionSubmissionId'>
/** PC-generated 16-byte identifier for one live read subscription. */
export type SubscriptionId = Branded<'CompanionSubscriptionId'>
/** PC-issued opaque continuation, interpreted only by the issuing read operation. */
export type ReadCursor = Branded<'CompanionReadCursor'>
/** Eight-byte unsigned big-endian Session sequence encoded as base64url. */
export type HistorySequence = Branded<'CompanionHistorySequence'>

/** Deployment limits; the PC must also enforce retention and operation deadlines. */
export interface ApplicationBudget {
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly maxTextBytes: number
  readonly maxTitleBytes: number
  readonly maxRows: number
  readonly maxSessions: number
  readonly maxSubscriptionsPerGrant: number
  readonly maxPendingSubmissionsPerGrant: number
  readonly readTimeoutMs: number
  readonly subscriptionLifetimeMs: number
}

/** The phone must fence each mutation before network I/O and must never automatically resend it. */
export interface MutationIdentity {
  readonly v: 1
  readonly requestId: MobileRequestId
  readonly operationId: MobileOperationId
  readonly sessionId: MobileSessionId
}

/** Fixed pre-admission refusal codes; unknown is a separate post-admission outcome. */
export type MutationRefusalCode = 'denied' | 'expired' | 'notFound' | 'busy' | 'conflict' | 'limit' | 'unavailable'

/** Phone reads, queued text follow-ups, and fixed mutations; omitted list view emits legacy summaries. */
export type ApplicationRequest =
  | { readonly v: 1; readonly type: 'listSessions'; readonly requestId: MobileRequestId; readonly cursor?: ReadCursor; readonly limit: number; readonly view?: 'navigation' }
  | { readonly v: 1; readonly type: 'readHistory'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly cursor?: ReadCursor; readonly limit: number }
  | { readonly v: 1; readonly type: 'watchProgress'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'submitText'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly text: string; readonly submissionId: SubmissionId }
  | { readonly v: 1; readonly type: 'cancelRead'; readonly requestId: MobileRequestId; readonly subscriptionId: SubscriptionId }
  | { readonly v: 1; readonly type: 'listManagementWorkspaces'; readonly requestId: MobileRequestId; readonly limit: number; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'listSessionModels'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly limit: number; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'getSessionActivation'; readonly requestId: MobileRequestId }
  /** Explicit existing-chat activation, never an effect of a read or history selection. */
  | (MutationIdentity & { readonly type: 'openSession' })
  | (MutationIdentity & (
    /** Empty chat identity must be `mobile-${operationId}`; the PC must reject an already-existing ID before creation. */
    | { readonly type: 'createSession'; readonly workspaceId: MobileWorkspaceId }
    | { readonly type: 'renameSession'; readonly title: string }
    | { readonly type: 'archiveSession' }
    /** Desired pin state, never a toggle. */
    | { readonly type: 'setSessionPinned'; readonly pinned: boolean }
  ))
  /** Model selection is its own mutation, never one of the four chat management commands. */
  | (MutationIdentity & {
    readonly type: 'selectSessionModel'
    readonly revision: MobileModelRevision
    readonly choiceId: MobileModelChoiceId
  })

/** Approved text-only history projection; strings are literal text, not rich content. */
export interface HistoryRow {
  readonly role: 'user' | 'assistant' | 'tool' | 'notice'
  readonly seq: HistorySequence
  readonly id: string
  readonly text: string
}

/** Approved Workspace identity, UTF-8 title, and nonnegative safe registry order; never a directory path. */
export interface WorkspaceSummary {
  readonly id: MobileWorkspaceId
  readonly title: string
  readonly order: number
}

/** One advertised model choice: an opaque PC-minted offer handle and two bounded display labels. */
export interface MobileModelChoice {
  readonly id: MobileModelChoiceId
  readonly title: string
  readonly providerTitle: string
}

/** Bounded mobile Session summary without paths, attachments, or arbitrary metadata. */
export interface SessionSummary {
  readonly sessionId: MobileSessionId
  readonly title: string
  readonly status: 'idle' | 'queued' | 'running' | 'closed'
  /** Atomic opt-in fields; absent in legacy results. All numbers are nonnegative safe integers. */
  readonly navigation?: {
    /** Later of creation and the cached latest human prompt time, in epoch milliseconds. */
    readonly updatedAt: number
    /** Registry-global pin index, or null when unpinned. */
    readonly pinOrder: number | null
    /** First owning Workspace in registry order, or null for an unassigned Session. */
    readonly workspace: WorkspaceSummary | null
  }
}

/** Actual awaited PC operation and targeted Session flush; partial failure is unknown, not applied. */
export type ManagementApplied =
  | { readonly outcome: 'applied'; readonly action: 'create' | 'rename' | 'pin'; readonly session: SessionSummary & { readonly navigation: NonNullable<SessionSummary['navigation']> } }
  | { readonly outcome: 'applied'; readonly action: 'archive' }

/**
 * The PC executor must recheck grant, visibility, and busy state immediately before concrete operation admission.
 * It must await already-admitted operations even if authority later changes; no durable PC receipt or revision token is promised.
 * Unknown outcomes must be reconciled by reads, never automatic resend; create identity is known before writing.
 */
export type ManagementResult = MutationIdentity & { readonly type: 'managed' } & (
  | ManagementApplied
  | { readonly outcome: 'rejected'; readonly action: ManagementAction; readonly code: MutationRefusalCode }
  | { readonly outcome: 'unknown'; readonly action: ManagementAction }
)

/** Model catalog page for one Session; every ready page carries the PC-minted revision a selection must echo. */
interface SessionModelsCommon {
  readonly v: 1
  readonly type: 'sessionModels'
  readonly requestId: MobileRequestId
  readonly sessionId: MobileSessionId
}

/**
 * Advertised model choices for one Session. The current choice need not appear in the returned page,
 * and a ready page may advertise no choices at all. Refused and closed Sessions advertise none.
 */
export type SessionModelsResult = SessionModelsCommon & (
  | { readonly state: 'ready'; readonly models: readonly MobileModelChoice[]; readonly current: MobileModelChoice | null; readonly revision: MobileModelRevision; readonly cursor?: ReadCursor }
  | { readonly state: 'busy'; readonly models: readonly []; readonly current: MobileModelChoice | null }
  | { readonly state: 'denied'; readonly models: readonly []; readonly current: null }
  | { readonly state: 'closed'; readonly models: readonly []; readonly current: null }
)

/**
 * Outcome of one model selection. A definite rejection carries its code, an unknown outcome carries
 * neither a code nor a selected choice, and only an applied outcome names the selected choice.
 */
export type ModelSelectionResult = MutationIdentity & { readonly type: 'modelSelected' } & (
  | { readonly outcome: 'applied'; readonly selected: MobileModelChoice }
  | { readonly outcome: 'rejected'; readonly code: MutationRefusalCode }
  | { readonly outcome: 'unknown' }
)

/** Existing-chat activation is applied only after writable ownership and targeted persistence settle. */
export type SessionOpenedResult = MutationIdentity & { readonly type: 'sessionOpened' } & (
  | {
    readonly outcome: 'applied'
    readonly session: SessionSummary & {
      readonly status: Exclude<SessionSummary['status'], 'closed'>
      readonly navigation: NonNullable<SessionSummary['navigation']>
    }
  }
  | { readonly outcome: 'rejected'; readonly code: MutationRefusalCode }
  | { readonly outcome: 'unknown' }
)

/** PC results; submitted is volatile inbox admission, while mutations require completion and flush. */
export type ApplicationResult =
  | { readonly v: 1; readonly type: 'sessions'; readonly requestId: MobileRequestId; readonly sessions: readonly SessionSummary[]; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'history'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly rows: readonly HistoryRow[]; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'watching'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly subscriptionId: SubscriptionId }
  | { readonly v: 1; readonly type: 'progress'; readonly subscriptionId: SubscriptionId; readonly sessionId: MobileSessionId; readonly rows: readonly HistoryRow[]; readonly status: SessionSummary['status']; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'submitted'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly submissionId: SubmissionId; readonly admission: 'inMemoryInbox' }
  | { readonly v: 1; readonly type: 'cancelled'; readonly requestId: MobileRequestId; readonly subscriptionId: SubscriptionId }
  | { readonly v: 1; readonly type: 'error'; readonly requestId: MobileRequestId; readonly code: 'denied' | 'notFound' | 'limit' | 'expired' | 'unavailable' }
  | { readonly v: 1; readonly type: 'managementWorkspaces'; readonly requestId: MobileRequestId; readonly enabled: false; readonly workspaces: readonly []; readonly cursor?: never }
  | { readonly v: 1; readonly type: 'managementWorkspaces'; readonly requestId: MobileRequestId; readonly enabled: true; readonly workspaces: readonly WorkspaceSummary[]; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'sessionActivation'; readonly requestId: MobileRequestId; readonly enabled: boolean }
  | SessionOpenedResult
  | SessionModelsResult
  | ModelSelectionResult
  | ManagementResult
