/** Main-owned website/account metadata and revocable permission to observe a logged-in page. */
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  DesktopWebsiteControl, DesktopWebsiteHostProfile, DesktopWebsiteProfile, DesktopWebsiteProfileId, DesktopWebsiteProfileInput,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Current MCP endpoint binding; authentication values are never returned to the shell. */
export interface DesktopWebsiteMcpBinding {
  readonly identity: string
  readonly endpoint: string
}

/** Trusted Host inspection and the human's native endpoint/site/account approval. */
export interface DesktopWebsitePairing {
  /** @param serverName - configured namespace. @returns current endpoint/project identity, without authentication values. */
  inspect(serverName: string): Promise<DesktopWebsiteMcpBinding>
  /** @param input - canonical human-entered pairing. @param binding - trusted configured endpoint. */
  confirm(input: DesktopWebsiteProfileInput, binding: DesktopWebsiteMcpBinding): Promise<void>
  /** @param inventory - complete approved inventory before a newly saved account is published or acquired. */
  enroll(inventory: readonly DesktopWebsiteHostProfile[]): Promise<void>
}

/** Saved non-secret account identities used for request admission and cleanup. */
export interface DesktopWebsiteAccount extends Pick<DesktopWebsiteProfileInput, 'url' | 'mcpServerName'> {
  readonly profile: DesktopWebsiteProfileId
  readonly mcpBinding: DesktopWebsiteMcpBinding
}

/** @param account - saved website and MCP pairing. @returns conservative shared-account identities for admission and revocation. */
export function websiteAccountKeys(account: Omit<DesktopWebsiteAccount, 'profile'>): readonly string[] {
  return [...new Set([`origin:${new URL(account.url).origin}`, `namespace:${account.mcpServerName}`,
    `binding:${account.mcpBinding.identity}`, `endpoint:${account.mcpBinding.endpoint}`])]
}

interface StoredProfile extends DesktopWebsiteProfileInput {
  readonly id: DesktopWebsiteProfileId
  readonly loginConfirmed: boolean
  readonly cleanupPending: boolean
  readonly mcpBinding: DesktopWebsiteMcpBinding
}

interface ProfileControl {
  control: DesktopWebsiteControl
  epoch: number
}

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const INPUT_KEYS = ['name', 'accountLabel', 'url', 'mcpServerName']
const STORED_KEYS = [...INPUT_KEYS, 'id', 'loginConfirmed', 'cleanupPending', 'mcpBinding']
const MAX_PROFILES = 64
const MAX_FILE_BYTES = 256 * 1024

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))) {
    throw new Error('Website profile contains unsupported fields')
  }
  return input as Record<string, unknown>
}

function label(input: unknown, name: string, required: boolean): string {
  if (typeof input !== 'string' || input.length > 120 || /[\x00-\x1f\x7f]/.test(input)) {
    throw new Error(`Website profile ${name} must be a short label`)
  }
  const trimmed = input.trim()
  if (required && trimmed.length === 0) throw new Error(`Website profile ${name} is required`)
  return trimmed
}

function pairingFields(input: Record<string, unknown>): DesktopWebsiteProfileInput {
  const name = label(input.name, 'name', true)
  const accountLabel = label(input.accountLabel, 'account label', false)
  if (typeof input.mcpServerName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(input.mcpServerName)) {
    throw new Error('Website profile requires an existing MCP server name')
  }
  if (typeof input.url !== 'string' || input.url.length > 2048 || !URL.canParse(input.url)) {
    throw new Error('Website profile requires an HTTP(S) website address')
  }
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Website profile address cannot contain credentials, query parameters or fragments')
  }
  return { name, accountLabel, url: url.href, mcpServerName: input.mcpServerName }
}

/** @param input - untrusted IPC or file identity. @returns a validated main-issued profile ID. */
export function parseWebsiteProfileId(input: unknown): DesktopWebsiteProfileId {
  if (typeof input !== 'string' || !PROFILE_ID.test(input)) throw new Error('Website profile identity is invalid')
  return input as DesktopWebsiteProfileId
}

