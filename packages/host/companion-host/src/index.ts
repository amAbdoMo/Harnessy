/** PC-owned companion service. Desktop main controls pairing; the relay never supplies application authority. */
import { Context, Service } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  acceptClientHello, encodeApplicationResult, encodePairingInvitation, parseApplicationRequest,
  parseId, verifyClientHello,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ApplicationResult, ChannelId, ClientHello, EncryptedChannel, GrantId, InvitationId,
  PcWelcome, PublicKeySpki, SocketGeneration,
} from '@deepseek-ai/dsh-companion-protocol'
import { Config, resolveConfig } from './config.ts'
import type { HostBudgets } from './config.ts'
import { acquireDesktopOwner } from './desktop-owner.ts'
import { Connector } from './connector.ts'
import type { RelayConnection, RelayInput } from './connector.ts'
import { fingerprint, HostRecords, randomId, RECORD_KEY } from './records.ts'
import type { DeviceRecord } from './records.ts'
import { createApplicationDispatcher } from './application-dispatch.ts'
import type { CandidateId, CompanionControlCommand, CompanionStatus, PairedDevice, PrivateInvitation } from './types.ts'

export { Config, resolveConfig } from './config.ts'
export { installDesktopCompanionOwner } from './desktop-owner.ts'
export type * from './types.ts'

interface Invitation {
  readonly id: InvitationId
  readonly expiresAt: number
  readonly secret: Buffer
  readonly life: AbortController
  readonly timer: ReturnType<typeof setTimeout>
}
interface Candidate {
  readonly id: CandidateId
  readonly invitation: Invitation
  readonly channel: Channel
  readonly fingerprint: string
  readonly welcome: PcWelcome
  readonly grant: DeviceRecord
}
interface Channel {
  readonly id: ChannelId
  readonly connection: RelayConnection
  readonly phoneKey: PublicKeySpki
  readonly phoneGeneration: SocketGeneration
  readonly life: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  readonly work: Set<Promise<void>>
  readonly detach: () => void
  crypto?: EncryptedChannel
  grant?: DeviceRecord
  dispatch?: ReturnType<typeof createApplicationDispatcher>
  hello?: ClientHello
}

declare module '@deepseek-ai/cordis' {
  interface Context { companionHost: CompanionHost }
}

