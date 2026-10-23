/** Versioned private identity and current phone grants inside the existing credential-record store. */
import { createPrivateKey, createHash, randomBytes } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  decodeBase64Url, derivePcId, encodeBase64Url, exactRecord, exportPublicKey, generateP256KeyPair,
  parseGeneration, parseHttpsOrigin, parseId, parsePublicKey,
} from '@deepseek-ai/dsh-companion-protocol'
import type { GrantId, HttpsOrigin, PcId, PublicKeySpki } from '@deepseek-ai/dsh-companion-protocol'
import type { HostBudgets } from './config.ts'

/** The only companion credential address; deleting it withdraws the whole identity. */
export const RECORD_KEY = credentialKey('companion-host', 'identity')

/** Current PC-authoritative grant; signed phone copies never replace this row. */
export interface DeviceRecord {
  readonly grantId: GrantId
  readonly generation: number
  readonly phoneIdentityKey: PublicKeySpki
  readonly displayName: string
  readonly pairedAt: number
  /** Only explicit local consent grants chat management; absence denies it. */
  readonly sessionManagementV1?: true
  /** Separate explicit local consent for changing an idle chat's model; absence denies it. */
  readonly modelSelectionV1?: true
  /** Independent local consent for file labels and bounded tool summaries, including history. */
  readonly toolDetailsV1?: true
  /** Explicit consent to open an existing ordinary chat through normal PC initialization/recovery. */
  readonly sessionActivationV1?: true
}

/** Current v5 payload; v1–v4 reads normalize only in memory. identityPkcs8 never enters describe(). */
export interface PrivateRecord {
  readonly v: 5
  readonly httpsOrigin: HttpsOrigin
  readonly pcId: PcId
  readonly identityPublicKey: PublicKeySpki
  readonly identityPkcs8: string
  readonly grants: readonly DeviceRecord[]
}

/**
 * Hash a public SPKI into the literal fingerprint displayed for local approval.
 * @param key - Validated public identity key.
 * @returns Lowercase SHA-256 hex of DER, not a relay identity assertion.
 */
export function fingerprint(key: PublicKeySpki): string {
  return createHash('sha256').update(decodeBase64Url(key, 91)).digest('hex')
}

/**
 * Mint an opaque protocol identifier with 256 bits of random entropy.
 * @returns Canonical unpadded base64url; use parseId to apply the specific brand.
 */
export function randomId(): string { return encodeBase64Url(randomBytes(32)) }

function identity(record: PrivateRecord): KeyObject {
  const bytes = decodeBase64Url(record.identityPkcs8, null)
  if (bytes.length > 256) throw new Error('companion-host: corrupt identity')
  const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    || !key.export({ format: 'der', type: 'pkcs8' }).equals(bytes)
    || exportPublicKey(key) !== record.identityPublicKey) throw new Error('companion-host: corrupt identity')
  return key
}

function parse(record: CredentialRecord | undefined, origin: HttpsOrigin, budgets: HostBudgets): PrivateRecord {
  if (record?.kind !== 'grant') throw new Error('companion-host: identity missing or invalid; local reset required')
  const row = exactRecord(record.payload, ['v', 'httpsOrigin', 'pcId', 'identityPublicKey', 'identityPkcs8', 'grants'])
  if (Buffer.byteLength(JSON.stringify(row)) > budgets.maxRecordBytes) {
    throw new Error('companion-host: credential record exceeds budget')
  }
  const version = row.v
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) {
    throw new Error('companion-host: unsupported identity record version')
  }
  if (parseHttpsOrigin(row.httpsOrigin) !== origin || typeof row.identityPkcs8 !== 'string'
    || !Array.isArray(row.grants) || row.grants.length > budgets.maxGrants) {
    throw new Error('companion-host: invalid identity or changed origin; local reset and pairing required')
  }
  const publicKey = parsePublicKey(row.identityPublicKey)
  const pcId = parseId<PcId>(row.pcId)
  if (derivePcId(publicKey) !== pcId) throw new Error('companion-host: corrupt PC id')
  const ids = new Set<GrantId>()
  const phoneKeys = new Set<PublicKeySpki>()
  const grants = row.grants.map((value: unknown): DeviceRecord => {
    const keys = ['grantId', 'generation', 'phoneIdentityKey', 'displayName', 'pairedAt']
    if ((version >= 2) && typeof value === 'object' && value !== null && Object.hasOwn(value, 'sessionManagementV1')) {
      keys.push('sessionManagementV1')
    }
    if ((version >= 3) && typeof value === 'object' && value !== null && Object.hasOwn(value, 'modelSelectionV1')) {
      keys.push('modelSelectionV1')
    }
    if (version >= 4 && typeof value === 'object' && value !== null && Object.hasOwn(value, 'toolDetailsV1')) {
      keys.push('toolDetailsV1')
    }
    if (version >= 5 && typeof value === 'object' && value !== null && Object.hasOwn(value, 'sessionActivationV1')) {
      keys.push('sessionActivationV1')
    }
    const grant = exactRecord(value, keys)
    if (Object.hasOwn(grant, 'sessionManagementV1') && grant.sessionManagementV1 !== true) {
      throw new Error('companion-host: invalid chat management permission')
    }
    if (Object.hasOwn(grant, 'modelSelectionV1') && grant.modelSelectionV1 !== true) {
      throw new Error('companion-host: invalid model selection permission')
    }
    if (Object.hasOwn(grant, 'toolDetailsV1') && grant.toolDetailsV1 !== true) {
      throw new Error('companion-host: invalid tool details permission')
    }
    if (Object.hasOwn(grant, 'sessionActivationV1') && grant.sessionActivationV1 !== true) {
      throw new Error('companion-host: invalid session activation permission')
    }
    const grantId = parseId<GrantId>(grant.grantId)
    const phoneIdentityKey = parsePublicKey(grant.phoneIdentityKey)
    if (typeof grant.displayName !== 'string' || !grant.displayName.isWellFormed()
      || Buffer.byteLength(grant.displayName) > budgets.application.maxTitleBytes
      || typeof grant.pairedAt !== 'number' || !Number.isSafeInteger(grant.pairedAt) || grant.pairedAt < 0
      || ids.has(grantId) || phoneKeys.has(phoneIdentityKey)) throw new Error('companion-host: corrupt device row')
    ids.add(grantId)
    phoneKeys.add(phoneIdentityKey)
    return Object.freeze({ grantId, generation: parseGeneration(grant.generation), phoneIdentityKey,
      displayName: grant.displayName, pairedAt: grant.pairedAt,
      ...((version >= 2) && Object.hasOwn(grant, 'sessionManagementV1') ? { sessionManagementV1: true as const } : {}),
      ...((version >= 3) && Object.hasOwn(grant, 'modelSelectionV1') ? { modelSelectionV1: true as const } : {}),
      ...(version >= 4 && Object.hasOwn(grant, 'toolDetailsV1') ? { toolDetailsV1: true as const } : {}),
      ...(version >= 5 && Object.hasOwn(grant, 'sessionActivationV1') ? { sessionActivationV1: true as const } : {}) })
  })
  const result: PrivateRecord = Object.freeze({ v: 5, httpsOrigin: origin, pcId, identityPublicKey: publicKey,
    identityPkcs8: row.identityPkcs8, grants: Object.freeze(grants) })
  identity(result)
  return result
}