function storedProfile(input: unknown): StoredProfile {
  const fields = record(input, STORED_KEYS)
  if (typeof fields.loginConfirmed !== 'boolean') throw new Error('Website profile login confirmation is invalid')
  if (typeof fields.cleanupPending !== 'boolean') throw new Error('Website profile cleanup state is invalid')
  const binding = record(fields.mcpBinding, ['identity', 'endpoint'])
  if (typeof binding.identity !== 'string' || !/^[0-9a-f]{64}$/.test(binding.identity)
    || typeof binding.endpoint !== 'string' || binding.endpoint.length === 0 || binding.endpoint.length > 2048
    || /[\x00-\x1f\x7f]/.test(binding.endpoint)) throw new Error('Website MCP endpoint binding is invalid')
  return { ...pairingFields(fields), id: parseWebsiteProfileId(fields.id),
    loginConfirmed: fields.loginConfirmed, cleanupPending: fields.cleanupPending,
    mcpBinding: { identity: binding.identity, endpoint: binding.endpoint } }
}

function storedProfiles(text: string): StoredProfile[] {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Website profile file exceeds its size limit')
  const document = record(JSON.parse(text), ['version', 'profiles'])
  if (document.version !== 1 || !Array.isArray(document.profiles) || document.profiles.length > MAX_PROFILES) {
    throw new Error('Website profile file has an unsupported version or profile list')
  }
  const profiles = document.profiles.map(storedProfile)
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Website profile identities are duplicated')
  return profiles
}

/** Persists associations, not passwords or cookies; Electron owns each profile's authentication storage. */
export class DesktopWebsiteProfiles {
  private profiles: readonly StoredProfile[] = []
  private loading: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly controls = new Map<DesktopWebsiteProfileId, ProfileControl>()
  private readonly listeners = new Set<() => void>()

  /**
   * @param filename - metadata file.
   * @param clearStorage - closes profile guests and awaits authentication/storage cleanup.
   * @param pairing - configured MCP inspection and human confirmation.
   * @param drainAccount - synchronously revokes intersecting native/Host requests and joins their physical work, without retiring owners.
   */
  constructor(
    private readonly filename: string,
    private readonly clearStorage: (id: DesktopWebsiteProfileId) => Promise<void>,
    private readonly pairing: DesktopWebsitePairing,
    private readonly drainAccount: (account: DesktopWebsiteAccount) => Promise<void>,
  ) {}

  /** @returns saved associations and control state; malformed, future or unreadable files reject without replacement. */
  async list(): Promise<readonly DesktopWebsiteProfile[]> {
    await this.load()
    return this.profiles.map(profile => this.view(profile))
  }

  /** @returns the complete non-secret pairing inventory for this captured Host; no website permission is restored. */
  async hostInventory(): Promise<readonly DesktopWebsiteHostProfile[]> {
    await this.load()
    return this.profiles.map(profile => this.hostProfile(profile))
  }

  private hostProfile(profile: StoredProfile): DesktopWebsiteHostProfile {
    return { id: profile.id, name: profile.name, accountLabel: profile.accountLabel, url: profile.url,
      serverName: profile.mcpServerName, mcpBinding: { ...profile.mcpBinding } }
  }

  /** @param id - loaded association. @returns saved non-secret endpoint binding; it is not proof of current MCP connectivity. */
  binding(id: DesktopWebsiteProfileId): DesktopWebsiteMcpBinding {
    return { ...this.requireProfile(id).mcpBinding }
  }

