/**
 * Host-owned multi-account manager for Harnessy's supported model providers.
 * Credentials stay inside the protected credential store; Remote methods
 * expose only labels, activation state, provider-supported usage, and manual billing reminders.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/accounts
 */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { openNativeUrl } from '@deepseek-ai/dsh-native-command'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AccountAuthMode,
  AccountAutoSwitchEvent,
  AccountProviderId,
  AccountProviderView,
  AccountResetCreditId,
  AccountResetCreditList,
  AccountResetCreditView,
  AccountResetCreditOutcome,
  AccountResetCreditResult,
  AccountResetCreditsView,
  AccountSignInResult,
  AccountsState,
  AccountUsageScope,
  AccountUsageView,
  AccountUsageWindow,
  ManagedAccountView,
} from './types.ts'

const VAULT_KEY = credentialKey('account-manager', 'accounts')
const PI_AI_SETTINGS = 'llm-pi-ai'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CONSUME_RESET_CREDIT_URL = `${RESET_CREDITS_URL}/consume`
const PROFILE_CLAIM = 'https://api.openai.com/profile'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const CODEX_AUTO_SWITCH_THRESHOLD = 95

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
  readonly manualBillingDate?: string
}

interface ProviderVault {
  readonly activeAccountId?: string
  readonly autoSwitchOnLimit?: boolean
  readonly accounts: Readonly<Record<string, StoredAccount>>
}

interface AccountVault {
  readonly version: 1
  readonly providers: Readonly<Partial<Record<AccountProviderId, ProviderVault>>>
}

