/**
 * Host-owned multi-account manager for Harnessy's supported model providers.
 * Credentials stay inside the protected credential store; Remote methods
 * expose only labels, activation state, and provider-supported usage data.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/accounts
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { openNativeUrl } from '@deepseek-ai/dsh-native-command'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AccountAuthMode,
  AccountProviderId,
  AccountProviderView,
  AccountSignInResult,
  AccountsState,
  AccountUsageView,
  AccountUsageWindow,
  ManagedAccountView,
} from './types.ts'

const VAULT_KEY = credentialKey('account-manager', 'accounts')
const PI_AI_SETTINGS = 'llm-pi-ai'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const PROFILE_CLAIM = 'https://api.openai.com/profile'
const AUTH_CLAIM = 'https://api.openai.com/auth'

interface ProviderDefinition {
  readonly id: AccountProviderId
  readonly label: string
  readonly authMode: AccountAuthMode
  readonly usageAvailable: boolean
}

const PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'openai-codex', label: 'Codex', authMode: 'oauth', usageAvailable: true },
  { id: 'zai', label: 'GLM', authMode: 'api-key', usageAvailable: false },
  { id: 'kimi-coding', label: 'Kimi', authMode: 'oauth', usageAvailable: false },
  { id: 'opencode', label: 'OpenCode', authMode: 'api-key', usageAvailable: false },
  { id: 'anthropic', label: 'Claude Code', authMode: 'oauth', usageAvailable: false },
] as const

interface StoredAccount {
  readonly id: string
  readonly provider: AccountProviderId
  readonly authMode: AccountAuthMode
  readonly credential: CredentialRecord
  readonly name: string
  readonly detail?: string
  readonly createdAt: number
  readonly usage?: AccountUsageView
  readonly usageUpdatedAt?: number
  readonly usageError?: string
}

interface ProviderVault {
  readonly activeAccountId?: string
  readonly accounts: Readonly<Record<string, StoredAccount>>
}

interface AccountVault {
  readonly version: 1
  readonly providers: Readonly<Partial<Record<AccountProviderId, ProviderVault>>>
}

/** Replaceable native and network boundaries for tests. */
export interface AccountsControllerInternals {
  readonly openUrl?: (url: string, signal: AbortSignal) => Promise<void>
  readonly fetchUsage?: typeof fetch
  readonly now?: () => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `accounts` Remote namespace. */
    accountsController: AccountsController
  }
}

/**
 * Manage several local identities per provider while keeping one canonical
 * active credential at the existing `llm-pi-ai/<provider>` address.
 */
export class AccountsController extends TypertRemoteService {
  private readonly openUrl: (url: string, signal: AbortSignal) => Promise<void>
  private readonly fetchUsage: typeof fetch
  private readonly now: () => number

  /** @param ctx - Host context carrying authorization, credentials, and settings. */
  constructor(ctx: Context, internals: AccountsControllerInternals = {}) {
    super(ctx, 'accountsController', { namespace: 'accounts' })
    this.openUrl = internals.openUrl ?? openNativeUrl
    this.fetchUsage = internals.fetchUsage ?? fetch
    this.now = internals.now ?? Date.now
  }

