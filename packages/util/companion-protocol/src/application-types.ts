/** Closed mobile operations; PC authorization and inbox admission remain PC-owned. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Existing PC Session identifier, never an operator RPC identifier. */
export type MobileSessionId = Branded<'SessionId'>
/** Fresh 16-byte correlation identifier for one encrypted read or mutation request. */
export type MobileRequestId = Branded<'CompanionRequestId'>
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

/** Phone requests only existing Session reads and fixed queued text follow-ups. */
export type ApplicationRequest =
  | { readonly v: 1; readonly type: 'listSessions'; readonly requestId: MobileRequestId; readonly cursor?: ReadCursor; readonly limit: number }
  | { readonly v: 1; readonly type: 'readHistory'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly cursor?: ReadCursor; readonly limit: number }
  | { readonly v: 1; readonly type: 'watchProgress'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'submitText'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly text: string; readonly submissionId: SubmissionId }
  | { readonly v: 1; readonly type: 'cancelRead'; readonly requestId: MobileRequestId; readonly subscriptionId: SubscriptionId }

/** Approved text-only history projection; strings are literal text, not rich content. */
export interface HistoryRow {
  readonly role: 'user' | 'assistant' | 'tool' | 'notice'
  readonly seq: HistorySequence
  readonly id: string
  readonly text: string
}

/** Bounded mobile Session summary without paths, attachments, or arbitrary metadata. */
export interface SessionSummary {
  readonly sessionId: MobileSessionId
  readonly title: string
  readonly status: 'idle' | 'queued' | 'running' | 'closed'
}

/** PC results; admitted is volatile inbox admission, not execution or durability. */
export type ApplicationResult =
  | { readonly v: 1; readonly type: 'sessions'; readonly requestId: MobileRequestId; readonly sessions: readonly SessionSummary[]; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'history'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly rows: readonly HistoryRow[]; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'watching'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly subscriptionId: SubscriptionId }
  | { readonly v: 1; readonly type: 'progress'; readonly subscriptionId: SubscriptionId; readonly sessionId: MobileSessionId; readonly rows: readonly HistoryRow[]; readonly status: SessionSummary['status']; readonly cursor?: ReadCursor }
  | { readonly v: 1; readonly type: 'submitted'; readonly requestId: MobileRequestId; readonly sessionId: MobileSessionId; readonly submissionId: SubmissionId; readonly admission: 'inMemoryInbox' }
  | { readonly v: 1; readonly type: 'cancelled'; readonly requestId: MobileRequestId; readonly subscriptionId: SubscriptionId }
  | { readonly v: 1; readonly type: 'error'; readonly requestId: MobileRequestId; readonly code: 'denied' | 'notFound' | 'limit' | 'expired' | 'unavailable' }