function assertUsageRefreshActive(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'account usage refresh was cancelled', {})
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
  private usageRefreshTail: Promise<void> = Promise.resolve()
  private readonly usageLifecycle = new AbortController()
  private backgroundUsage: Promise<void> | undefined
  private usageRequested = false
  private readonly selectionRevisions = new Map<AccountProviderId, number>()
  private readonly quotaRecoveryAttempts = new WeakMap<object, { readonly turn: number; readonly step: number }>()
  private readonly requestSelections = new WeakMap<object, {
    readonly turn: number
    readonly step: number
    readonly id?: string
    readonly revision: number
  }>()

  /** @param ctx - Host context carrying authorization, credentials, and settings. */
  constructor(ctx: Context, internals: AccountsControllerInternals = {}) {
    super(ctx, 'accountsController', { namespace: 'accounts' })
    this.openUrl = internals.openUrl ?? openNativeUrl
    this.fetchUsage = internals.fetchUsage ?? fetch
    this.now = internals.now ?? Date.now
    ctx.effect(() => async () => {
      this.usageLifecycle.abort()
      await this.backgroundUsage
    }, 'accounts: post-request usage lifecycle')
    ctx.on('llm/stream', (options, next) => {
      const stream = next()
      if (options.provider !== 'openai-codex') return stream
      const refreshAfterRequest = () => { this.refreshAfterRequest() }
      return (async function* () {
        try {
          yield* stream
        } finally {
          refreshAfterRequest()
        }
      })()
    })
    ctx.inject(['credentials', 'settings'], (providerContext) => {
      let active = true
      providerContext.effect(() => () => { active = false }, 'accounts.reconcileProviderRoutes()')
      void providerContext.settings.whenInitialImportSettles().then(async () => {
        if (active) await this.reconcileProviderRoutes(providerContext.credentials, providerContext.settings)
      }).catch((error: unknown) => { ctx.logger.error(error) })
    })
    ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
      const config = await next()
      if (config.provider === 'openai-codex') {
        await this.prepareCodexAccount(signal)
        const credentials = this.ctx.get('credentials')
        if (credentials !== undefined) {
          const provider = (await this.readVault(credentials)).providers['openai-codex']
          this.requestSelections.set(agent, {
            turn, step, revision: this.selectionRevisions.get('openai-codex') ?? 0,
            ...provider?.activeAccountId === undefined ? {} : { id: provider.activeAccountId },
          })
        }
      }
      return config
    })
    ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
      if (provider !== 'openai-codex' || failure.code !== QUOTA_EXCEEDED_CODE) return next()
      if (!await this.codexAutoSwitchEnabled()) return next()
      const previous = this.quotaRecoveryAttempts.get(agent)
      if (previous?.turn === turn && previous.step === step) return next()
      const request = this.requestSelections.get(agent)
      if (!await this.recoverCodexQuota(signal, request?.turn === turn && request.step === step ? request : undefined)) return next()
      this.quotaRecoveryAttempts.set(agent, { turn, step })
      return { kind: 'retry' }
    }, { prepend: true })
  }

  /**
   * Return every managed account without returning its stored credential.
   * @returns the public provider/account state, including whether the vault accepts writes.
   */
  @Remote
  async describe(): Promise<AccountsState> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return this.emptyState(false)
    const writable = (await credentials.describeRecord(VAULT_KEY)).writable
    const vault = writable ? await this.importCanonicalAccounts(credentials) : await this.readVault(credentials)
    return this.publicState(vault, writable)
  }

  /**
   * Authorize an identity through a staged browser flow without replacing the active account.
   * Only the first saved identity becomes active automatically.
   * @param provider - installed OAuth-capable provider to authorize.
   * @param signal - cancellation for browser opening, prompts, and provider authorization.
   * @returns whether authorization completed or the user cancelled it.
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

    await this.importCanonicalAccounts(credentials)
    const destination = credentialKey('account-manager', `login-${randomUUID()}`)
    let opening = Promise.resolve()
    let openFailure: unknown
    const authorize = async () => authorization.begin({
      key: canonicalKey,
      destination,
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
    try {
      const outcome = await authorize()
      await opening
      if (openFailure !== undefined) throw unavailable(`could not open the ${definition.label} sign-in page`)
      if (outcome.status === 'cancelled') return { status: 'cancelled' }
      const credential = await credentials.readRecord(destination)
      if (credential === undefined) throw unavailable(`${definition.label} sign-in completed without a stored credential`)
      const account = accountFromCredential(definition, credential, this.now())
      await this.commitSelection(credentials, provider, (current) => {
        const active = current.providers[provider]?.activeAccountId
        return upsertAccount(current, account, active ?? account.id)
      })
      return { status: 'authorized' }
    } finally {
      await opening
      await credentials.deleteRecord(destination)
    }
  }

  /**
   * Add a named API-key identity; only the first account becomes active automatically.
   * @param provider - installed API-key provider that will own the identity.
   * @param name - user-visible local label, bounded before storage.
   * @param key - secret API key written to the protected credential vault.
   * @returns the updated public account state with credentials omitted.
   */
  @Remote
  async addApiKey(provider: AccountProviderId, name: string, key: string): Promise<AccountsState> {
    const definition = providerDefinition(provider)
    if (definition.authMode !== 'api-key') throw rejected(provider, 'this provider uses browser sign-in')
    const cleanKey = key.trim()
    if (cleanKey.length === 0) throw rejected(provider, 'an API key is required')
    const credentials = this.credentials()
    await this.importCanonicalAccounts(credentials)
    const account: StoredAccount = {
      id: `acc_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      provider,
      authMode: 'api-key',
      credential: { kind: 'api-key', key: cleanKey },
      name: boundedText(name, 80) ?? `${definition.label} account`,
      createdAt: this.now(),
    }
    const next = await this.commitSelection(credentials, provider, (current) => {
      const currentActive = current.providers[provider]?.activeAccountId
      return upsertAccount(current, account, currentActive ?? account.id)
    })
    return this.publicState(next, true)
  }

  /**
   * Make one saved identity the canonical credential used by model requests.
   * @param provider - provider whose active identity changes.
   * @param accountId - saved identity to promote.
   * @returns the updated public account state with credentials omitted.
   */
  @Remote
  async activate(provider: AccountProviderId, accountId: string): Promise<AccountsState> {
    providerDefinition(provider)
    this.invalidateSelection(provider)
    const credentials = this.credentials()
    const next = await this.commitSelection(credentials, provider, (current) => {
      if (current.providers[provider]?.accounts[accountId] === undefined) throw notFound(provider, accountId)
      return setActive(current, provider, accountId)
    })
    return this.publicState(next, true)
  }

  /**
   * Enable or disable automatic Codex failover at the displayed 95% safety threshold and after quota refusal.
   * @param provider - provider whose failover preference changes; only Codex supports it.
   * @param enabled - whether fresh usage checks may promote an eligible saved account.
   * @returns the updated public account state with credentials omitted.
   */
  @Remote
  async setAutoSwitch(provider: AccountProviderId, enabled: boolean): Promise<AccountsState> {
    if (provider !== 'openai-codex') throw rejected(provider, 'automatic limit switching is available only for Codex')
    this.invalidateSelection(provider)
    const credentials = this.credentials()
    await this.importCanonicalAccounts(credentials)
    const next = await this.mutateVault(credentials, (current) => {
      const currentProvider = current.providers[provider]
      if (currentProvider === undefined) throw rejected(provider, 'save a Codex account before enabling automatic switching')
      return replaceProviderVault(current, provider, { ...currentProvider, autoSwitchOnLimit: enabled })
    })
    return this.publicState(next, true)
  }

  /**
   * Read individual Codex reset credits without redeeming or persisting them.
   * @param accountId - saved Codex membership whose credits will be listed.
   * @param signal - cancellation forwarded to the provider request.
   * @returns secret-free provider records, including unavailable or unsupported credits.
   */
  @Remote
  async listResetCredits(accountId: string, signal: AbortSignal): Promise<AccountResetCreditList> {
    const access = await this.codexAccess(accountId, signal)
    const response = await this.fetchUsage(RESET_CREDITS_URL, {
      method: 'GET',
      headers: codexUsageHeaders(access.oauth.access, access.accountId),
      signal: combinedSignal(signal),
    })
    if (!response.ok) throw unavailable(`reset credit details request failed (${String(response.status)})`)
    return decodeResetCreditList(await response.json())
  }

  /**
   * Consume the selected provider-issued Codex reset credit for a saved account.
   * @param accountId - saved Codex identity whose reset credit will be consumed.
   * @param creditId - exact provider credit selected by the user; automatic selection is not used.
   * @param idempotencyKey - stable identifier reused when retrying the same account and credit action.
   * @param signal - cancellation forwarded to provider requests.
   * @returns the provider outcome and committed public state after refreshing only the selected membership;
   * unrelated usage is retained, and this usage-only refresh does not automatically switch accounts.
   */
  @Remote
  async consumeResetCredit(
    accountId: string,
    creditId: AccountResetCreditId,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<AccountResetCreditResult> {
    const selectedCreditId = decodeResetCreditId(creditId)
    if (selectedCreditId === undefined) throw rejected('openai-codex', 'a selected reset credit is required')
    const cleanKey = boundedText(idempotencyKey, 128)
    if (cleanKey === undefined) throw rejected('openai-codex', 'a reset attempt identifier is required')
    const access = await this.codexAccess(accountId, signal)
    const response = await this.fetchUsage(CONSUME_RESET_CREDIT_URL, {
      method: 'POST',
      headers: { ...codexUsageHeaders(access.oauth.access, access.accountId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ redeem_request_id: cleanKey, credit_id: selectedCreditId }),
      signal: combinedSignal(signal),
    })
    if (!response.ok) throw unavailable(`reset credit request failed (${String(response.status)})`)
    const outcome = decodeResetCreditOutcome(await response.json())
    const state = await this.refreshUsageRun(signal, false, accountId)
    return { outcome, state }
  }

  /**
   * Save or clear a user-entered billing reminder for exactly one saved membership.
   * The date is never inferred, advanced, or copied to another membership.
   * @param provider - provider owning the saved membership.
   * @param accountId - saved membership to edit, independent of the active selection.
   * @param date - exact Gregorian YYYY-MM-DD (years 0001–9999), including past dates; null clears it.
   * @returns the redacted state after persistence commits and accounts/changed is published.
   * @throws RemoteError when the date is invalid, the membership is absent, or storage is unavailable;
   * credential-provider write failures propagate without publishing a changed snapshot.
   */
  @Remote
  async setManualBillingDate(provider: AccountProviderId, accountId: string, date: string | null): Promise<AccountsState> {
    providerDefinition(provider)
    const manualBillingDate = date === null ? undefined : decodeManualBillingDate(date)
    if (date !== null && manualBillingDate === undefined) {
      throw rejected(provider, 'billing reminder must be a valid YYYY-MM-DD date')
    }
    const next = await this.mutateVault(this.credentials(), (current) => {
      const providerVault = current.providers[provider]
      const account = providerVault?.accounts[accountId]
      if (providerVault === undefined || account === undefined) throw notFound(provider, accountId)
      const { manualBillingDate: _previousDate, ...withoutReminder } = account
      return replaceProviderVault(current, provider, {
        ...providerVault,
        accounts: { ...providerVault.accounts, [accountId]: {
          ...withoutReminder, ...manualBillingDate === undefined ? {} : { manualBillingDate },
        } },
      })
    })
    return this.publicState(next, true)
  }

  /**
   * Rename one local account without changing its credential or active state.
   * @param provider - provider containing the saved identity.
   * @param accountId - saved identity to rename.
   * @param name - new user-visible label, bounded before storage.
   * @returns the updated public account state with credentials omitted.
   */
  @Remote
  async rename(provider: AccountProviderId, accountId: string, name: string): Promise<AccountsState> {
    const cleanName = boundedText(name, 80)
    if (cleanName === undefined) throw rejected(provider, 'an account name is required')
    const credentials = this.credentials()
    const next = await this.mutateVault(credentials, (current) => {
      const providerVault = current.providers[provider]
      const renamed = providerVault?.accounts[accountId]
      if (providerVault === undefined || renamed === undefined) throw notFound(provider, accountId)
      return replaceProviderVault(current, provider, {
        ...providerVault,
        accounts: { ...providerVault.accounts, [accountId]: { ...renamed, name: cleanName } },
      })
    })
    return this.publicState(next, true)
  }

  /**
   * Remove one saved identity and promote the next identity when it was active.
   * @param provider - provider containing the saved identity.
   * @param accountId - saved identity to remove.
   * @returns the updated public account state with credentials omitted.
   */
  @Remote
  async deleteAccount(provider: AccountProviderId, accountId: string): Promise<AccountsState> {
    this.invalidateSelection(provider)
    const credentials = this.credentials()
    const next = await this.commitSelection(credentials, provider, (current) => {
      const providerVault = current.providers[provider]
      if (providerVault?.accounts[accountId] === undefined) throw notFound(provider, accountId)
      const accounts: Record<string, StoredAccount> = {}
      for (const [id, account] of Object.entries(providerVault.accounts)) {
        if (id !== accountId) accounts[id] = account
      }
      const replacement = providerVault.activeAccountId === accountId ? Object.values(accounts)[0] : undefined
      const activeAccountId = providerVault.activeAccountId === accountId ? replacement?.id : providerVault.activeAccountId
      const { activeAccountId: _previousActive, ...preferences } = providerVault
      return replaceProviderVault(current, provider, {
        ...preferences,
        accounts,
        ...activeAccountId === undefined ? {} : { activeAccountId },
      })
    })
    return this.publicState(next, true)
  }

  /**
   * Refresh supported usage snapshots, active account first, and push each committed update.
   * @param signal - cancellation checked between accounts and forwarded to usage requests.
   * @returns the updated public account state with refreshed usage when available.
   */
  @Remote
  async refreshUsage(signal: AbortSignal): Promise<AccountsState> {
    return this.refreshUsageRun(signal, true)
  }

  /** Coalesce stream completions, retaining one follow-up for completions during a read. */
  private refreshAfterRequest(): void {
    if (this.usageLifecycle.signal.aborted) return
    this.usageRequested = true
    if (this.backgroundUsage !== undefined) return
    this.backgroundUsage = (async () => {
      while (this.usageRequested && !this.usageLifecycle.signal.aborted) {
        this.usageRequested = false
        try {
          await this.refreshUsageRun(this.usageLifecycle.signal, false)
        } catch (error: unknown) {
          this.reportUsageError(error)
        }
      }
    })().finally(() => {
      this.backgroundUsage = undefined
      if (this.usageRequested) this.refreshAfterRequest()
    })
  }

  /** Report background failures only while the usage lifecycle is active. */
  private reportUsageError(error: unknown): void {
    if (!this.usageLifecycle.signal.aborted) this.ctx.logger.warn(`accounts: usage refresh failed: ${messageOf(error)}`)
  }

  private async refreshUsageRun(signal: AbortSignal, automatic: boolean, accountId?: string): Promise<AccountsState> {
    assertUsageRefreshActive(signal)
    const predecessor = this.usageRefreshTail
    let release!: () => void
    this.usageRefreshTail = new Promise<void>((resolve) => { release = resolve })
    await predecessor
    try {
      assertUsageRefreshActive(signal)
      return await this.refreshUsageOnce(signal, automatic, accountId)
    } finally {
      release()
    }
  }

  private async refreshUsageOnce(signal: AbortSignal, automatic: boolean, accountId?: string): Promise<AccountsState> {
    const revision = this.selectionRevisions.get('openai-codex') ?? 0
    const credentials = this.credentials()
    let vault = await this.importCanonicalAccounts(credentials)
    const codex = vault.providers['openai-codex']
    if (codex === undefined) return this.publicState(vault, true)
    const accounts = Object.values(codex.accounts)
      .filter(account => accountId === undefined || account.id === accountId)
      .sort((left, right) => Number(right.id === codex.activeAccountId) - Number(left.id === codex.activeAccountId))
    for (const saved of accounts) {
      assertUsageRefreshActive(signal)
      const account = (await this.readVault(credentials)).providers['openai-codex']?.accounts[saved.id]
      if (account === undefined) continue
      const refreshed = await this.refreshCodexAccount(account, signal)
      assertUsageRefreshActive(signal)
      vault = await this.commitSelection(credentials, 'openai-codex', (current) => {
        const currentProvider = current.providers['openai-codex']
        const existing = currentProvider?.accounts[account.id]
        if (currentProvider === undefined || existing === undefined
          || !sameRecord(existing.credential, refreshed.credential)) return undefined
        return replaceProviderVault(current, 'openai-codex', {
          ...currentProvider,
          accounts: {
            ...currentProvider.accounts,
            [account.id]: retainManualBillingDate({ ...refreshed, name: existing.name }, existing),
          },
        })
      })
    }
    if (automatic && !signal.aborted) vault = await this.autoSwitchCodexAtLimit(credentials, revision)
    return this.publicState(vault, true)
  }

  private async autoSwitchCodexAtLimit(
    credentials: CredentialProvider,
    revision: number,
    failedId?: string,
  ): Promise<AccountVault> {
    let event: AccountAutoSwitchEvent | undefined
    const next = await this.commitSelection(credentials, 'openai-codex', (current) => {
      if ((this.selectionRevisions.get('openai-codex') ?? 0) !== revision) return undefined
      const provider = current.providers['openai-codex']
      if (provider?.autoSwitchOnLimit !== true || provider.activeAccountId === undefined) return undefined
      if (failedId !== undefined && provider.activeAccountId !== failedId) return undefined
      const active = provider.accounts[provider.activeAccountId]
      const limit = active === undefined ? undefined : switchableStandardLimit(active)
      if (active === undefined || (failedId === undefined && limit === undefined)) return undefined
      const replacement = bestCodexReplacement(active, Object.values(provider.accounts))
      if (replacement === undefined) return undefined
      const activeIdentity = codexIdentity(active.credential)
      const replacementIdentity = codexIdentity(replacement.credential)
      event = {
        id: randomUUID(),
        occurredAt: this.now(),
        provider: 'openai-codex',
        reason: failedId === undefined ? 'threshold' : 'quota',
        ...failedId === undefined && limit !== undefined ? { limit } : {},
        from: {
          name: active.name,
          ...activeIdentity.usageScope === undefined ? {} : { usageScope: activeIdentity.usageScope },
        },
        to: {
          name: replacement.name,
          ...replacementIdentity.usageScope === undefined ? {} : { usageScope: replacementIdentity.usageScope },
        },
      }
      return setActive(current, 'openai-codex', replacement.id)
    })
    if (event !== undefined) this.ctx.emit('accounts/auto-switched', event)
    return next
  }

  private async codexAutoSwitchEnabled(): Promise<boolean> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return false
    const vault = await this.readVault(credentials)
    return vault.providers['openai-codex']?.autoSwitchOnLimit === true
  }

  /** Refresh an opted-in Codex route immediately before the model credential is resolved. */
  private async prepareCodexAccount(signal: AbortSignal): Promise<void> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return
    const vault = await this.readVault(credentials)
    if (vault.providers['openai-codex']?.autoSwitchOnLimit !== true) return
    try {
      await this.refreshUsage(signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      this.ctx.logger.warn(`accounts: pre-request Codex usage refresh failed: ${messageOf(error)}`)
    }
  }

  /** Select a refreshed account after a provider-confirmed quota failure so the open turn can retry once. */
  private async recoverCodexQuota(
    signal: AbortSignal,
    request?: { readonly id?: string; readonly revision: number },
  ): Promise<boolean> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return false
    const before = await this.readVault(credentials)
    const providerBefore = before.providers['openai-codex']
    if (providerBefore?.autoSwitchOnLimit !== true || providerBefore.activeAccountId === undefined) return false
    const activeBefore = providerBefore.activeAccountId
    const revision = this.selectionRevisions.get('openai-codex') ?? 0
    if (request !== undefined && (request.id !== activeBefore || request.revision !== revision)) return false
    const failed = providerBefore.accounts[activeBefore]
    if (failed === undefined) return false
    try {
      await this.refreshUsageRun(signal, false)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      this.ctx.logger.warn(`accounts: Codex quota recovery refresh failed: ${messageOf(error)}`)
      return false
    }
    assertUsageRefreshActive(signal)
    const next = await this.autoSwitchCodexAtLimit(credentials, revision, activeBefore)
    return (this.selectionRevisions.get('openai-codex') ?? 0) === revision + 1
      && next.providers['openai-codex']?.activeAccountId !== undefined
      && next.providers['openai-codex'].activeAccountId !== activeBefore
  }

  private async refreshCodexAccount(account: StoredAccount, signal: AbortSignal): Promise<StoredAccount> {
    let credential = account.credential
    try {
      const access = await this.codexAccess(account.id, signal)
      credential = access.credential
      const headers = codexUsageHeaders(access.oauth.access, access.accountId)
      const response = await this.fetchUsage(USAGE_URL, { headers, signal: combinedSignal(signal) })
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

  private async persistCodexCredentialUnlocked(
    credentials: CredentialProvider,
    account: StoredAccount,
    credential: CredentialRecord,
  ): Promise<void> {
    if (sameRecord(credential, account.credential)) return
    const updated = await this.commitSelectionUnlocked(credentials, 'openai-codex', (currentVault) => {
      const provider = currentVault.providers['openai-codex']
      const current = provider?.accounts[account.id]
      if (provider === undefined || current === undefined) return undefined
      if (sameRecord(current.credential, credential)) return currentVault
      if (!sameRecord(current.credential, account.credential)) return undefined
      return updateAccountCredential(currentVault, provider, current, credential)
    })
    if (!sameRecord(updated.providers['openai-codex']?.accounts[account.id]?.credential, credential)) {
      throw unavailable('the saved account changed before its credentials could be refreshed')
    }
  }

  private async codexAccess(accountId: string, signal: AbortSignal): Promise<{
    readonly credential: CredentialRecord
    readonly oauth: OAuthCredential
    readonly accountId?: string
  }> {
    const credentials = this.credentials()
    return this.withCommit(credentials, async () => {
      assertUsageRefreshActive(signal)
      const vault = await this.importCanonicalAccountsUnlocked(credentials)
      const latest = vault.providers['openai-codex']?.accounts[accountId]
      if (latest === undefined) throw notFound('openai-codex', accountId)
      let credential = latest.credential
      let oauth = oauthCredential(credential)
      if (oauth === undefined) throw new Error('the saved account is not an OAuth account')
      const identity = codexIdentity(credential)
      if (oauth.expires <= this.now() + 60_000) {
        const refresh = openaiCodexProvider().auth.oauth
        if (refresh === undefined) throw new Error('the Codex OAuth refresher is unavailable')
        const refreshed = await refresh.refresh(oauth, combinedSignal(signal))
        if (codexIdentity({ kind: 'grant', payload: refreshed }).ownerId !== identity.ownerId) {
          throw unavailable('refreshed Codex account owner changed')
        }
        credential = { kind: 'grant', payload: jsonImage({
          ...refreshed, ...identity.accountId === undefined ? {} : { accountId: identity.accountId },
        }) }
        await this.persistCodexCredentialUnlocked(credentials, latest, credential)
        assertUsageRefreshActive(signal)
        oauth = oauthCredential(credential)
        if (oauth === undefined) throw new Error('the refreshed account is not an OAuth account')
      }
      return { credential, oauth, ...identity.accountId === undefined ? {} : { accountId: identity.accountId } }
    })
  }

  private async importCanonicalAccounts(credentials: CredentialProvider): Promise<AccountVault> {
    return this.withCommit(credentials, () => this.importCanonicalAccountsUnlocked(credentials))
  }

  private async importCanonicalAccountsUnlocked(credentials: CredentialProvider): Promise<AccountVault> {
    const beforeRecord = await credentials.readRecord(VAULT_KEY)
    let vault = normalizeCodexAccountIds(parseVault(beforeRecord))
    for (const definition of PROVIDERS) {
      const canonical = await credentials.readRecord(providerKey(definition.id))
      vault = this.mergeCanonicalAccount(vault, definition, canonical)
    }
    const nextRecord: CredentialRecord = { kind: 'grant', payload: jsonImage(vault) }
    await replaceRecord(credentials, VAULT_KEY, beforeRecord, nextRecord)
    if (!isDeepStrictEqual(beforeRecord, nextRecord)) this.publishState(vault)
    return vault
  }

  private mergeCanonicalAccount(
    vault: AccountVault,
    definition: ProviderDefinition,
    credential: CredentialRecord | undefined,
  ): AccountVault {
    if (credential === undefined) return vault
    const providerVault = vault.providers[definition.id]
    const active = providerVault?.activeAccountId
    if (providerVault !== undefined && active !== undefined && providerVault.accounts[active] !== undefined) {
      const matchingId = definition.id === 'openai-codex' ? codexIdentity(credential).id : active
      const current = providerVault.accounts[matchingId]
      return current === undefined || sameRecord(current.credential, credential)
        ? vault : updateAccountCredential(vault, providerVault, current, credential)
    }
    const account = accountFromCredential(definition, credential, this.now())
    return upsertAccount(vault, account, account.id)
  }

  /** Notify every snapshot observer without letting failures reject a committed write. */
  private publishState(vault: AccountVault): void {
    void this.ctx.parallel('accounts/changed', this.publicState(vault, true)).catch((error: unknown) => {
      this.ctx.logger.warn(`accounts: snapshot observer failed: ${messageOf(error)}`)
    })
  }

  private publicState(vault: AccountVault, writable: boolean): AccountsState {
    const accounts = PROVIDERS.flatMap((definition) => {
      const providerVault = vault.providers[definition.id]
      if (providerVault === undefined) return []
      return Object.values(providerVault.accounts)
        .map(account => publicAccount(account, providerVault.activeAccountId))
        .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name))
    })
    const providers: AccountProviderView[] = PROVIDERS.map((definition) => {
      const providerVault = vault.providers[definition.id]
      const flow = this.ctx.get('authorization')?.describe(providerKey(definition.id))
      const owners = new Set(accounts
        .filter(account => account.provider === definition.id)
        .map(account => account.ownerId))
      return {
        id: definition.id,
        label: definition.label,
        authMode: definition.authMode,
        available: definition.authMode === 'api-key' || flow?.methods.some(method => method.id === 'oauth') === true,
        accountCount: owners.size,
        ...providerVault?.activeAccountId === undefined ? {} : { activeAccountId: providerVault.activeAccountId },
        usageAvailable: definition.usageAvailable,
        autoSwitchOnLimit: definition.id === 'openai-codex' && providerVault?.autoSwitchOnLimit === true,
      }
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
        autoSwitchOnLimit: false,
      })),
      accounts: [],
    }
  }

  private async readVault(credentials: CredentialProvider): Promise<AccountVault> {
    return this.withCommit(credentials, () => credentials.readRecord(VAULT_KEY).then(parseVault))
  }

  private invalidateSelection(provider: AccountProviderId): void {
    this.selectionRevisions.set(provider, (this.selectionRevisions.get(provider) ?? 0) + 1)
  }

  /** Exclude SDK refresh while a controller credential operation commits or rolls back. */
  private withCommit<T>(credentials: CredentialProvider, run: () => Promise<T>): Promise<T> {
    return credentials.withRecords(run)
  }

  /** Commit the selected grant and vault together; failed writes restore the previous selection. */
  private async commitSelection(
    credentials: CredentialProvider,
    provider: AccountProviderId,
    mutate: (vault: AccountVault) => AccountVault | undefined,
  ): Promise<AccountVault> {
    return this.withCommit(credentials, () => this.commitSelectionUnlocked(credentials, provider, mutate))
  }

  private async commitSelectionUnlocked(
    credentials: CredentialProvider,
    provider: AccountProviderId,
    mutate: (vault: AccountVault) => AccountVault | undefined,
  ): Promise<AccountVault> {
    const beforeRecord = await credentials.readRecord(VAULT_KEY)
    const key = providerKey(provider)
    const canonical = await credentials.readRecord(key)
    const stored = parseVault(beforeRecord)
    const before = this.mergeCanonicalAccount(normalizeCodexAccountIds(stored), providerDefinition(provider), canonical)
    const next = mutate(before)
    if (next === undefined) {
      if (before !== stored) {
        await replaceRecord(credentials, VAULT_KEY, beforeRecord, { kind: 'grant', payload: jsonImage(before) })
        this.publishState(before)
      }
      return before
    }
    const selected = next.providers[provider]
    const desired = selected?.activeAccountId === undefined
      ? undefined : selected.accounts[selected.activeAccountId]?.credential
    const previousSelected = before.providers[provider]?.activeAccountId
    const settings = this.settings()
    const route = propertyOf(propertyOf(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS)?.value,
      'providers'), provider)
    const nextRecord: CredentialRecord = { kind: 'grant', payload: jsonImage(next) }
    try {
      if (!sameRecord(canonical, desired)) await replaceRecord(credentials, key, canonical, desired)
      if (desired !== undefined) await this.activateProviderRoute(provider)
      else if (previousSelected !== undefined) await this.deactivateProviderRoute(provider)
      await replaceRecord(credentials, VAULT_KEY, beforeRecord, nextRecord)
    } catch (error: unknown) {
      const failures: unknown[] = [error]
      try {
        if (sameRecord(await credentials.readRecord(key), desired)) await replaceRecord(credentials, key, desired, canonical)
      } catch (rollbackError: unknown) { failures.push(rollbackError) }
      try {
        if (sameRecord(await credentials.readRecord(VAULT_KEY), nextRecord)) {
          await replaceRecord(credentials, VAULT_KEY, nextRecord, beforeRecord)
        }
      } catch (rollbackError: unknown) { failures.push(rollbackError) }
      try {
        const currentRoute = propertyOf(propertyOf(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS)?.value,
          'providers'), provider)
        if (route === undefined && JSON.stringify(currentRoute) === '{}') await this.deactivateProviderRoute(provider)
        else if (route !== undefined && currentRoute === undefined) {
          await settings.mutate(PI_AI_SETTINGS, [{ op: 'set', path: ['providers', provider], value: route }])
        }
      } catch (rollbackError: unknown) { failures.push(rollbackError) }
      if (failures.length > 1) throw new AggregateError(failures, 'account selection and rollback failed')
      throw error
    }
    if (previousSelected !== selected?.activeAccountId) this.invalidateSelection(provider)
    if (!isDeepStrictEqual(beforeRecord, nextRecord)) this.publishState(next)
    return next
  }

  /**
   * Apply one vault transformation through the credential store's serialized
   * record write, so a concurrent account operation can never lose this
   * operation's committed change or resurrect an overwritten snapshot.
   * @param credentials - protected credential storage owning the vault record.
   * @param mutate - pure transformation over the vault as it stands at the write.
   * @returns the committed vault, or the untouched vault when `mutate` declined.
   */
  private async mutateVault(
    credentials: CredentialProvider,
    mutate: (vault: AccountVault) => Promise<AccountVault | undefined> | AccountVault | undefined,
  ): Promise<AccountVault> {
    return this.withCommit(credentials, async () => {
      const publication = { changed: false }
      const committed = await credentials.modifyRecord(VAULT_KEY, async (record) => {
        const next = await mutate(parseVault(record))
        if (next === undefined) return undefined
        const nextRecord: CredentialRecord = { kind: 'grant', payload: jsonImage(next) }
        publication.changed = !isDeepStrictEqual(record, nextRecord)
        return nextRecord
      })
      const vault = parseVault(committed)
      if (publication.changed) this.publishState(vault)
      return vault
    })
  }

  /** Restore model routes for active credentials after settings and credentials have loaded. */
  private async reconcileProviderRoutes(credentials: CredentialProvider, settings: SettingsForms): Promise<void> {
    await this.withCommit(credentials, async () => {
      const configured: AccountProviderId[] = []
      for (const definition of PROVIDERS) {
        if (await credentials.readRecord(providerKey(definition.id)) !== undefined) configured.push(definition.id)
      }
      const providers = propertyOf(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS)?.value, 'providers')
      const operations = configured
        .filter(provider => !isRecord(providers) || !Object.hasOwn(providers, provider))
        .map(provider => ({ op: 'set' as const, path: ['providers', provider], value: {} }))
      if (operations.length > 0) await settings.mutate(PI_AI_SETTINGS, operations)
    })
  }

  private async activateProviderRoute(provider: AccountProviderId): Promise<void> {
    const settings = this.settings()
    const providers = propertyOf(settings.describe().find(entry => entry.ns === PI_AI_SETTINGS)?.value, 'providers')
    if (isRecord(providers) && Object.hasOwn(providers, provider)) return
    await settings.mutate(PI_AI_SETTINGS, [{ op: 'set', path: ['providers', provider], value: {} }])
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

  private settings(): SettingsForms {
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

function propertyOf(value: unknown, key: string): unknown {
  return isRecord(value) ? Reflect.get(value, key) : undefined
}

function providerKey(provider: AccountProviderId): CredentialKey {
  return credentialKey('llm-pi-ai', provider)
}

function parseVault(record: CredentialRecord | undefined): AccountVault {
  if (record?.kind !== 'grant' || !isRecord(record.payload)) return { version: 1, providers: {} }
  const payload = record.payload
  if (payload.version !== 1 || !isRecord(payload.providers)) return { version: 1, providers: {} }
  const providers: Partial<Record<AccountProviderId, ProviderVault>> = {}
  for (const definition of PROVIDERS) {
    const candidate = decodeProviderVault(payload.providers[definition.id], definition)
    if (candidate !== undefined) providers[definition.id] = candidate
  }
  return { version: 1, providers }
}

/** Decode one provider's protected account records from durable JSON. */
function decodeProviderVault(value: unknown, definition: ProviderDefinition): ProviderVault | undefined {
  if (isRecord(value) && isRecord(value.accounts)) {
    for (const account of Object.values(value.accounts)) {
      if (isRecord(account) && account.manualBillingDate !== undefined
        && decodeManualBillingDate(account.manualBillingDate) === undefined) {
        throw rejected(definition.id, 'stored billing reminder must be a valid YYYY-MM-DD date')
      }
    }
  }
  if (!isRecord(value) || !isRecord(value.accounts)
    || (value.activeAccountId !== undefined && typeof value.activeAccountId !== 'string')
    || (value.autoSwitchOnLimit !== undefined && typeof value.autoSwitchOnLimit !== 'boolean')) return undefined
  const accounts: Record<string, StoredAccount> = {}
  for (const [storedId, candidate] of Object.entries(value.accounts)) {
    const account = decodeStoredAccount(candidate, definition)
    if (account === undefined || account.id !== storedId) return undefined
    accounts[storedId] = account
  }
  return {
    accounts,
    ...typeof value.activeAccountId === 'string' ? { activeAccountId: value.activeAccountId } : {},
    ...typeof value.autoSwitchOnLimit === 'boolean' ? { autoSwitchOnLimit: value.autoSwitchOnLimit } : {},
  }
}

/** Decode one durable account while keeping its credential opaque to this manager. */
function decodeStoredAccount(value: unknown, definition: ProviderDefinition): StoredAccount | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.provider !== definition.id
    || value.authMode !== definition.authMode || typeof value.name !== 'string'
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || !isCredentialRecord(value.credential)
    || (value.detail !== undefined && typeof value.detail !== 'string')
    || (value.usageUpdatedAt !== undefined
      && (typeof value.usageUpdatedAt !== 'number' || !Number.isFinite(value.usageUpdatedAt)))
    || (value.usageError !== undefined && typeof value.usageError !== 'string')) return undefined
  const manualBillingDate = value.manualBillingDate === undefined
    ? undefined : decodeManualBillingDate(value.manualBillingDate)
  const usage = value.usage === undefined ? undefined : decodeUsage(value.usage)
  if (value.usage !== undefined && usage === undefined) return undefined
  return {
    id: value.id,
    provider: definition.id,
    authMode: definition.authMode,
    credential: value.credential,
    name: value.name,
    createdAt: value.createdAt,
    ...typeof value.detail === 'string' ? { detail: value.detail } : {},
    ...usage === undefined ? {} : { usage },
    ...typeof value.usageUpdatedAt === 'number' ? { usageUpdatedAt: value.usageUpdatedAt } : {},
    ...typeof value.usageError === 'string' ? { usageError: value.usageError } : {},
    ...manualBillingDate === undefined ? {} : { manualBillingDate },
  }
}

/** Validate date-only durable and Remote input without timezone conversion or normalization. */
function decodeManualBillingDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year === 0 || month < 1 || month > 12 || day < 1) return undefined
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
  return day <= daysInMonth ? value : undefined
}

/** Decode the credential seam's tagged durable value. */
function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!isRecord(value)) return false
  if (value.kind === 'grant') return Object.hasOwn(value, 'payload')
  if (value.kind !== 'api-key' || (value.key !== undefined && typeof value.key !== 'string')) return false
  return value.env === undefined || (isRecord(value.env) && Object.values(value.env)
    .every(entry => typeof entry === 'string'))
}

/** Decode a provider usage snapshot attached to an account. */
function decodeUsage(value: unknown): AccountUsageView | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows)) return undefined
  const resetCredits = value.resetCredits === undefined ? undefined : decodeResetCredits(value.resetCredits)
  if (value.resetCredits !== undefined && resetCredits === undefined) return undefined
  const windows: AccountUsageWindow[] = []
  for (const candidate of value.windows) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.label !== 'string'
      || typeof candidate.usedPercent !== 'number' || !Number.isFinite(candidate.usedPercent)
      || (candidate.resetsAtMs !== undefined
        && (typeof candidate.resetsAtMs !== 'number' || !Number.isFinite(candidate.resetsAtMs)))) return undefined
    windows.push({
      id: candidate.id,
      label: candidate.label,
      usedPercent: candidate.usedPercent,
      ...typeof candidate.resetsAtMs === 'number' ? { resetsAtMs: candidate.resetsAtMs } : {},
    })
  }
  return { windows, ...resetCredits === undefined ? {} : { resetCredits } }
}

function replaceProviderVault(vault: AccountVault, provider: AccountProviderId, value: ProviderVault): AccountVault {
  return { ...vault, providers: { ...vault.providers, [provider]: value } }
}

function normalizeCodexAccountIds(vault: AccountVault): AccountVault {
  const provider = vault.providers['openai-codex']
  if (provider === undefined) return vault
  const accounts: Record<string, StoredAccount> = {}
  let activeAccountId: string | undefined
  let changed = false
  for (const [storedId, account] of Object.entries(provider.accounts)) {
    const id = codexIdentity(account.credential).id
    const active = storedId === provider.activeAccountId
    const candidate = id === account.id ? account : { ...account, id }
    const existing = accounts[id]
    if (existing === undefined || active || candidate.createdAt > existing.createdAt) accounts[id] = candidate
    if (active) activeAccountId = id
    if (storedId !== id || account.id !== id) changed = true
  }
  if (!changed) return vault
  const { activeAccountId: _previousActiveAccountId, ...providerSettings } = provider
  return replaceProviderVault(vault, 'openai-codex', {
    ...providerSettings,
    accounts,
    ...activeAccountId === undefined ? {} : { activeAccountId },
  })
}

function upsertAccount(vault: AccountVault, account: StoredAccount, activeAccountId: string): AccountVault {
  const current = vault.providers[account.provider]
  return replaceProviderVault(vault, account.provider, {
    ...current,
    accounts: { ...current?.accounts, [account.id]: retainManualBillingDate(account, current?.accounts[account.id]) },
    activeAccountId,
  })
}

/** Keep the current membership's reminder, including a clear during an in-flight refresh. */
function retainManualBillingDate(account: StoredAccount, current: StoredAccount | undefined): StoredAccount {
  const { manualBillingDate: _staleDate, ...withoutReminder } = account
  return {
    ...withoutReminder,
    ...current?.manualBillingDate === undefined ? {} : { manualBillingDate: current.manualBillingDate },
  }
}

function updateAccountCredential(
  vault: AccountVault,
  provider: ProviderVault,
  account: StoredAccount,
  credential: CredentialRecord,
): AccountVault {
  const identityChanged = account.provider !== 'openai-codex' && account.authMode === 'oauth'
    && genericOAuthIdentity(account.credential).stable !== genericOAuthIdentity(credential).stable
  const { manualBillingDate: _previousDate, ...withoutReminder } = account
  const accounts = { ...provider.accounts, [account.id]: { ...(identityChanged ? withoutReminder : account), credential } }
  if (account.provider === 'openai-codex') {
    const oldOAuth = oauthCredential(account.credential)
    const newOAuth = oauthCredential(credential)
    const owner = codexIdentity(account.credential).ownerId
    if (oldOAuth !== undefined && newOAuth !== undefined && codexIdentity(credential).ownerId === owner) {
      for (const alias of Object.values(provider.accounts)) {
        if (alias.id === account.id) continue
        const oauth = oauthCredential(alias.credential)
        if (oauth?.refresh !== oldOAuth.refresh || codexIdentity(alias.credential).ownerId !== owner) continue
        accounts[alias.id] = {
          ...alias,
          credential: { kind: 'grant', payload: jsonImage({ ...oauth, refresh: newOAuth.refresh }) },
        }
      }
    }
  }
  return replaceProviderVault(vault, account.provider, { ...provider, accounts })
}

function setActive(vault: AccountVault, provider: AccountProviderId, accountId: string): AccountVault {
  const current = vault.providers[provider]
  if (current === undefined) return vault
  return replaceProviderVault(vault, provider, { ...current, activeAccountId: accountId })
}

function standardUsageWindows(account: StoredAccount): readonly AccountUsageWindow[] {
  return account.usage?.windows.filter(window => window.label === '5h' || window.label === '7d') ?? []
}

function switchableStandardLimit(account: StoredAccount): '5h' | '7d' | undefined {
  return standardUsageWindows(account)
    .find((window): window is AccountUsageWindow & { readonly label: '5h' | '7d' } =>
      (window.label === '5h' || window.label === '7d')
      && Math.round(window.usedPercent) >= CODEX_AUTO_SWITCH_THRESHOLD)?.label
}

function accountHasStandardCapacity(account: StoredAccount): boolean {
  const windows = standardUsageWindows(account)
  return windows.length > 0 && windows.every(window => Math.round(window.usedPercent) < CODEX_AUTO_SWITCH_THRESHOLD)
}

function bestCodexReplacement(
  active: StoredAccount,
  accounts: readonly StoredAccount[],
): StoredAccount | undefined {
  const activeIdentity = codexIdentity(active.credential)
  return accounts
    .filter(candidate => candidate.id !== active.id && accountHasStandardCapacity(candidate))
    .map(candidate => ({ candidate, rank: codexReplacementRank(activeIdentity, codexIdentity(candidate.credential)) }))
    .filter((entry): entry is { readonly candidate: StoredAccount; readonly rank: number } => entry.rank !== undefined)
    .sort((left, right) => standardUsagePressure(left.candidate) - standardUsagePressure(right.candidate)
      || left.rank - right.rank
      || left.candidate.createdAt - right.candidate.createdAt)[0]?.candidate
}

function codexReplacementRank(
  active: ReturnType<typeof codexIdentity>,
  candidate: ReturnType<typeof codexIdentity>,
): number | undefined {
  if (active.accountId !== undefined && active.accountId === candidate.accountId) return 0
  if (active.ownerId === candidate.ownerId) return 1
  return active.usageScope === 'personal' && candidate.usageScope === 'personal' ? 2 : undefined
}

function standardUsagePressure(account: StoredAccount): number {
  return Math.max(...standardUsageWindows(account).map(window => window.usedPercent))
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
  const codex = account.provider === 'openai-codex' ? codexIdentity(account.credential) : undefined
  return {
    id: account.id,
    provider: account.provider,
    ownerId: codex?.ownerId ?? account.id,
    name: account.name,
    ...account.detail === undefined ? {} : { detail: account.detail },
    initials: accountInitials(account.name),
    active: account.id === activeAccountId,
    authMode: account.authMode,
    ...codex?.usageScope === undefined ? {} : { usageScope: codex.usageScope },
    ...account.usage === undefined ? {} : { usage: account.usage },
    ...account.usageUpdatedAt === undefined ? {} : { usageUpdatedAt: account.usageUpdatedAt },
    ...account.usageError === undefined ? {} : { usageError: account.usageError },
    ...account.manualBillingDate === undefined ? {} : { manualBillingDate: account.manualBillingDate },
  }
}

function codexIdentity(record: CredentialRecord): {
  readonly id: string
  readonly ownerId: string
  readonly name: string
  readonly detail?: string
  readonly accountId?: string
  readonly usageScope?: AccountUsageScope
} {
  const oauth = oauthCredential(record)
  if (oauth === undefined) {
    const stable = JSON.stringify(record)
    return {
      id: opaqueAccountId(stable),
      ownerId: opaqueOwnerId(stable),
      name: 'Codex account',
    }
  }
  const payload = decodeJwtPayload(oauth.access)
  const profile = objectMember(payload, PROFILE_CLAIM)
  const auth = objectMember(payload, AUTH_CLAIM)
  const email = boundedText(profile.email, 320)
  const accountId = boundedText(oauth.accountId, 256) ?? boundedText(auth.chatgpt_account_id, 256)
  const person = boundedText(auth.chatgpt_user_id, 256)
    ?? email
    ?? boundedText(payload.sub, 256)
    ?? oauth.refresh
  // A ChatGPT account id identifies a workspace and is shared by all of its
  // members. Pair it with the person id so two seats cannot overwrite each
  // other, while the owner id still groups that person's Personal and
  // Workspace memberships in the client.
  const membership = `${person}\0${accountId ?? 'personal'}`
  const name = boundedText(profile.name, 160) ?? email?.split('@', 1)[0] ?? 'OpenAI account'
  const planType = boundedText(auth.chatgpt_plan_type, 80)
  const plan = planType?.toLocaleUpperCase()
  const detail = [email, plan].filter(Boolean).join(' · ') || undefined
  const usageScope = codexUsageScope(planType)
  return {
    id: opaqueAccountId(membership),
    ownerId: opaqueOwnerId(person),
    name,
    ...detail === undefined ? {} : { detail },
    ...accountId === undefined ? {} : { accountId },
    ...usageScope === undefined ? {} : { usageScope },
  }
}

function opaqueAccountId(stable: string): string {
  return `acc_${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`
}

function opaqueOwnerId(stable: string): string {
  return `owner_${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`
}

function codexUsageScope(planType: string | undefined): AccountUsageScope | undefined {
  if (planType === undefined) return undefined
  return /^(?:business|edu|enterprise|self[_-]serve[_-]business|team)$/iu.test(planType)
    ? 'workspace'
    : 'personal'
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
  return payload as OAuthCredential
}

function codexUsageHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'Harnessy',
    ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
  }
}

function extractCodexUsage(payload: unknown, nowMs: number): AccountUsageView {
  const root = isRecord(payload) ? payload : {}
  const windows = [
    ...rateLimitWindows(root.rate_limit, '', 'standard', nowMs),
    ...rateLimitWindows(root.code_review_rate_limit, 'Code review', 'code-review', nowMs),
  ]
  const resetCredits = decodeResetCredits(root.rate_limit_reset_credits)
  return { windows, ...resetCredits === undefined ? {} : { resetCredits } }
}

function decodeResetCredits(value: unknown): AccountResetCreditsView | undefined {
  if (!isRecord(value)) return undefined
  const available = finite(value.available_count) ?? finite(value.availableCount)
  if (available === undefined || !Number.isSafeInteger(available) || available < 0) return undefined
  return { availableCount: available }
}

function decodeResetCreditId(value: unknown): AccountResetCreditId | undefined {
  if (typeof value !== 'string' || value.length > 256 || value.trim().length === 0) return undefined
  return brandString<AccountResetCreditId>(value)
}

function decodeResetCreditList(payload: unknown): AccountResetCreditList {
  if (!isRecord(payload) || !Array.isArray(payload.credits)) throw unavailable('the reset credit service returned unreadable details')
  const ids = new Set<string>()
  const credits: AccountResetCreditView[] = payload.credits.map((value: unknown) => {
    if (!isRecord(value)) throw unavailable('the reset credit service returned an unreadable credit')
    const id = decodeResetCreditId(value.id)
    const resetType = boundedText(value.reset_type, 128)
    const status = boundedText(value.status, 128)
    const expiresAtMs = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : undefined
    if (id === undefined || resetType === undefined || status === undefined || ids.has(id)
      || (value.expires_at !== null && value.expires_at !== undefined
        && (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)))) {
      throw unavailable('the reset credit service returned an unreadable credit')
    }
    ids.add(id)
    const title = boundedText(value.title, 160)
    return { id, resetType, status,
      ...expiresAtMs === undefined ? {} : { expiresAtMs },
      ...title === undefined ? {} : { title } }
  })
  return { credits }
}

function decodeResetCreditOutcome(payload: unknown): AccountResetCreditOutcome {
  const raw = isRecord(payload) ? payload.code ?? payload.outcome ?? payload.status : undefined
  if (raw === 'reset') return 'reset'
  if (raw === 'nothing_to_reset' || raw === 'nothingToReset') return 'nothing-to-reset'
  if (raw === 'no_credit' || raw === 'noCredit') return 'no-credit'
  if (raw === 'already_redeemed' || raw === 'alreadyRedeemed') return 'already-redeemed'
  throw unavailable('the reset credit service returned an unknown outcome')
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  return JSON.parse(JSON.stringify(value))
}

function sameRecord(left: CredentialRecord | undefined, right: CredentialRecord | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function replaceRecord(
  credentials: CredentialProvider,
  key: CredentialKey,
  expected: CredentialRecord | undefined,
  next: CredentialRecord | undefined,
): Promise<void> {
  if (next === undefined) {
    if (!sameRecord(await credentials.readRecord(key), expected)) throw unavailable('account credential changed during selection')
    await credentials.deleteRecord(key)
    return
  }
  await credentials.modifyRecord(key, (current) => {
    if (!sameRecord(current, expected)) throw unavailable('account credential changed during selection')
    return Promise.resolve(next)
  })
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