  /** Return every managed account without returning its stored credential. */
  @Remote
  async describe(): Promise<AccountsState> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return this.emptyState(false)
    const writable = (await credentials.describeRecord(VAULT_KEY)).writable
    const vault = writable ? await this.importCanonicalAccounts(credentials) : await this.readVault(credentials)
    return this.publicState(vault, writable)
  }

  /**
   * Add an OAuth-backed identity through the provider's installed browser flow.
   * A later account is saved without replacing the currently active identity.
   */
  @Remote
  async addOAuth(provider: AccountProviderId, signal: AbortSignal): Promise<AccountSignInResult> {
    const definition = providerDefinition(provider)
    if (definition.authMode !== 'oauth') throw rejected(provider, 'this provider uses an API key')
    const authorization = this.authorization()
    const credentials = this.credentials()
    const canonicalKey = providerKey(provider)
    const entry = authorization.describe(canonicalKey)
    if (entry === undefined || !entry.methods.some(method => method.id === 'oauth')) {
      throw unavailable(`${definition.label} browser sign-in is not installed`)
    }

    const previous = await credentials.readRecord(canonicalKey)
    let opening = Promise.resolve()
    let openFailure: unknown
    const authorize = async () => authorization.begin({
      key: canonicalKey,
      method: 'oauth',
      signal,
      interaction: {
        notify: (notice) => {
          if (notice.url === undefined) return
          let url: string
          try {
            url = secureUrl(notice.url)
          } catch (error: unknown) {
            openFailure = error
            authorization.cancel(canonicalKey)
            return
          }
          opening = opening.then(() => this.openUrl(url, signal)).catch((error: unknown) => {
            openFailure = error
            authorization.cancel(canonicalKey)
          })
        },
        prompt: prompt => answerDesktopPrompt(prompt, signal),
      },
    })
    let outcome: Awaited<ReturnType<typeof authorize>>
    try {
      outcome = await authorize()
      await opening
    } catch (error: unknown) {
      await opening
      await restoreRecord(credentials, canonicalKey, previous)
      throw error
    }
    if (openFailure !== undefined) {
      await restoreRecord(credentials, canonicalKey, previous)
      throw unavailable(`could not open the ${definition.label} sign-in page`)
    }
    if (outcome.status === 'cancelled') {
      await restoreRecord(credentials, canonicalKey, previous)
      return { status: 'cancelled' }
    }

    const credential = await credentials.readRecord(canonicalKey)
    if (credential === undefined) {
      await restoreRecord(credentials, canonicalKey, previous)
      throw unavailable(`${definition.label} sign-in completed without a stored credential`)
    }
    const account = accountFromCredential(definition, credential, this.now())
    const previousVault = await this.readVault(credentials)
    const providerVault = previousVault.providers[provider]
    const existingActive = providerVault?.activeAccountId
    const activeAccountId = existingActive ?? account.id
    await this.writeVault(credentials, upsertAccount(previousVault, account, activeAccountId))
    if (existingActive !== undefined && existingActive !== account.id) {
      await restoreRecord(credentials, canonicalKey, previous)
    } else {
      await this.activateProviderRoute(provider)
    }
    return { status: 'authorized' }
  }

  /** Add a named API-key identity; only the first account becomes active automatically. */
  @Remote
  async addApiKey(provider: AccountProviderId, name: string, key: string): Promise<AccountsState> {
    const definition = providerDefinition(provider)
    if (definition.authMode !== 'api-key') throw rejected(provider, 'this provider uses browser sign-in')
    const cleanKey = key.trim()
    if (cleanKey.length === 0) throw rejected(provider, 'an API key is required')
    const credentials = this.credentials()
    const vault = await this.importCanonicalAccounts(credentials)
    const account: StoredAccount = {
      id: `acc_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      provider,
      authMode: 'api-key',
      credential: { kind: 'api-key', key: cleanKey },
      name: boundedText(name, 80) ?? `${definition.label} account`,
      createdAt: this.now(),
    }
    const existingActive = vault.providers[provider]?.activeAccountId
    const next = upsertAccount(vault, account, existingActive ?? account.id)
    await this.writeVault(credentials, next)
    if (existingActive === undefined) {
      await writeRecord(credentials, providerKey(provider), account.credential)
      await this.activateProviderRoute(provider)
    }
    return this.publicState(next, true)
  }

  /** Make one saved identity the canonical credential used by model requests. */
  @Remote
  async activate(provider: AccountProviderId, accountId: string): Promise<AccountsState> {
    providerDefinition(provider)
    const credentials = this.credentials()
    const vault = await this.readVault(credentials)
    const account = vault.providers[provider]?.accounts[accountId]
    if (account === undefined) throw notFound(provider, accountId)
    await writeRecord(credentials, providerKey(provider), account.credential)
    await this.activateProviderRoute(provider)
    const next = setActive(vault, provider, accountId)
    await this.writeVault(credentials, next)
    return this.publicState(next, true)
  }

  /** Rename one local account without changing its credential or active state. */
  @Remote
  async rename(provider: AccountProviderId, accountId: string, name: string): Promise<AccountsState> {
    const cleanName = boundedText(name, 80)
    if (cleanName === undefined) throw rejected(provider, 'an account name is required')
    const credentials = this.credentials()
    const vault = await this.readVault(credentials)
    const providerVault = vault.providers[provider]
    const current = providerVault?.accounts[accountId]
    if (providerVault === undefined || current === undefined) throw notFound(provider, accountId)
    const next = replaceProviderVault(vault, provider, {
      ...providerVault,
      accounts: { ...providerVault.accounts, [accountId]: { ...current, name: cleanName } },
    })
    await this.writeVault(credentials, next)
    return this.publicState(next, true)
  }

  /** Remove one saved identity and promote the next identity when it was active. */
  @Remote
  async deleteAccount(provider: AccountProviderId, accountId: string): Promise<AccountsState> {
    const credentials = this.credentials()
    const vault = await this.readVault(credentials)
    const providerVault = vault.providers[provider]
    if (providerVault?.accounts[accountId] === undefined) throw notFound(provider, accountId)
    const accounts: Record<string, StoredAccount> = {}
    for (const [id, account] of Object.entries(providerVault.accounts)) {
      if (id !== accountId) accounts[id] = account
    }
    const replacement = providerVault.activeAccountId === accountId ? Object.values(accounts)[0] : undefined
    const activeAccountId = providerVault.activeAccountId === accountId ? replacement?.id : providerVault.activeAccountId
    const next = replaceProviderVault(vault, provider, { accounts, ...activeAccountId === undefined ? {} : { activeAccountId } })
    await this.writeVault(credentials, next)
    if (providerVault.activeAccountId === accountId) {
      if (replacement === undefined) {
        await credentials.deleteRecord(providerKey(provider))
        await this.deactivateProviderRoute(provider)
      } else {
        await writeRecord(credentials, providerKey(provider), replacement.credential)
      }
    }
    return this.publicState(next, true)
  }

  /** Refresh every supported usage snapshot, intended to run whenever the manager opens. */
  @Remote
  async refreshUsage(signal: AbortSignal): Promise<AccountsState> {
    const credentials = this.credentials()
    let vault = await this.importCanonicalAccounts(credentials)
    const codex = vault.providers['openai-codex']
    if (codex === undefined) return this.publicState(vault, true)
    for (const account of Object.values(codex.accounts)) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'account usage refresh was cancelled', {})
      const refreshed = await this.refreshCodexAccount(account, signal)
      const currentVault = await this.readVault(credentials)
      const currentProvider = currentVault.providers['openai-codex']
      if (currentProvider === undefined) continue
      const current = currentProvider.accounts[account.id]
      if (current === undefined || !sameRecord(current.credential, account.credential)) continue
      vault = replaceProviderVault(currentVault, 'openai-codex', {
        ...currentProvider,
        accounts: { ...currentProvider.accounts, [account.id]: refreshed },
      })
      await this.writeVault(credentials, vault)
      if (currentProvider.activeAccountId === account.id) {
        await writeRecord(credentials, providerKey('openai-codex'), refreshed.credential)
      }
    }
    return this.publicState(vault, true)
  }

  private async refreshCodexAccount(account: StoredAccount, signal: AbortSignal): Promise<StoredAccount> {
    let credential = account.credential
    try {
      let oauth = oauthCredential(credential)
      if (oauth === undefined) throw new Error('the saved account is not an OAuth account')
      if (oauth.expires <= this.now() + 60_000) {
        const refresh = openaiCodexProvider().auth.oauth
        if (refresh === undefined) throw new Error('the Codex OAuth refresher is unavailable')
        oauth = await refresh.refresh(oauth, combinedSignal(signal))
        credential = { kind: 'grant', payload: jsonImage(oauth) }
      }
      const identity = codexIdentity(credential)
      const response = await this.fetchUsage(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${oauth.access}`,
          Accept: 'application/json',
          'User-Agent': 'Harnessy',
          ...identity.accountId === undefined ? {} : { 'chatgpt-account-id': identity.accountId },
        },
        signal: combinedSignal(signal),
      })
      if (!response.ok) throw new Error(`usage request failed (${String(response.status)})`)
      const usage = extractCodexUsage(await response.json(), this.now())
      const { usageError: _previousError, ...accountWithoutError } = account
      return {
        ...accountWithoutError,
        credential,
        usage,
        usageUpdatedAt: this.now(),
        ...usage.windows.length === 0 ? { usageError: 'No usage windows were returned for this account.' } : {},
      }
    } catch (error: unknown) {
      if (signal.aborted) throw error
      const { usage: _previousUsage, usageError: _previousError, ...accountWithoutUsage } = account
      return {
        ...accountWithoutUsage,
        credential,
        usageUpdatedAt: this.now(),
        usageError: oauthCredential(credential) === undefined
          ? 'Sign in again to refresh this account.'
          : 'Usage is temporarily unavailable.',
      }
    }
  }

  private async importCanonicalAccounts(credentials: CredentialProvider): Promise<AccountVault> {
    let vault = await this.readVault(credentials)
    for (const definition of PROVIDERS) {
      const credential = await credentials.readRecord(providerKey(definition.id))
      if (credential === undefined) continue
      const providerVault = vault.providers[definition.id]
      const active = providerVault?.activeAccountId
      if (providerVault !== undefined && active !== undefined && providerVault.accounts[active] !== undefined) {
        const current = providerVault.accounts[active]
        if (!sameRecord(current.credential, credential)) {
          vault = replaceProviderVault(vault, definition.id, {
            ...providerVault,
            accounts: { ...providerVault.accounts, [active]: { ...current, credential } },
          })
        }
        continue
      }
      const account = accountFromCredential(definition, credential, this.now())
      vault = upsertAccount(vault, account, account.id)
    }
    await this.writeVault(credentials, vault)
    return vault
  }

  private publicState(vault: AccountVault, writable: boolean): AccountsState {
    const providers: AccountProviderView[] = PROVIDERS.map((definition) => {
      const providerVault = vault.providers[definition.id]
      const flow = this.ctx.get('authorization')?.describe(providerKey(definition.id))
      return {
        id: definition.id,
        label: definition.label,
        authMode: definition.authMode,
        available: definition.authMode === 'api-key' || flow?.methods.some(method => method.id === 'oauth') === true,
        accountCount: Object.keys(providerVault?.accounts ?? {}).length,
        ...providerVault?.activeAccountId === undefined ? {} : { activeAccountId: providerVault.activeAccountId },
        usageAvailable: definition.usageAvailable,
      }
    })
    const accounts = PROVIDERS.flatMap((definition) => {
      const providerVault = vault.providers[definition.id]
      if (providerVault === undefined) return []
      return Object.values(providerVault.accounts)
        .map(account => publicAccount(account, providerVault.activeAccountId))
        .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name))
    })
    return { writable, providers, accounts }
  }

  private emptyState(writable: boolean): AccountsState {
    return {
      writable,
      providers: PROVIDERS.map(definition => ({
        ...definition,
        available: false,
        accountCount: 0,
      })),
      accounts: [],
    }
  }

  private async readVault(credentials: CredentialProvider): Promise<AccountVault> {
    return parseVault(await credentials.readRecord(VAULT_KEY))
  }

  private async writeVault(credentials: CredentialProvider, vault: AccountVault): Promise<void> {
    await credentials.modifyRecord(VAULT_KEY, () => Promise.resolve({
      kind: 'grant',
      payload: jsonImage(vault),
    }))
  }

  private async activateProviderRoute(provider: AccountProviderId): Promise<void> {
    await this.settings().mutate(PI_AI_SETTINGS, [{ op: 'set', path: ['providers', provider], value: {} }])
  }

  private async deactivateProviderRoute(provider: AccountProviderId): Promise<void> {
    await this.settings().mutate(PI_AI_SETTINGS, [{ op: 'unset', path: ['providers', provider] }])
  }

  private authorization(): AuthorizationService {
    const service = this.ctx.get('authorization')
    if (service === undefined) throw unavailable('authorization service is not mounted')
    return service
  }

  private credentials(): CredentialProvider {
    const service = this.ctx.get('credentials')
    if (service === undefined) throw unavailable('credential storage is not mounted')
    return service
  }

  private settings(): SettingsProvider {
    const service = this.ctx.get('settings')
    if (service === undefined) throw unavailable('settings storage is not mounted')
    return service
  }
}