  /** @param input - untrusted user pairing. @returns profile after its first atomic save, in human mode. */
  create(input: unknown): Promise<DesktopWebsiteProfile> {
    const fields = pairingFields(record(input, INPUT_KEYS))
    return this.serial(async () => {
      await this.load()
      if (this.profiles.length >= MAX_PROFILES) throw new Error('Website profile limit reached')
      const mcpBinding = await this.pairing.inspect(fields.mcpServerName)
      await this.pairing.confirm(fields, mcpBinding)
      const profile: StoredProfile = { ...fields, id: randomUUID() as DesktopWebsiteProfileId,
        loginConfirmed: false, cleanupPending: false, mcpBinding }
      await this.verifyPairing(profile)
      await this.pairing.enroll([...this.profiles, profile].map(pairing => this.hostProfile(pairing)))
      await this.save([...this.profiles, profile])
      this.controls.set(profile.id, { control: 'human', epoch: 0 })
      this.notify()
      return this.view(profile)
    })
  }

  /** @param input - approved identity. @returns current association; missing or clearing profiles reject. */
  async acquire(input: unknown): Promise<DesktopWebsiteProfile> {
    await this.load()
    const id = parseWebsiteProfileId(input)
    await this.verifyPairing(this.requireProfile(id))
    return this.assertAvailable(id)
  }

  /**
   * Check current usability immediately before allocating a guest, without an asynchronous gap.
   * @param id - loaded profile identity.
   * @returns current association; cleanup, removal or previous cleanup failure rejects.
   */
  assertAvailable(id: DesktopWebsiteProfileId): DesktopWebsiteProfile {
    const profile = this.requireProfile(id)
    this.requireEditable(id)
    return this.view(profile)
  }

  /** @param input - account identity. @param requested - user's takeover or explicit login-complete action. */
  async setControl(input: unknown, requested: unknown): Promise<void> {
    if (requested !== 'human' && requested !== 'agent') throw new Error('Website control must be human or agent')
    await this.load()
    const id = parseWebsiteProfileId(input)
    this.requireProfile(id)
    const state = this.requireEditable(id)
    state.epoch++
    state.control = 'human'
    this.notify()
    if (requested === 'human') return
    const epoch = state.epoch
    await this.serial(async () => {
      this.requireEditable(id)
      await this.verifyPairing(this.requireProfile(id))
      if (state.epoch !== epoch) return
      await this.save(this.profiles.map(profile => profile.id === id ? { ...profile, loginConfirmed: true } : profile))
      // A human takeover or cleanup while the save was pending cannot be undone by its completion.
      if (state.epoch === epoch) { state.control = 'agent'; this.notify() }
    })
  }

  /** @param input - account to retain after all guests/authentication/storage are cleared. */
  signOut(input: unknown): Promise<void> { return this.clear(input, 'retain') }

  /** @param input - account removed only after storage cleanup succeeds; failed cleanup remains visible and blocked. */
  forget(input: unknown): Promise<void> { return this.clear(input, 'forget') }

  /**
   * Require agent permission at execution and again before returning an asynchronous observation.
   * @param id - prepared profile identity.
   * @param epoch - captured permission generation, when checking a completed operation.
   * @returns current generation; human takeover, cleanup or removal throws.
   */
  assertAgent(id: DesktopWebsiteProfileId, epoch?: number): number {
    this.requireProfile(id)
    const state = this.requireControl(id)
    if (state.control !== 'agent' || (epoch !== undefined && state.epoch !== epoch)) {
      throw new Error('Website observation is paused; wait for the user to resume control')
    }
    this.requireEditable(id)
    return state.epoch
  }