/** Serialized credentials consumer; every replacement checks the current durable identity. */
export class HostRecords {
  private current: PrivateRecord | undefined
  constructor(private readonly credentials: CredentialProvider, private readonly origin: HttpsOrigin,
    private readonly budgets: HostBudgets) {}

  /**
   * Validate existing storage without rewriting v1–v4, or create a v5 identity; malformed records never permit regeneration.
   * @param authority - Startup lifetime, rechecked inside the durable mutation after source reconciliation.
   * @returns Initialized validated state.
   */
  async initialize(authority: AbortSignal): Promise<PrivateRecord> {
    authority.throwIfAborted()
    const record = await this.credentials.modifyRecord(RECORD_KEY, (current) => {
      authority.throwIfAborted()
      if (current !== undefined) { parse(current, this.origin, this.budgets); return Promise.resolve(undefined) }
      const pair = generateP256KeyPair()
      const publicKey = exportPublicKey(pair.publicKey)
      const payload: PrivateRecord = { v: 5, httpsOrigin: this.origin, pcId: derivePcId(publicKey),
        identityPublicKey: publicKey, identityPkcs8: encodeBase64Url(pair.privateKey.export({ format: 'der', type: 'pkcs8' })), grants: [] }
      if (Buffer.byteLength(JSON.stringify(payload)) > this.budgets.maxRecordBytes) throw new Error('companion-host: identity budget')
      return Promise.resolve<CredentialRecord>({ kind: 'grant', payload })
    })
    authority.throwIfAborted()
    return this.current = parse(record, this.origin, this.budgets)
  }

  /**
   * Read the validated cache; consumers separately enforce current source and grant authority.
   * @returns Current validated state; callers cannot use a missing state.
   */
  snapshot(): PrivateRecord {
    if (this.current === undefined) throw new Error('companion-host: records not ready')
    return this.current
  }

  /**
   * Import the validated private identity for Host signing, never for public IPC serialization.
   * @returns Private signing handle owned only by the Host.
   */
  privateKey(): KeyObject { return identity(this.snapshot()) }

  /**
   * Re-read storage and reject deletion, corruption or replacement of the pinned running identity.
   * @returns Current stored state; no identity is generated.
   */
  async reload(): Promise<PrivateRecord> {
    const next = parse(await this.credentials.readRecord(RECORD_KEY), this.origin, this.budgets)
    if (next.identityPublicKey !== this.snapshot().identityPublicKey) throw new Error('companion-host: identity changed; restart required')
    return this.current = next
  }

  /**
   * Replace current grant rows as v5 through the provider's cross-process update lock, preserving identity and generations.
   * @param mutate - Synchronous owner decision using freshly parsed durable rows.
   * @returns Committed state; failure leaves the cache unchanged and the caller must keep authority withdrawn.
   */
  async update(mutate: (grants: readonly DeviceRecord[]) => readonly DeviceRecord[]): Promise<PrivateRecord> {
    const expected = this.snapshot().identityPublicKey
    const stored = await this.credentials.modifyRecord(RECORD_KEY, (value) => {
      const latest = parse(value, this.origin, this.budgets)
      if (latest.identityPublicKey !== expected) throw new Error('companion-host: identity replaced')
      const next = { ...latest, grants: mutate(latest.grants) }
      const validated = parse({ kind: 'grant', payload: next }, this.origin, this.budgets)
      return Promise.resolve<CredentialRecord>({ kind: 'grant', payload: validated })
    })
    return this.current = parse(stored, this.origin, this.budgets)
  }
}