function providerDefinition(provider: AccountProviderId): ProviderDefinition {
  const definition = PROVIDERS.find(candidate => candidate.id === provider)
  if (definition === undefined) throw unavailable('the requested account provider is not supported')
  return definition
}

function providerKey(provider: AccountProviderId): CredentialKey {
  return credentialKey('llm-pi-ai', provider)
}

function parseVault(record: CredentialRecord | undefined): AccountVault {
  if (record?.kind !== 'grant' || !isRecord(record.payload)) return { version: 1, providers: {} }
  const payload = record.payload
  if (payload.version !== 1 || !isRecord(payload.providers)) return { version: 1, providers: {} }
  return payload as unknown as AccountVault
}

function replaceProviderVault(vault: AccountVault, provider: AccountProviderId, value: ProviderVault): AccountVault {
  return { ...vault, providers: { ...vault.providers, [provider]: value } }
}

function upsertAccount(vault: AccountVault, account: StoredAccount, activeAccountId: string): AccountVault {
  const current = vault.providers[account.provider]
  return replaceProviderVault(vault, account.provider, {
    accounts: { ...current?.accounts, [account.id]: account },
    activeAccountId,
  })
}

function setActive(vault: AccountVault, provider: AccountProviderId, accountId: string): AccountVault {
  const current = vault.providers[provider]
  if (current === undefined) return vault
  return replaceProviderVault(vault, provider, { ...current, activeAccountId: accountId })
}

