/** Main-only companion management types; none grants renderer access to secrets. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { BrowserShareId, GrantId, InvitationId, PcId } from '@deepseek-ai/dsh-companion-protocol'

/** Exact locally displayed candidate identifier, independent of relay routing. */
export type CandidateId = Branded<'CompanionCandidateId'>

/** One paired-phone browser-share operation; starting a share is a separate explicit Desktop action. */
export type BrowserShareRequest =
  | { readonly kind: 'watch'; readonly shareId?: BrowserShareId }
  | { readonly kind: 'stop'; readonly shareId: BrowserShareId }

/** Bounded response from the Desktop native browser-share owner, before the application envelope is added. */
export type BrowserShareResponse =
  | { readonly status: 'idle' | 'busy' | 'ended' }
  | { readonly status: 'frame'; readonly shareId: BrowserShareId; readonly jpeg: string }

/** Desktop-owned callback for one authenticated paired-phone browser-share operation. */
export type BrowserShareHandler = (request: BrowserShareRequest, signal: AbortSignal) => Promise<BrowserShareResponse>

/** Public phone labels; an empty display name is intentional until signed metadata exists. */
export interface PairedDevice {
  readonly grantId: GrantId
  readonly generation: number
  readonly fingerprint: string
  readonly displayName: string
  readonly pairedAt: number
  /** Actual committed per-phone permission, independent of connection availability. */
  readonly sessionManagement: boolean
  /** Independent committed permission to select models for live idle chats. */
  readonly modelSelection: boolean
  /** Independent consent for historical and live tool location/status summaries. */
  readonly toolDetails: boolean
  /** Separate consent to open existing ordinary Sessions through PC initialization. */
  readonly sessionActivation: boolean
}

/** Main-only status; no pairing link, identity private key, or credential payload. */
export interface CompanionStatus {
  readonly available: boolean
  readonly connected: boolean
  readonly pcId?: PcId
  readonly paired: readonly PairedDevice[]
  readonly invitation?: { readonly invitationId: InvitationId; readonly expiresAt: number }
  readonly candidates: readonly {
    readonly candidateId: CandidateId
    readonly fingerprint: string
    readonly displayName: string
    readonly expiresAt: number
  }[]
}

/** Closed private child-process commands; never expose approval or revocation through the product renderer. */
export type CompanionControlCommand =
  | { readonly kind: 'describe' }
  | { readonly kind: 'activate' }
  | { readonly kind: 'createInvitation' }
  | { readonly kind: 'approveCandidate'; readonly candidateId: CandidateId; readonly fingerprint: string }
  | { readonly kind: 'cancelInvitation' }
  | { readonly kind: 'revokeGrant'; readonly grantId: GrantId }
  | {
    readonly kind: 'setSessionManagement'
    readonly grantId: GrantId
    readonly expectedGeneration: number
    readonly fingerprint: string
    readonly enabled: boolean
  }
  | {
    readonly kind: 'setModelSelection'
    readonly grantId: GrantId
    readonly expectedGeneration: number
    readonly fingerprint: string
    readonly enabled: boolean
  }

  | {
    readonly kind: 'setToolDetails'
    readonly grantId: GrantId
    readonly expectedGeneration: number
    readonly fingerprint: string
    readonly enabled: boolean
  }

  | {
    readonly kind: 'setSessionActivation'
    readonly grantId: GrantId
    readonly expectedGeneration: number
    readonly fingerprint: string
    readonly enabled: boolean
  }

/** Private native-control results; invitation results contain a secret and are Main-only. */
export type CompanionControlResult =
  | { readonly kind: 'status'; readonly status: CompanionStatus }
  | { readonly kind: 'invitation'; readonly invitation: PrivateInvitation }
  | { readonly kind: 'completed' }
  | { readonly kind: 'activationRequired' }

/** One-time clipboard output. Only authenticated Desktop main IPC may receive this value. */
export interface PrivateInvitation {
  readonly invitationId: InvitationId
  readonly expiresAt: number
  readonly pairingUrl: string
}
