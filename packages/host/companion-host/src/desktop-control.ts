/** Closed native-control IPC parsing; secret-bearing invitation results are never renderer values. */
import {
  exactRecord, parseGeneration, parseId, parsePairingInvitation,
} from '@deepseek-ai/dsh-companion-protocol'
import type { GrantId, InvitationId, PcId } from '@deepseek-ai/dsh-companion-protocol'
import type {
  CandidateId, CompanionControlCommand, CompanionControlResult, CompanionStatus, PairedDevice,
} from './types.ts'

const MAX_PUBLIC_ROWS = 64

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid companion control flag')
  return value
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid companion control time')
  return value
}

function label(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid companion control label')
  }
  return value
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid companion fingerprint')
  return value
}

/**
 * Admit only closed native management operations, never arbitrary service dispatch.
 * @param input - Private process-channel command JSON.
 * @returns Validated operation and branded identity; unknown fields and operations throw.
 */
export function parseCompanionControlCommand(input: unknown): CompanionControlCommand {
  if (typeof input !== 'object' || input === null || !('kind' in input)) throw new Error('Invalid companion command')
  switch (input.kind) {
    case 'describe':
    case 'activate':
    case 'createInvitation':
    case 'cancelInvitation':
      exactRecord(input, ['kind'])
      return { kind: input.kind }
    case 'approveCandidate': {
      const row = exactRecord(input, ['kind', 'candidateId', 'fingerprint'])
      return { kind: 'approveCandidate', candidateId: parseId<CandidateId>(row.candidateId), fingerprint: fingerprint(row.fingerprint) }
    }
    case 'revokeGrant': {
      const row = exactRecord(input, ['kind', 'grantId'])
      return { kind: 'revokeGrant', grantId: parseId<GrantId>(row.grantId) }
    }
    case 'setSessionManagement':
    case 'setModelSelection':
    case 'setToolDetails':
    case 'setSessionActivation': {
      const row = exactRecord(input, ['kind', 'grantId', 'expectedGeneration', 'fingerprint', 'enabled'])
      return { kind: input.kind, grantId: parseId<GrantId>(row.grantId),
        expectedGeneration: parseGeneration(row.expectedGeneration), fingerprint: fingerprint(row.fingerprint),
        enabled: boolean(row.enabled) }
    }
    default:
      throw new Error('Unsupported companion command')
  }
}

function status(input: unknown): CompanionStatus {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid companion status')
  const keys = ['available', 'connected', 'paired', 'candidates']
  if ('pcId' in input) keys.push('pcId')
  if ('invitation' in input) keys.push('invitation')
  const row = exactRecord(input, keys)
  if (!Array.isArray(row.paired) || row.paired.length > MAX_PUBLIC_ROWS
    || !Array.isArray(row.candidates) || row.candidates.length > MAX_PUBLIC_ROWS) throw new Error('Companion roster exceeds limit')
  const paired: PairedDevice[] = row.paired.map((item: unknown) => {
    const device = exactRecord(item, ['grantId', 'generation', 'fingerprint', 'displayName', 'pairedAt', 'sessionManagement', 'modelSelection', 'toolDetails', 'sessionActivation'])
    return {
      grantId: parseId<GrantId>(device.grantId), generation: parseGeneration(device.generation),
      fingerprint: fingerprint(device.fingerprint), displayName: label(device.displayName), pairedAt: timestamp(device.pairedAt),
      sessionManagement: boolean(device.sessionManagement), modelSelection: boolean(device.modelSelection),
      toolDetails: boolean(device.toolDetails), sessionActivation: boolean(device.sessionActivation),
    }
  })
  const candidates = row.candidates.map((item: unknown) => {
    const candidate = exactRecord(item, ['candidateId', 'fingerprint', 'displayName', 'expiresAt'])
    return {
      candidateId: parseId<CandidateId>(candidate.candidateId), fingerprint: fingerprint(candidate.fingerprint),
      displayName: label(candidate.displayName), expiresAt: timestamp(candidate.expiresAt),
    }
  })
  const invitation = row.invitation === undefined ? undefined : exactRecord(row.invitation, ['invitationId', 'expiresAt'])
  return {
    available: boolean(row.available), connected: boolean(row.connected), paired, candidates,
    ...(row.pcId === undefined ? {} : { pcId: parseId<PcId>(row.pcId) }),
    ...(invitation === undefined ? {} : { invitation: {
      invitationId: parseId<InvitationId>(invitation.invitationId), expiresAt: timestamp(invitation.expiresAt),
    } }),
  }
}

/**
 * Validate the private correlated response before native presentation or clipboard access.
 * @param input - JSON received from this owned Desktop Host process.
 * @param now - Local UTC epoch milliseconds used for invitation expiry.
 * @returns Public status, a Main-only invitation, or completion; malformed responses throw without reflecting values.
 */
export function parseCompanionControlResult(input: unknown, now: number): CompanionControlResult {
  if (typeof input !== 'object' || input === null || !('kind' in input)) throw new Error('Invalid companion result')
  switch (input.kind) {
    case 'completed':
    case 'activationRequired':
      exactRecord(input, ['kind'])
      return { kind: input.kind }
    case 'status': {
      const row = exactRecord(input, ['kind', 'status'])
      return { kind: 'status', status: status(row.status) }
    }
    case 'invitation': {
      const row = exactRecord(input, ['kind', 'invitation'])
      const value = exactRecord(row.invitation, ['invitationId', 'expiresAt', 'pairingUrl'])
      if (typeof value.pairingUrl !== 'string') throw new Error('Invalid companion invitation')
      const invitation = parsePairingInvitation(value.pairingUrl, now)
      try {
        if (invitation.invitationId !== value.invitationId || invitation.expiresAt !== value.expiresAt) {
          throw new Error('Companion invitation metadata mismatch')
        }
        return { kind: 'invitation', invitation: {
          invitationId: invitation.invitationId, expiresAt: invitation.expiresAt, pairingUrl: value.pairingUrl,
        } }
      } finally { invitation.secret.fill(0) }
    }
    default:
      throw new Error('Unsupported companion result')
  }
}