function accountFromCredential(
  definition: ProviderDefinition,
  credential: CredentialRecord,
  createdAt: number,
): StoredAccount {
  if (definition.id === 'openai-codex') {
    const identity = codexIdentity(credential)
    return {
      id: identity.id,
      provider: definition.id,
      authMode: definition.authMode,
      credential,
      name: identity.name,
      ...identity.detail === undefined ? {} : { detail: identity.detail },
      createdAt,
    }
  }
  const identity = genericOAuthIdentity(credential)
  const stable = identity.stable === undefined ? randomUUID() : `${definition.id}:${identity.stable}`
  return {
    id: `acc_${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`,
    provider: definition.id,
    authMode: definition.authMode,
    credential,
    name: identity.name ?? `${definition.label} account`,
    ...identity.detail === undefined ? {} : { detail: identity.detail },
    createdAt,
  }
}

function publicAccount(account: StoredAccount, activeAccountId: string | undefined): ManagedAccountView {
  return {
    id: account.id,
    provider: account.provider,
    name: account.name,
    ...account.detail === undefined ? {} : { detail: account.detail },
    initials: accountInitials(account.name),
    active: account.id === activeAccountId,
    authMode: account.authMode,
    ...account.usage === undefined ? {} : { usage: account.usage },
    ...account.usageUpdatedAt === undefined ? {} : { usageUpdatedAt: account.usageUpdatedAt },
    ...account.usageError === undefined ? {} : { usageError: account.usageError },
  }
}