  /** @param listener - committed state invalidation. @returns unsubscribe callback. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async clear(input: unknown, disposition: 'retain' | 'forget'): Promise<void> {
    const id = parseWebsiteProfileId(input)
    // An admitted account is already loaded; fence it in this turn, before queued saves or notifications.
    if (!this.controls.has(id)) await this.load()
    const profile = this.requireProfile(id)
    const state = this.requireControl(id)
    if (state.control === 'clearing') throw new Error('Website profile cleanup is already in progress')
    state.epoch++
    state.control = 'clearing'
    let draining: Promise<void>
    try {
      draining = this.drainAccount({ profile: id, url: profile.url, mcpServerName: profile.mcpServerName,
        mcpBinding: profile.mcpBinding })
    } catch (error) {
      draining = Promise.reject(error instanceof Error ? error : new Error('Website account revocation failed', { cause: error }))
    }
    void draining.catch((_error: unknown) => { /* The queued cleanup joins drainage even if persistence fails. */ })
    this.notify()
    try {
      await this.serial(async () => {
        // Persist the cleanup fence before deleting authentication; persistence failure still joins physical work.
        const outcomes = await Promise.allSettled([draining, this.save(this.profiles.map(candidate =>
          candidate.id === id ? { ...candidate, loginConfirmed: false, cleanupPending: true } : candidate))])
        const failures = outcomes.filter(outcome => outcome.status === 'rejected').map((outcome): unknown => outcome.reason)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Website account cleanup failed')
        await this.clearStorage(id)
        if (disposition === 'forget') {
          await this.save(this.profiles.filter(profile => profile.id !== id))
          this.controls.delete(id)
        } else {
          await this.save(this.profiles.map(profile => profile.id === id ? { ...profile, cleanupPending: false } : profile))
          state.control = 'human'
        }
        this.notify()
      })
    } catch (error) {
      state.control = 'cleanup-failed'
      this.notify()
      throw error
    }
  }

  private load(): Promise<void> {
    return this.loading ??= (async () => {
      let text: string
      try {
        const file = await open(this.filename, 'r')
        try {
          const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, null)
            if (read.bytesRead === 0) break
            length += read.bytesRead
          }
          if (length > MAX_FILE_BYTES) throw new Error('Website profile file exceeds its size limit')
          text = bytes.subarray(0, length).toString('utf8')
        } finally { await file.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const profiles = storedProfiles(text)
      this.profiles = profiles
      // Remembered authentication never restores observation permission after a process restart.
      for (const profile of profiles) this.controls.set(profile.id, { control: profile.cleanupPending ? 'cleanup-failed' : 'human', epoch: 0 })
    })()
  }

  private requireProfile(id: DesktopWebsiteProfileId): StoredProfile {
    const profile = this.profiles.find(candidate => candidate.id === id)
    if (profile === undefined) throw new Error('Website profile is unavailable')
    return profile
  }

  private requireControl(id: DesktopWebsiteProfileId): ProfileControl {
    const state = this.controls.get(id)
    if (state === undefined) throw new Error('Website profile control is unavailable')
    return state
  }

  private requireEditable(id: DesktopWebsiteProfileId): ProfileControl {
    const state = this.requireControl(id)
    const keys = new Set(websiteAccountKeys(this.requireProfile(id)))
    if (this.profiles.some((profile) => {
      const control = this.requireControl(profile.id).control
      return (control === 'clearing' || control === 'cleanup-failed')
        && websiteAccountKeys(profile).some(key => keys.has(key))
    })) throw new Error('Website profile data must be cleared successfully before it can be used')
    return state
  }

  private async verifyPairing(profile: StoredProfile): Promise<void> {
    const current = await this.pairing.inspect(profile.mcpServerName)
    if (current.identity !== profile.mcpBinding.identity) {
      throw new Error('Website MCP endpoint or project changed; clear and pair the account again')
    }
  }

  private view(profile: StoredProfile): DesktopWebsiteProfile {
    const { loginConfirmed: _loginConfirmed, cleanupPending: _cleanupPending, mcpBinding: _mcpBinding, ...fields } = profile
    return { ...fields, control: this.requireControl(profile.id).control }
  }

  private async save(profiles: readonly StoredProfile[]): Promise<void> {
    const text = `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('Website profile file exceeds its size limit')
    await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 })
    this.profiles = profiles
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(() => {}, () => {})
    return pending
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() }
      catch (error) { console.error('Website profile listener failed', error) }
    }
  }
}
