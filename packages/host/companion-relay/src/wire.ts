/** Closed relay routing JSON; end-to-end protocol messages retain their shared parser owner. */
import {
  decodeBase64Url, exactRecord, parseId, parsePublicKey,
  parseClientHello, parsePcWelcome, parseEncryptedFrame,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ChannelId, ClientHello, EncryptedFrame, PcId, PcWelcome, PublicKeySpki, Role, SocketGeneration,
} from '@deepseek-ai/dsh-companion-protocol'

/** Identity registration creates a challenge, not an authenticated connection. */
export interface Registration {
  readonly identityKey: PublicKeySpki
  readonly targetPcId: PcId
}

interface DataFields {
  readonly v: 1
  readonly type: 'relay-data'
  readonly channelId: ChannelId
  readonly socketGeneration: SocketGeneration
}

/** Source-bound phone traffic or an exact PC-selected phone incarnation; role is parser-owned. */
export type DataFrame = DataFields & (
  | { readonly role: 'phone'; readonly payload: ClientHello | EncryptedFrame }
  | { readonly role: 'pc'; readonly phoneSocketGeneration: SocketGeneration; readonly payload: PcWelcome | EncryptedFrame }
)

/** One PC-owned close request for an exact phone incarnation. */
export interface CloseFrame {
  readonly v: 1
  readonly type: 'relay-close'
  readonly role: 'pc'
  readonly channelId: ChannelId
  readonly socketGeneration: SocketGeneration
  readonly phoneSocketGeneration: SocketGeneration
}

/**
 * Parse the initial identity declaration after admission and byte-rate checks.
 * @param wire - JSON-decoded untrusted input.
 * @param role - Role fixed by the exact upgrade route.
 * @param admitTarget - Checks target availability and capacity before public-key parsing.
 * @returns Canonical identity and target; PC target consistency is enforced by challenge creation.
 */
export function parseRegistration(wire: unknown, role: Role, admitTarget: (target: PcId) => void): Registration {
  const row = exactRecord(wire, ['v', 'type', 'role', 'identityKey', 'targetPcId'])
  if (row.v !== 1 || row.type !== 'relay-register' || row.role !== role) throw new Error('Invalid relay registration')
  const targetPcId = parseId<PcId>(row.targetPcId)
  decodeBase64Url(targetPcId, 32)
  admitTarget(targetPcId)
  return { identityKey: parsePublicKey(row.identityKey), targetPcId }
}

/**
 * Parse only endpoint types allowed in this direction and bind both channel occurrences.
 * @param wire - JSON-decoded input.
 * @param role - Authenticated sender role.
 * @returns Closed route operation; unknown fields, types and versions throw.
 */
export function parseOperation(wire: unknown, role: Role): DataFrame | CloseFrame {
  if (typeof wire !== 'object' || wire === null || !('type' in wire)) throw new Error('Invalid relay operation')
  if (wire.type === 'relay-close') {
    if (role !== 'pc') throw new Error('Only PC may close a channel')
    const row = exactRecord(wire, ['v', 'type', 'channelId', 'socketGeneration', 'phoneSocketGeneration'])
    if (row.v !== 1) throw new Error('Invalid relay version')
    return {
      v: 1, type: 'relay-close', role: 'pc', channelId: parseId<ChannelId>(row.channelId),
      socketGeneration: parseId<SocketGeneration>(row.socketGeneration),
      phoneSocketGeneration: parseId<SocketGeneration>(row.phoneSocketGeneration),
    }
  }
  const fields = ['v', 'type', 'channelId', 'socketGeneration', 'payload']
  const row = exactRecord(wire, role === 'pc' ? [...fields, 'phoneSocketGeneration'] : fields)
  if (row.v !== 1 || row.type !== 'relay-data') throw new Error('Invalid relay data version or type')
  const payload = row.payload
  if (typeof payload !== 'object' || payload === null || !('type' in payload)) throw new Error('Invalid endpoint payload')
  let parsed: DataFrame['payload']
  if (payload.type === 'hello' && role === 'phone') parsed = parseClientHello(payload)
  else if (payload.type === 'welcome' && role === 'pc') parsed = parsePcWelcome(payload)
  else if (payload.type === 'encrypted') parsed = parseEncryptedFrame(payload)
  else throw new Error('Endpoint message is forbidden for this role')
  const channelId = parseId<ChannelId>(row.channelId)
  if (parsed.channelId !== channelId) throw new Error('Relay and endpoint channel identifiers differ')
  if (parsed.type === 'encrypted' && parsed.direction !== (role === 'pc' ? 'pc-to-phone' : 'phone-to-pc')) {
    throw new Error('Endpoint direction differs from authenticated role')
  }
  const routing = { v: 1, type: 'relay-data', channelId, socketGeneration: parseId<SocketGeneration>(row.socketGeneration) } as const
  if (role === 'pc' && parsed.type !== 'hello') {
    return { ...routing, role, phoneSocketGeneration: parseId<SocketGeneration>(row.phoneSocketGeneration), payload: parsed }
  }
  if (role === 'phone' && parsed.type !== 'welcome') return { ...routing, role, payload: parsed }
  throw new Error('Endpoint message is forbidden for this role')
}
