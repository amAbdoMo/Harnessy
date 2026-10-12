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
}

/** Owner-validated persisted payload; identityPkcs8 is never included in describe(). */
export interface PrivateRecord {
  readonly v: 1
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
  if (row.v !== 1 || parseHttpsOrigin(row.httpsOrigin) !== origin || typeof row.identityPkcs8 !== 'string'
    || !Array.isArray(row.grants) || row.grants.length > budgets.maxGrants) {
    throw new Error('companion-host: invalid identity or changed origin; local reset and pairing required')
  }
  const publicKey = parsePublicKey(row.identityPublicKey)
  const pcId = parseId<PcId>(row.pcId)
  if (derivePcId(publicKey) !== pcId) throw new Error('companion-host: corrupt PC id')
  const ids = new Set<GrantId>()
  const phoneKeys = new Set<PublicKeySpki>()
  const grants = row.grants.map((value: unknown): DeviceRecord => {
    const grant = exactRecord(value, ['grantId', 'generation', 'phoneIdentityKey', 'displayName', 'pairedAt'])
    const grantId = parseId<GrantId>(grant.grantId)
    const phoneIdentityKey = parsePublicKey(grant.phoneIdentityKey)
    if (typeof grant.displayName !== 'string' || !grant.displayName.isWellFormed()
      || Buffer.byteLength(grant.displayName) > budgets.application.maxTitleBytes
      || typeof grant.pairedAt !== 'number' || !Number.isSafeInteger(grant.pairedAt) || grant.pairedAt < 0
      || ids.has(grantId) || phoneKeys.has(phoneIdentityKey)) throw new Error('companion-host: corrupt device row')
    ids.add(grantId)
    phoneKeys.add(phoneIdentityKey)
    return Object.freeze({ grantId, generation: parseGeneration(grant.generation), phoneIdentityKey,
      displayName: grant.displayName, pairedAt: grant.pairedAt })
  })
  const result: PrivateRecord = Object.freeze({ v: 1, httpsOrigin: origin, pcId, identityPublicKey: publicKey,
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
   * Validate existing storage or create the first identity; malformed existing records never permit regeneration.
   * @returns Initialized validated state.
   */
  async initialize(): Promise<PrivateRecord> {
    const record = await this.credentials.modifyRecord(RECORD_KEY, (current) => {
      if (current !== undefined) { parse(current, this.origin, this.budgets); return Promise.resolve(undefined) }
      const pair = generateP256KeyPair()
      const publicKey = exportPublicKey(pair.publicKey)
      const payload: PrivateRecord = { v: 1, httpsOrigin: this.origin, pcId: derivePcId(publicKey),
        identityPublicKey: publicKey, identityPkcs8: encodeBase64Url(pair.privateKey.export({ format: 'der', type: 'pkcs8' })), grants: [] }
      if (Buffer.byteLength(JSON.stringify(payload)) > this.budgets.maxRecordBytes) throw new Error('companion-host: identity budget')
      return Promise.resolve<CredentialRecord>({ kind: 'grant', payload })
    })
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
   * Replace current grant rows through the provider's cross-process update lock.
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