function codexIdentity(record: CredentialRecord): {
  readonly id: string
  readonly name: string
  readonly detail?: string
  readonly accountId?: string
} {
  const oauth = oauthCredential(record)
  if (oauth === undefined) {
    return {
      id: `acc_${createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24)}`,
      name: 'Codex account',
    }
  }
  const payload = decodeJwtPayload(oauth.access)
  const profile = objectMember(payload, PROFILE_CLAIM)
  const auth = objectMember(payload, AUTH_CLAIM)
  const email = boundedText(profile.email, 320)
  const accountId = boundedText(oauth.accountId, 256) ?? boundedText(auth.chatgpt_account_id, 256)
  const stable = accountId
    ?? boundedText(auth.chatgpt_user_id, 256)
    ?? email
    ?? boundedText(payload.sub, 256)
    ?? oauth.refresh
  const name = boundedText(profile.name, 160) ?? email?.split('@', 1)[0] ?? 'OpenAI account'
  const plan = boundedText(auth.chatgpt_plan_type, 80)
  const detail = [email, plan].filter(Boolean).join(' · ') || undefined
  return {
    id: `acc_${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`,
    name,
    ...detail === undefined ? {} : { detail },
    ...accountId === undefined ? {} : { accountId },
  }
}

function genericOAuthIdentity(record: CredentialRecord): { readonly stable?: string; readonly name?: string; readonly detail?: string } {
  const oauth = oauthCredential(record)
  if (oauth === undefined) return {}
  const payload = decodeJwtPayload(oauth.access)
  const email = boundedText(payload.email, 320)
  const name = boundedText(payload.name, 160) ?? boundedText(payload.preferred_username, 160)
  const stable = boundedText(payload.sub, 256) ?? email
  return {
    ...stable === undefined ? {} : { stable },
    ...name === undefined ? {} : { name },
    ...email === undefined ? {} : { detail: email },
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (payload === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function oauthCredential(record: CredentialRecord): OAuthCredential | undefined {
  if (record.kind !== 'grant' || !isRecord(record.payload)) return undefined
  const payload = record.payload
  if (payload.type !== 'oauth' || typeof payload.access !== 'string' || typeof payload.refresh !== 'string'
    || typeof payload.expires !== 'number' || !Number.isFinite(payload.expires)) return undefined
  return payload as unknown as OAuthCredential
}

function extractCodexUsage(payload: unknown, nowMs: number): AccountUsageView {
  const root = isRecord(payload) ? payload : {}
  const windows = [
    ...rateLimitWindows(root.rate_limit, '', 'standard', nowMs),
    ...rateLimitWindows(root.code_review_rate_limit, 'Code review', 'code-review', nowMs),
  ]
  return { windows }
}

function rateLimitWindows(
  value: unknown,
  prefix: string,
  idPrefix: string,
  nowMs: number,
): AccountUsageWindow[] {
  const limit = isRecord(value) ? value : {}
  const candidates = [
    ['primary', limit.primary_window],
    ['secondary', limit.secondary_window],
  ] as const
  return candidates.flatMap(([slot, candidate]) => {
    if (!isRecord(candidate)) return []
    const usedPercent = finite(candidate.used_percent)
    const seconds = finite(candidate.limit_window_seconds)
    if (usedPercent === undefined || seconds === undefined || seconds <= 0) return []
    const resetAt = finite(candidate.reset_at)
    const resetAfter = finite(candidate.reset_after_seconds)
    const resetsAtMs = resetAt !== undefined && resetAt > 0
      ? Math.round(resetAt * 1000)
      : resetAfter !== undefined && resetAfter >= 0 ? Math.round(nowMs + resetAfter * 1000) : undefined
    const duration = durationLabel(seconds)
    return [{
      id: `${idPrefix}-${slot}`,
      label: prefix.length > 0 ? `${prefix} · ${duration}` : duration,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      ...resetsAtMs === undefined ? {} : { resetsAtMs },
    }]
  })
}

function durationLabel(seconds: number): string {
  if (seconds >= 17_000 && seconds <= 19_000) return '5h'
  if (seconds >= 600_000 && seconds <= 610_000) return '7d'
  if (seconds > 0 && seconds % 86_400 === 0) return `${String(seconds / 86_400)}d`
  if (seconds > 0 && seconds % 3_600 === 0) return `${String(seconds / 3_600)}h`
  return 'Limit'
}

function accountInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  const initials = words.length > 1 ? `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}` : words[0]?.slice(0, 2)
  return (initials ?? 'AI').toLocaleUpperCase().slice(0, 2)
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  return clean.length > 0 && clean.length <= max ? clean : undefined
}

function objectMember(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  return isRecord(value) ? value : {}
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonImage(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function sameRecord(left: CredentialRecord, right: CredentialRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function writeRecord(credentials: CredentialProvider, key: CredentialKey, record: CredentialRecord): Promise<void> {
  await credentials.modifyRecord(key, () => Promise.resolve(record))
}

async function restoreRecord(
  credentials: CredentialProvider,
  key: CredentialKey,
  record: CredentialRecord | undefined,
): Promise<void> {
  if (record === undefined) await credentials.deleteRecord(key)
  else await writeRecord(credentials, key, record)
}

function answerDesktopPrompt(prompt: AuthorizationPrompt, requestSignal: AbortSignal): Promise<string> {
  if (prompt.kind === 'select') {
    const browser = prompt.options.find(option => option.id === 'browser')
    const choice = browser ?? prompt.options[0]
    if (choice === undefined) throw unavailable('the provider offered no sign-in method')
    return Promise.resolve(choice.id)
  }
  if (requestSignal.aborted || prompt.signal?.aborted === true) {
    return Promise.reject(new Error('the browser sign-in prompt was withdrawn'))
  }
  return new Promise<string>((_resolve, reject) => {
    const withdraw = (): void => {
      requestSignal.removeEventListener('abort', withdraw)
      prompt.signal?.removeEventListener('abort', withdraw)
      reject(new Error('the browser sign-in prompt was withdrawn'))
    }
    requestSignal.addEventListener('abort', withdraw, { once: true })
    prompt.signal?.addEventListener('abort', withdraw, { once: true })
  })
}

function secureUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw unavailable('the provider returned an invalid sign-in URL')
  }
  if (url.protocol !== 'https:') throw unavailable('provider sign-in URLs must use HTTPS')
  return url.href
}

function combinedSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(20_000)])
}

function unavailable(message: string): RemoteError {
  return new RemoteError('accounts/unavailable', message, {})
}

function rejected(provider: AccountProviderId, message: string): RemoteError {
  return new RemoteError('accounts/rejected', message, { provider })
}

function notFound(provider: AccountProviderId, accountId: string): RemoteError {
  return new RemoteError('accounts/not-found', 'the requested account was not found', { provider, accountId })
}

export default AccountsController
