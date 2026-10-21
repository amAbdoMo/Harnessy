/** Desktop-local consent gates identity creation and relay contact; it never authorizes a phone. */
import type { Context } from '@deepseek-ai/cordis'
import CompanionHost, { resolveConfig } from '@deepseek-ai/dsh-companion-host'
import type { Config, CompanionControlResult } from '@deepseek-ai/dsh-companion-host'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'

const CONSENT_KEY = credentialKey('companion-host', 'desktop-consent')

function consentOrigin(record: CredentialRecord): string {
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('Desktop companion consent is invalid; existing identity was not reset')
  }
  const payload = record.payload
  if (Object.keys(payload).length !== 2 || !('v' in payload) || payload.v !== 1 ||
    !('httpsOrigin' in payload) || typeof payload.httpsOrigin !== 'string') {
    throw new Error('Desktop companion consent is invalid; existing identity was not reset')
  }
  return payload.httpsOrigin
}

/** One Host incarnation owns its startup/activation promise and never retries a failed identity source. */
export class DesktopCompanionActivation {
  private readonly deployment: ReturnType<typeof resolveConfig>
  private activation: Promise<void> | undefined

  /**
   * @param ctx - Desktop-owned context.
   * @param config - Fully validated product/override deployment.
   * @param life - Companion-only lifetime; consent withdrawal retires its authority synchronously.
   */
  constructor(private readonly ctx: Context, private readonly config: Config, private readonly life: AbortController) {
    this.deployment = resolveConfig(config)
  }

  /** Restore only healthy, origin-bound consent; no consent means no identity, owner lock or socket acquisition. */
  async initialize(): Promise<void> {
    if (this.deployment === undefined) return
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    const consent = await this.ctx.credentials.readRecord(CONSENT_KEY)
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    if (consent === undefined) return
    this.assertConsent(consent)
    this.activation = this.mount()
    await this.activation
  }

  /** @returns Private setup state or real service status; neither carries consent payloads or provider credentials. */
  describe(): CompanionControlResult {
    if (this.deployment !== undefined && this.activation === undefined) return { kind: 'activationRequired' }
    const host = this.ctx.get('companionHost')
    return { kind: 'status', status: host?.describe() ?? {
      available: false, connected: false, paired: [], candidates: [],
    } }
  }

  /** Commit explicit native consent before mounting; repeated requests join the same attempt, including its failure. */
  async activate(): Promise<void> {
    if (this.deployment === undefined) throw new Error('Desktop companion deployment is disabled')
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    this.activation ??= this.commitAndMount()
    await this.activation
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
  }

  private assertConsent(record: CredentialRecord): void {
    if (consentOrigin(record) !== this.deployment?.origin) {
      throw new Error('Desktop companion consent origin changed; existing identity was not reset')
    }
  }

  private async commitAndMount(): Promise<void> {
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    const origin = this.deployment?.origin
    if (origin === undefined) throw new Error('Desktop companion deployment is disabled')
    await this.ctx.credentials.modifyRecord(CONSENT_KEY, (existing) => {
      this.life.signal.throwIfAborted()
      this.ctx.credentials.sourceFailureSignal.throwIfAborted()
      if (existing !== undefined) this.assertConsent(existing)
      return Promise.resolve<CredentialRecord>({ kind: 'grant', payload: { v: 1, httpsOrigin: origin } })
    })
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    await this.mount()
  }

  private async mount(): Promise<void> {
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    this.ctx.on('credentials/record-updated', (key) => {
      if (key === CONSENT_KEY) this.life.abort(new Error('Desktop companion consent changed'))
    })
    this.ctx.on('internal/service', (name) => {
      if (name === 'credentials') this.life.abort(new Error('Desktop companion credential owner changed'))
    }, { prepend: true })
    const consent = await this.ctx.credentials.readRecord(CONSENT_KEY)
    this.life.signal.throwIfAborted()
    this.ctx.credentials.sourceFailureSignal.throwIfAborted()
    if (consent === undefined) throw new Error('Desktop companion consent was withdrawn')
    this.assertConsent(consent)
    const mounted = this.ctx.plugin(CompanionHost, this.config)
    try {
      await mounted.await()
      this.life.signal.throwIfAborted()
    } catch (error) {
      this.life.abort(error)
      try { await mounted.dispose() }
      catch (disposalError) { throw new AggregateError([error, disposalError], 'Desktop companion activation and disposal failed') }
      throw error
    }
  }
}