/** No Typert Remote decorations: this API is callable only by trusted same-process native controls. */
export default class CompanionHost extends Service {
  static Config = Config
  static inject = ['credentials', 'sessionController', 'sessionQuery', 'sessions', 'agents']
  private readonly life = new AbortController()
  private readonly resolved: ReturnType<typeof resolveConfig>
  private records: HostRecords | undefined
  private connector: Connector | undefined
  private connection: RelayConnection | undefined
  private invitation: Invitation | undefined
  private approving: Candidate | undefined
  private readonly candidates = new Map<CandidateId, Candidate>()
  private readonly channels = new Map<ChannelId, Channel>()
  private readonly retiring = new Set<Promise<void>>()
  private readonly permissionChanges = new Set<{ readonly grantId: GrantId }>()
  private tail: Promise<void> = Promise.resolve()
  private pendingLocal = 0
  private channelAttempts = 0
  private available = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'companionHost')
    this.resolved = resolveConfig(config)
  }

  async [Service.init](): Promise<void> {
    const resolved = this.resolved
    if (resolved === undefined) return
    await this.ctx.effect(async () => {
      const owner = await acquireDesktopOwner(this.ctx)
      const parentAbort = (): void => { this.withdraw() }
      owner.signal.addEventListener('abort', parentAbort, { once: true })
      try {
        this.ctx.on('credentials/source-failed', () => { this.withdraw() })
        this.ctx.credentials.sourceFailureSignal.throwIfAborted()
        this.records = new HostRecords(this.ctx.credentials, resolved.origin, resolved.budgets)
        const record = await this.records.initialize(this.life.signal)
        if (owner.signal.aborted || this.life.signal.aborted) throw new Error('companion-host: owner retired during startup')
        this.available = true
        this.ctx.on('credentials/record-updated', (key) => {
          if (key !== RECORD_KEY) return
          // Deletion, replacement and generation changes withdraw every old signal in this synchronous callback.
          this.available = false
          this.cancelCurrentInvitation()
          for (const channel of this.channels.values()) {
            // The sole committing candidate has no application authority yet; reload is required before welcome.
            if (channel !== this.approving?.channel || channel.grant !== undefined) this.retire(channel)
          }
          void this.serialize(async () => {
            await this.records?.reload()
            if (!this.life.signal.aborted) this.available = true
          }).catch((_error: unknown) => { this.withdraw() })
        })
        this.connector = new Connector({
          origin: resolved.origin, budgets: resolved.budgets, pcId: record.pcId,
          publicKey: record.identityPublicKey, privateKey: this.records.privateKey(), signal: this.life.signal,
          ready: (connection) => {
            if (this.life.signal.aborted) { connection.stop(); return }
            this.channelAttempts = 0
            this.connection = connection
          },
          input: (connection, frame) => this.input(connection, frame),
          reject: (connection, frame) => { this.rejectInput(connection, frame) },
          lost: async (connection) => {
            if (this.connection === connection) this.connection = undefined
            this.cancelCurrentInvitation()
            for (const channel of this.channels.values()) if (channel.connection === connection) this.retire(channel)
            await Promise.allSettled([...this.retiring])
          },
        })
      } catch (error) {
        this.withdraw()
        owner.signal.removeEventListener('abort', parentAbort)
        await owner.release()
        throw error
      }
      return async () => {
        this.withdraw()
        owner.signal.removeEventListener('abort', parentAbort)
        await this.connector?.dispose()
        await this.tail
        await Promise.allSettled([...this.retiring])
        await owner.release()
        this.records = undefined
      }
    }, 'companion-host.identity-connection-and-channels')
  }

  private budget(): HostBudgets {
    if (this.resolved === undefined) throw new Error('companion-host: actual HTTPS origin is unconfigured')
    return this.resolved.budgets
  }

  private requireAvailable(): HostRecords {
    if (!this.available || this.life.signal.aborted || this.records === undefined) throw new Error('companion-host: unavailable')
    return this.records
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.resolved === undefined) return Promise.reject(new Error('companion-host: unavailable'))
    if (this.pendingLocal >= this.budget().maxPendingMessages) return Promise.reject(new Error('companion-host: management queue limit'))
    this.pendingLocal++
    const pending = this.tail.then(operation)
    this.tail = pending.then(() => { this.pendingLocal-- }, () => { this.pendingLocal-- })
    return pending
  }

  /**
   * Report public management metadata without the one-time invitation secret or private signing key.
   * @returns Fresh native-management status; the renderer receives only availability, connection and count.
   */
  describe(): CompanionStatus {
    const record = this.records?.snapshot()
    const invitation = this.invitation
    return {
      available: this.available && !this.life.signal.aborted,
      connected: this.available && this.connection !== undefined && !this.connection.signal.aborted,
      ...(record === undefined ? {} : { pcId: record.pcId }),
      paired: record?.grants.map(grant => this.publicDevice(grant)) ?? [],
      ...(invitation === undefined || invitation.life.signal.aborted ? {} : {
        invitation: { invitationId: invitation.id, expiresAt: invitation.expiresAt },
      }),
      candidates: [...this.candidates.values()].filter(candidate => !candidate.channel.life.signal.aborted
        && !candidate.invitation.life.signal.aborted && Date.now() < candidate.invitation.expiresAt).map(candidate => ({
        candidateId: candidate.id, fingerprint: candidate.fingerprint, displayName: candidate.grant.displayName,
        expiresAt: candidate.invitation.expiresAt,
      })),
    }
  }

  private publicDevice(grant: DeviceRecord): PairedDevice {
    return { grantId: grant.grantId, generation: grant.generation, fingerprint: fingerprint(grant.phoneIdentityKey),
      displayName: grant.displayName, pairedAt: grant.pairedAt, sessionManagement: grant.sessionManagementV1 === true }
  }

  /**
   * Create one ephemeral invitation; only Desktop main may receive its fragment secret for clipboard use.
   * @returns A one-time harnessy://pair link; no existing PC launch token or durable identity secret.
   */
  createInvitation(): Promise<PrivateInvitation> {
    return this.serialize(() => {
      const record = this.requireAvailable().snapshot()
      if (this.connection === undefined || this.connection.signal.aborted) throw new Error('companion-host: relay offline')
      this.cancelCurrentInvitation()
      const secret = randomBytes(32)
      const id = parseId<InvitationId>(randomId())
      const expiresAt = Date.now() + this.budget().invitationLifetimeMs
      const life = new AbortController()
      const invitation: Invitation = { id, secret, expiresAt, life,
        timer: setTimeout(() => {
          if (this.invitation === invitation) this.cancelCurrentInvitation()
        }, this.budget().invitationLifetimeMs) }
      this.invitation = invitation
      const pairingUrl = encodePairingInvitation({ httpsOrigin: record.httpsOrigin, pcIdentityKey: record.identityPublicKey,
        pcId: record.pcId, invitationId: id, expiresAt, secret })
      return { invitationId: id, expiresAt, pairingUrl }
    })
  }

  /**
   * Abort candidate authority immediately, then remove any grant committed by its in-flight approval.
   * @returns Provider commit and teardown; failures disable this Host incarnation.
   */
  cancelInvitation(): Promise<void> {
    const approving = this.approving
    if (approving !== undefined) this.retire(approving.channel, true)
    this.cancelCurrentInvitation()
    return this.serialize(async () => {
      if (approving !== undefined) {
        const records = this.records
        if (records === undefined) throw new Error('companion-host: cancellation outcome unavailable')
        await records.update(grants => grants.filter(grant => grant.grantId !== approving.grant.grantId))
      }
      await Promise.allSettled([...this.retiring])
    }).catch((error: unknown) => { this.withdraw(); throw error })
  }

  private cancelCurrentInvitation(except?: Channel): void {
    const invitation = this.invitation
    this.invitation = undefined
    if (invitation === undefined) return
    invitation.life.abort()
    clearTimeout(invitation.timer)
    invitation.secret.fill(0)
    for (const [id, candidate] of this.candidates) {
      if (candidate.invitation === invitation) {
        this.candidates.delete(id)
        if (candidate.channel !== except) this.retire(candidate.channel, true)
      }
    }
  }

  /**
   * Enroll exactly the candidate whose locally displayed fingerprint the operator confirmed.
   * @param candidateId - Current main-owned candidate, not a phone or relay-selected grant id.
   * @param confirmFingerprint - Exact SHA-256 hex shown by describe().
   * @returns Committed public device; failed welcome delivery does not undo enrollment or imply a safe retry.
   */
  approveCandidate(candidateId: CandidateId, confirmFingerprint: string): Promise<PairedDevice> {
    return this.serialize(async () => {
      const records = this.requireAvailable()
      const candidate = this.candidates.get(candidateId)
      if (candidate === undefined || candidate.fingerprint !== confirmFingerprint || candidate.invitation !== this.invitation
        || candidate.invitation.life.signal.aborted || candidate.channel.life.signal.aborted
        || Date.now() >= candidate.invitation.expiresAt) throw new Error('companion-host: expired or mismatched candidate')
      const channel = candidate.channel
      // Consume the invitation before storage notification can withdraw candidates. Cancellation during commit stays fail closed.
      this.approving = candidate
      this.candidates.delete(candidateId)
      this.cancelCurrentInvitation(channel)
      try {
        await records.update((grants) => {
          if (channel.life.signal.aborted || Date.now() >= candidate.invitation.expiresAt
            || grants.length >= this.budget().maxGrants
            || grants.some(grant => grant.phoneIdentityKey === candidate.grant.phoneIdentityKey)) {
            throw new Error('companion-host: candidate lost authority or duplicate phone identity')
          }
          return [...grants, candidate.grant]
        })
        // From this synchronous assignment onward every record change also aborts the enrolled candidate.
        channel.grant = candidate.grant
        await records.reload()
        if (channel.life.signal.aborted || Date.now() >= candidate.invitation.expiresAt || this.life.signal.aborted) {
          await records.update(grants => grants.filter(grant => grant.grantId !== candidate.grant.grantId))
          throw new Error('companion-host: enrollment withdrawn before welcome')
        }
        this.available = true
        await this.enroll(channel, candidate.grant, candidate.welcome)
        return this.publicDevice(candidate.grant)
      } catch (error) { this.retire(channel, true); throw error }
      finally { if (this.approving === candidate) this.approving = undefined }
    })
  }

  /**
   * Withdraw the channel authorization capability synchronously, then remove the durable current row.
   * @param grantId - PC-issued current record identifier.
   * @returns Completion after provider commit and affected application teardown; any failure disables this Host incarnation.
   */
  revokeGrant(grantId: GrantId): Promise<void> {
    for (const channel of this.channels.values()) if (channel.grant?.grantId === grantId) this.retire(channel, true)
    return this.serialize(async () => {
      const records = this.requireAvailable()
      await records.update(grants => grants.filter(grant => grant.grantId !== grantId))
      if (!this.life.signal.aborted) this.available = true
      await Promise.allSettled([...this.retiring])
    }).catch((error: unknown) => {
      this.withdraw()
      throw error
    })
  }

  /**
   * Withdraw current channels immediately and commit explicit per-phone chat management consent without re-pairing.
   * @param command - Native-confirmed grant id, generation, fingerprint and permission;
   *   all three identifiers are rechecked under the update lock.
   * @returns Provider commit and channel teardown; any failure disables this Host until explicit recovery.
   */
  setSessionManagement(command: Extract<CompanionControlCommand, { readonly kind: 'setSessionManagement' }>): Promise<void> {
    // A queued handshake must not reacquire authority while this native decision waits for its commit.
    const change = { grantId: command.grantId }
    this.permissionChanges.add(change)
    for (const channel of this.channels.values()) if (channel.grant?.grantId === command.grantId) this.retire(channel, true)
    return this.serialize(async () => {
      const records = this.requireAvailable()
      await records.update((grants) => {
        this.life.signal.throwIfAborted()
        const current = grants.find(grant => grant.grantId === command.grantId)
        if (current === undefined || current.generation !== command.expectedGeneration
          || fingerprint(current.phoneIdentityKey) !== command.fingerprint) {
          throw new Error('companion-host: stale or mismatched phone permission')
        }
        return grants.map((grant) => {
          if (grant !== current) return grant
          const { sessionManagementV1: _permission, ...denied } = grant
          return command.enabled ? { ...denied, sessionManagementV1: true as const } : denied
        })
      })
      if (!this.life.signal.aborted) this.available = true
      await Promise.allSettled([...this.retiring])
    }).catch((error: unknown) => { this.withdraw(); throw error })
      .finally(() => { this.permissionChanges.delete(change) })
  }

  private rejectInput(connection: RelayConnection, frame: RelayInput): void {
    if (connection !== this.connection || connection.signal.aborted || this.life.signal.aborted) return
    const channel = this.channels.get(frame.channelId)
    if (channel !== undefined && channel.connection === connection && channel.phoneGeneration === frame.phoneGeneration) {
      this.retire(channel, frame.type !== 'close')
    } else if (frame.type === 'open') {
      void connection.closeChannel(frame.channelId, frame.phoneGeneration).catch((_error: unknown) => {
        // A saturated writer may drop this notification; the rejected phone has no application authority.
      })
    }
  }

  private async input(connection: RelayConnection, frame: RelayInput): Promise<void> {
    if (connection !== this.connection || connection.signal.aborted || this.life.signal.aborted) return
    if (frame.type === 'open') {
      this.requireAvailable()
      if (this.channels.has(frame.channelId) || this.channels.size >= this.budget().maxChannels
        || this.channelAttempts >= this.budget().maxChannelAttempts) {
        await connection.closeChannel(frame.channelId, frame.phoneGeneration).catch((_error: unknown) => {
          // Rejected channels gain no application authority; close notification is best effort.
        })
        return
      }
      this.channelAttempts++
      const life = new AbortController()
      const abort = (): void => { this.retire(channel) }
      const channel: Channel = { id: frame.channelId, connection, phoneKey: frame.phoneKey, phoneGeneration: frame.phoneGeneration,
        life, work: new Set(), timer: setTimeout(() => { this.retire(channel, true) }, this.budget().handshakeTimeoutMs),
        detach: () => { connection.signal.removeEventListener('abort', abort) } }
      connection.signal.addEventListener('abort', abort, { once: true })
      this.channels.set(channel.id, channel)
      return
    }
    const channel = this.channels.get(frame.channelId)
    // Retired phone frames may arrive after local teardown; never target a successor incarnation.
    if (channel === undefined || channel.connection !== connection || channel.phoneGeneration !== frame.phoneGeneration) return
    if (frame.type === 'close') { this.retire(channel); return }
    if (frame.phoneKey !== channel.phoneKey || channel.life.signal.aborted) { this.retire(channel, true); return }
    try {
      if (channel.crypto === undefined) {
        await this.serialize(() => this.hello(channel, frame.payload))
        return
      }
      if (channel.grant === undefined || channel.work.size >= this.budget().maxPendingMessages) throw new Error('companion-host: channel not authorized')
      this.requireCurrent(channel)
      const pending = this.receive(channel, frame.payload)
      channel.work.add(pending)
      try { await pending } finally { channel.work.delete(pending) }
    } catch (_error) { this.retire(channel, true) }
  }

  private async hello(channel: Channel, wire: unknown): Promise<void> {
    const records = this.requireAvailable()
    channel.life.signal.throwIfAborted()
    if (channel.crypto !== undefined || channel.hello !== undefined) throw new Error('companion-host: repeated hello')
    const record = records.snapshot()
    const hello = verifyClientHello({ wire, pcIdentityKey: record.identityPublicKey, httpsOrigin: record.httpsOrigin })
    if (hello.channelId !== channel.id || hello.phoneIdentityKey !== channel.phoneKey) throw new Error('companion-host: signed phone route mismatch')
    channel.hello = hello
    const authorization = hello.authorization
    if (authorization.kind === 'grant') {
      const grant = record.grants.find(row => row.grantId === authorization.grantId)
      if (grant === undefined || grant.generation !== authorization.generation || grant.phoneIdentityKey !== hello.phoneIdentityKey) {
        throw new Error('companion-host: current grant required')
      }
      const accepted = acceptClientHello({ channelBudget: this.budget().channel,
        hello, identityPrivateKey: records.privateKey(), httpsOrigin: record.httpsOrigin,
        authorization: { kind: 'grant', phoneIdentityKey: grant.phoneIdentityKey, grantId: grant.grantId, generation: grant.generation } })
      channel.crypto = accepted.channel
      await this.enroll(channel, grant, accepted.welcome)
      return
    }
    const invitation = this.invitation
    if (invitation === undefined || invitation.id !== authorization.invitationId || invitation.life.signal.aborted
      || Date.now() >= invitation.expiresAt || this.candidates.size >= this.budget().maxCandidates) throw new Error('companion-host: invitation unavailable')
    const grant: DeviceRecord = { grantId: parseId<GrantId>(randomId()), generation: 1,
      phoneIdentityKey: hello.phoneIdentityKey, displayName: '', pairedAt: Date.now() }
    const accepted = acceptClientHello({ channelBudget: this.budget().channel,
      hello, identityPrivateKey: records.privateKey(), httpsOrigin: record.httpsOrigin,
      authorization: { kind: 'invitation', phoneIdentityKey: grant.phoneIdentityKey, grantId: grant.grantId, generation: grant.generation,
        invitationId: invitation.id, pairingSecret: invitation.secret } })
    channel.crypto = accepted.channel
    const id = parseId<CandidateId>(randomId())
    this.candidates.set(id, { id, invitation, channel, fingerprint: fingerprint(grant.phoneIdentityKey), welcome: accepted.welcome, grant })
  }

  private async enroll(channel: Channel, grant: DeviceRecord, welcome: PcWelcome): Promise<void> {
    if ([...this.channels.values()].some(other => other !== channel && !other.life.signal.aborted
      && other.grant?.grantId === grant.grantId)) throw new Error('companion-host: grant already has an active channel')
    channel.grant = grant
    this.requireCurrent(channel)
    const crypto = channel.crypto
    if (crypto === undefined) throw new Error('companion-host: handshake missing')
    channel.dispatch = createApplicationDispatcher(this.ctx, {
      signal: channel.life.signal, requireCurrent: () => { this.requireCurrent(channel) }, grantId: grant.grantId,
      managementAccess: () => {
        this.requireCurrent(channel)
        return this.requireAvailable().snapshot().grants.some(row => row.grantId === grant.grantId
          && row.generation === grant.generation && row.phoneIdentityKey === channel.phoneKey && row.sessionManagementV1 === true)
      },
      generation: grant.generation, budget: this.budget().application, maxWatches: this.budget().application.maxSubscriptionsPerGrant,
      maxPendingRequests: this.budget().maxPendingMessages, maxProgressBuffer: this.budget().maxProgressBuffer,
      sendProgress: result => this.sendResult(channel, result),
    })
    await channel.connection.send(channel.id, channel.phoneGeneration, welcome, channel.life.signal)
    this.requireCurrent(channel)
    await crypto.sendConfirmation((frame, signal) => channel.connection.send(channel.id, channel.phoneGeneration, frame, signal))
  }

  private requireCurrent(channel: Channel): void {
    channel.life.signal.throwIfAborted()
    const records = this.requireAvailable()
    const grant = channel.grant
    if (grant === undefined || channel.connection !== this.connection || channel.connection.signal.aborted
      || [...this.permissionChanges].some(change => change.grantId === grant.grantId)
      || !records.snapshot().grants.some(row => row.grantId === grant.grantId && row.generation === grant.generation
        && row.phoneIdentityKey === channel.phoneKey)) throw new Error('companion-host: grant generation withdrawn')
  }

  private async receive(channel: Channel, wire: unknown): Promise<void> {
    const crypto = channel.crypto
    const dispatcher = channel.dispatch
    if (crypto === undefined || dispatcher === undefined) throw new Error('companion-host: no application authority')
    const received = await crypto.receive(wire)
    this.requireCurrent(channel)
    if (received.kind === 'confirmation') { if (crypto.confirmed) clearTimeout(channel.timer); return }
    const request = parseApplicationRequest(new TextDecoder('utf-8', { fatal: true }).decode(received.plaintext), this.budget().application)
    const result = await dispatcher.dispatch(request)
    this.requireCurrent(channel)
    await this.sendResult(channel, result)
  }

  private async sendResult(channel: Channel, result: ApplicationResult): Promise<void> {
    this.requireCurrent(channel)
    const crypto = channel.crypto
    if (crypto === undefined) throw new Error('companion-host: closed channel')
    const text = encodeApplicationResult(result, this.budget().application)
    await crypto.sendApplication(Buffer.from(text, 'utf8'), (frame, signal) => {
      this.requireCurrent(channel)
      return channel.connection.send(channel.id, channel.phoneGeneration, frame, signal)
    })
  }

  private retire(channel: Channel, notify = false): void {
    if (channel.life.signal.aborted) return
    // This is the authorization commit: final inbox admission observes this exact signal immediately.
    channel.life.abort()
    clearTimeout(channel.timer)
    channel.detach()
    channel.crypto?.close()
    for (const [id, candidate] of this.candidates) if (candidate.channel === channel) this.candidates.delete(id)
    const closing = (async () => {
      if (notify && !channel.connection.signal.aborted) {
        await channel.connection.closeChannel(channel.id, channel.phoneGeneration).catch((_error: unknown) => {
          // Channel authority is already withdrawn; failed notification cannot retire unrelated phones.
        })
      }
      await channel.dispatch?.close()
      await Promise.allSettled([...channel.work])
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    })()
    this.retiring.add(closing)
    void closing.then(() => this.retiring.delete(closing), (_error: unknown) => { this.retiring.delete(closing); this.withdraw() })
  }

  private withdraw(): void {
    this.available = false
    this.life.abort()
    this.cancelCurrentInvitation()
    for (const channel of this.channels.values()) this.retire(channel)
  }
}
