import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccountProviderId, AccountProviderView, AccountsState, AccountUsageScope, AccountUsageWindow, ManagedAccountView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { createAccountsMenuStore } from './accounts-menu-store.ts'
import { accountUsageLevel } from './account-usage-presentation.ts'
import css from './AccountsManagerCard.module.css'

interface ManagedAccountGroup {
  readonly id: string
  readonly primary: ManagedAccountView
  readonly contexts: readonly ManagedAccountView[]
}

const USAGE_CLOCK_INTERVAL_MS = 30_000

function groupManagedAccounts(accounts: readonly ManagedAccountView[]): readonly ManagedAccountGroup[] {
  const grouped = new Map<string, ManagedAccountView[]>()
  for (const account of accounts) {
    const contexts = grouped.get(account.ownerId) ?? []
    contexts.push(account)
    grouped.set(account.ownerId, contexts)
  }
  return [...grouped].flatMap(([id, contexts]) => {
    const ordered = contexts.sort((left, right) => scopeOrder(left.usageScope) - scopeOrder(right.usageScope))
    const primary = ordered[0]
    return primary === undefined ? [] : [{ id, primary, contexts: ordered }]
  })
}

function scopeOrder(scope: AccountUsageScope | undefined): number {
  if (scope === 'personal') return 0
  return scope === 'workspace' ? 1 : 2
}

function selectedContext(group: ManagedAccountGroup, selectedId: string | undefined): ManagedAccountView {
  return group.contexts.find(account => account.id === selectedId)
    ?? group.contexts.find(candidate => candidate.active)
    ?? group.primary
}

/** Host operations injected by the Harnessy browser plugin. */
export interface AccountsManagerOperations {
  readonly describe: () => Promise<{ readonly state?: AccountsState; readonly error?: string }>
  readonly addOAuth: (provider: AccountProviderId, signal: AbortSignal) => Promise<{
    readonly authorized: boolean
    readonly error?: string
  }>
  readonly addApiKey: (provider: AccountProviderId, name: string, key: string) => Promise<{
    readonly state?: AccountsState
    readonly error?: string
  }>
  readonly activate: (provider: AccountProviderId, accountId: string) => Promise<{
    readonly state?: AccountsState
    readonly error?: string
  }>
  readonly setAutoSwitch: (provider: AccountProviderId, enabled: boolean) => Promise<{
    readonly state?: AccountsState
    readonly error?: string
  }>
  readonly rename: (provider: AccountProviderId, accountId: string, name: string) => Promise<{
    readonly state?: AccountsState
    readonly error?: string
  }>
  readonly remove: (provider: AccountProviderId, accountId: string) => Promise<{
    readonly state?: AccountsState
    readonly error?: string
  }>
  readonly refreshUsage: (signal: AbortSignal) => Promise<{ readonly state?: AccountsState; readonly error?: string }>
}

/** Private operations supplied to the Models-footer occupant. */
export interface AccountsManagerInjected {
  operations: AccountsManagerOperations
}

/** Models-footer props composed by the slot renderer. */
export type AccountsManagerCardProps = PropsRuntime<'settings.models.footer'>
  & PropsStore<ReturnType<typeof createAccountsMenuStore>>
  & PropsLocale<'customHarnessBrand'>
  & AccountsManagerInjected

/** Render the entry card and full multi-provider account manager. */
export function AccountsManagerCard({
  operations, t, presentModal, useStore, actions,
}: AccountsManagerCardProps) {
  const [state, setState] = useState<AccountsState | undefined>()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<AccountProviderId>('openai-codex')
  const [failure, setFailure] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [addingKey, setAddingKey] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [keyValue, setKeyValue] = useState('')
  const [editing, setEditing] = useState<string | undefined>()
  const [editName, setEditName] = useState('')
  const [busyAccount, setBusyAccount] = useState<string | undefined>()
  const [autoSwitching, setAutoSwitching] = useState(false)
  const [selectedContexts, setSelectedContexts] = useState<Readonly<Record<string, string>>>({})
  const attempt = useRef<AbortController | undefined>()
  const managerOpen = useRef(false)
  const finishSettingsModal = useRef<(() => void) | undefined>()
  const managerRequested = useStore(snapshot => snapshot.managerRequested)

  const load = useCallback(async (): Promise<AccountsState | undefined> => {
    const result = await operations.describe()
    if (result.state !== undefined) setState(result.state)
    setFailure(result.error)
    return result.state
  }, [operations])

  useEffect(() => {
    let alive = true
    void operations.describe().then((result) => {
      if (!alive) return
      setState(result.state)
      setFailure(result.error)
    })
    return () => {
      alive = false
      managerOpen.current = false
      attempt.current?.abort()
    }
  }, [operations])

  const openManager = useCallback(async (): Promise<void> => {
    managerOpen.current = true
    finishSettingsModal.current ??= presentModal()
    setOpen(true)
    setFailure(undefined)
    const snapshot = await load()
    if (snapshot === undefined || !managerIsOpen(managerOpen)) return
    const controller = new AbortController()
    attempt.current = controller
    setRefreshing(true)
    const result = await operations.refreshUsage(controller.signal)
    if (attempt.current !== controller) return
    attempt.current = undefined
    setRefreshing(false)
    if (result.state !== undefined) setState(result.state)
    if (result.error !== undefined) setFailure(result.error)
  }, [load, operations, presentModal])

  useEffect(() => {
    if (!managerRequested) return
    actions.consumeManagerRequest()
    void openManager()
  }, [actions, managerRequested, openManager])

  const closeManager = (): void => {
    managerOpen.current = false
    attempt.current?.abort()
    attempt.current = undefined
    setRefreshing(false)
    setSigningIn(false)
    setAddingKey(false)
    setOpen(false)
    const finish = finishSettingsModal.current
    finishSettingsModal.current = undefined
    finish?.()
  }

  const provider = state?.providers.find(candidate => candidate.id === selected)
  const accounts = state?.accounts.filter(account => account.provider === selected) ?? []
  const accountGroups = groupManagedAccounts(accounts)
  const active = accounts.find(account => account.active)
  const total = state === undefined ? 0 : new Set(state.accounts.map(account => account.ownerId)).size

  const refresh = async (): Promise<void> => {
    const controller = new AbortController()
    attempt.current = controller
    setFailure(undefined)
    setRefreshing(true)
    const result = await operations.refreshUsage(controller.signal)
    if (attempt.current !== controller) return
    attempt.current = undefined
    setRefreshing(false)
    if (result.state !== undefined) setState(result.state)
    if (result.error !== undefined) setFailure(result.error)
  }

  const addOAuth = async (): Promise<void> => {
    if (provider === undefined) return
    const controller = new AbortController()
    attempt.current = controller
    setFailure(undefined)
    setSigningIn(true)
    const result = await operations.addOAuth(provider.id, controller.signal)
    if (attempt.current !== controller) return
    attempt.current = undefined
    setSigningIn(false)
    if (result.error !== undefined) setFailure(result.error)
    if (result.authorized) {
      await load()
      if (provider.usageAvailable && managerOpen.current) await refresh()
    }
  }

  const addApiKey = async (): Promise<void> => {
    if (provider === undefined || keyValue.trim() === '') return
    setFailure(undefined)
    setSigningIn(true)
    const result = await operations.addApiKey(provider.id, keyName, keyValue)
    setSigningIn(false)
    if (result.state !== undefined) {
      setState(result.state)
      setKeyName('')
      setKeyValue('')
      setAddingKey(false)
    }
    if (result.error !== undefined) setFailure(result.error)
  }

  const activate = async (account: ManagedAccountView): Promise<void> => {
    setBusyAccount(account.id)
    setFailure(undefined)
    const result = await operations.activate(account.provider, account.id)
    setBusyAccount(undefined)
    if (result.state !== undefined) setState(result.state)
    if (result.error !== undefined) setFailure(result.error)
  }

  const setAutoSwitch = async (enabled: boolean): Promise<void> => {
    if (provider === undefined) return
    setAutoSwitching(true)
    setFailure(undefined)
    const result = await operations.setAutoSwitch(provider.id, enabled)
    setAutoSwitching(false)
    if (result.state !== undefined) setState(result.state)
    if (result.error !== undefined) setFailure(result.error)
  }

  const saveName = async (account: ManagedAccountView): Promise<void> => {
    if (editName.trim() === '') return
    setBusyAccount(account.id)
    const result = await operations.rename(account.provider, account.id, editName)
    setBusyAccount(undefined)
    if (result.state !== undefined) {
      setState(result.state)
      setEditing(undefined)
    }
    if (result.error !== undefined) setFailure(result.error)
  }

  const remove = async (account: ManagedAccountView): Promise<void> => {
    if (!window.confirm(t('accountsRemoveConfirm'))) return
    setBusyAccount(account.id)
    setFailure(undefined)
    const result = await operations.remove(account.provider, account.id)
    setBusyAccount(undefined)
    if (result.state !== undefined) setState(result.state)
    if (result.error !== undefined) setFailure(result.error)
  }

  return (
    <section className={css.card} aria-label={t('accountsLabel')}>
      <div className={css.cardHeading}>
        <div>
          <h3 className={css.cardTitle}>{t('accountsTitle')}</h3>
          <p className={css.cardDescription}>{t('accountsDescription')}</p>
        </div>
        <Button variant="primary" size="sm" disabled={state === undefined || !state.writable}
          onClick={() => { void openManager() }}>
          {t('accountsManage')}
        </Button>
      </div>
      <p className={css.summary}>{state === undefined
        ? t('accountsLoading')
        : total === 0 ? t('accountsNone') : `${String(total)} ${total === 1 ? t('accountSaved') : t('accountsSaved')}`}</p>
      {failure === undefined || open ? null : <p className={css.error}>{failure}</p>}

      <Modal open={open && !(signingIn && provider?.authMode === 'oauth')} onClose={closeManager}
        title={t('accountsTitle')} closeLabel={t('close')}
        className={css.managerDialog ?? ''} contentClassName={css.managerContent ?? ''}>
        <div className={css.managerLayout}>
          <ProviderRail providers={state?.providers ?? []} selected={selected} t={t} onSelect={(id) => {
            setSelected(id)
            setAddingKey(false)
            setEditing(undefined)
          }} />
          <div className={css.accountPane}>
            <ActiveAccount provider={provider} account={active} t={t} />
            <div className={css.accountToolbar}>
              <div>
                <h4 className={css.sectionTitle}>{provider?.label ?? t('accountsTitle')} {t('accountsTitle')}</h4>
                <p className={css.sectionDescription}>{t('accountsSwitchDescription')}</p>
              </div>
              <div className={css.toolbarActions}>
                <Button variant="outline" size="sm"
                  disabled={refreshing || provider?.usageAvailable !== true || accounts.length === 0}
                  onClick={() => { void refresh() }}>
                  {refreshing ? t('accountsRefreshing') : t('accountsRefresh')}
                </Button>
                <Button variant="primary" size="sm" disabled={provider === undefined || !provider.available || signingIn}
                  onClick={() => {
                    if (provider?.authMode === 'api-key') setAddingKey(true)
                    else void addOAuth()
                  }}>
                  {t('accountsAdd')}
                </Button>
              </div>
            </div>

            {provider?.id === 'openai-codex' && (
              <div className={css.autoSwitchRow}>
                <div className={css.autoSwitchCopy}>
                  <strong>{t('accountsAutoSwitchTitle')}</strong>
                  <p>{t('accountsAutoSwitchDescription')}</p>
                </div>
                <Switch checked={provider.autoSwitchOnLimit} label={t('accountsAutoSwitchToggle')}
                  disabled={autoSwitching || accounts.length < 2}
                  title={accounts.length < 2 ? t('accountsAutoSwitchNeedsAccount') : undefined}
                  onChange={(enabled) => { void setAutoSwitch(enabled) }} />
              </div>
            )}

            {addingKey && provider?.authMode === 'api-key' && (
              <div className={css.keyForm}>
                <Input value={keyName} onChange={(event) => { setKeyName(event.currentTarget.value) }}
                  placeholder={`${provider.label} ${t('accountsNamePlaceholder')}`} aria-label={t('accountsName')} />
                <Input type="password" value={keyValue} onChange={(event) => { setKeyValue(event.currentTarget.value) }}
                  placeholder={t('accountsKeyPlaceholder')} aria-label={t('accountsApiKey')} />
                <div className={css.formActions}>
                  <Button variant="ghost" size="sm" onClick={() => { setAddingKey(false) }}>{t('cancel')}</Button>
                  <Button variant="primary" size="sm" disabled={keyValue.trim() === '' || signingIn}
                    onClick={() => { void addApiKey() }}>{t('accountsSave')}</Button>
                </div>
              </div>
            )}

            {failure === undefined ? null : <p className={css.error}>{failure}</p>}
            {accounts.length === 0
              ? <EmptyAccounts provider={provider} signingIn={signingIn} t={t} />
              : (
                <div className={css.accountList}>
                  {accountGroups.map((group) => {
                    const account = selectedContext(group, selectedContexts[group.id])
                    return <AccountCard key={group.id} account={account} contexts={group.contexts} provider={provider}
                      busy={busyAccount === account.id} editing={editing === account.id} editName={editName}
                      onEditName={setEditName} onActivate={() => { void activate(account) }}
                      onSelectContext={(accountId) => {
                        setSelectedContexts(current => ({ ...current, [group.id]: accountId }))
                        setEditing(undefined)
                      }}
                      onBeginEdit={() => { setEditing(account.id); setEditName(account.name) }}
                      onCancelEdit={() => { setEditing(undefined) }} onSaveName={() => { void saveName(account) }}
                      onRemove={() => { void remove(account) }} t={t} />
                  })}
                </div>
              )}
            <p className={css.privacy}>{t('accountsPrivacy')}</p>
          </div>
        </div>
      </Modal>

      <Modal open={signingIn && provider?.authMode === 'oauth'} onClose={() => {
        attempt.current?.abort()
        attempt.current = undefined
        setSigningIn(false)
      }} title={`${t('accountsSignInTo')} ${provider?.label ?? ''}`} closeLabel={t('close')}
      description={t('accountsBrowserDescription')}
      footer={<Button variant="outline" onClick={() => {
        attempt.current?.abort(); attempt.current = undefined; setSigningIn(false)
      }}>{t('cancel')}</Button>}>
        <p className={css.waiting}>{t('accountsBrowserWaiting')}</p>
      </Modal>
    </section>
  )
}

function ProviderRail({ providers, selected, onSelect, t }: {
  readonly providers: readonly AccountProviderView[]
  readonly selected: AccountProviderId
  readonly onSelect: (id: AccountProviderId) => void
  readonly t: AccountsManagerCardProps['t']
}) {
  return (
    <nav className={css.providerRail} aria-label={t('accountsProviderNavigation')}>
      {providers.map(provider => (
        <button key={provider.id} type="button" className={provider.id === selected ? css.providerActive : css.provider}
          onClick={() => { onSelect(provider.id) }}>
          <span className={css.providerMark} aria-hidden="true">{provider.label.slice(0, 1)}</span>
          <span>{provider.label}</span>
          {provider.accountCount > 0 && <span className={css.providerCount} aria-hidden="true">{provider.accountCount}</span>}
        </button>
      ))}
    </nav>
  )
}

function ActiveAccount({ provider, account, t }: {
  readonly provider: AccountProviderView | undefined
  readonly account: ManagedAccountView | undefined
  readonly t: AccountsManagerCardProps['t']
}) {
  return (
    <div className={css.activeHero}>
      <span className={css.eyebrow}>{t('accountsActiveEyebrow')} {provider?.label.toLocaleUpperCase() ?? ''}</span>
      <strong className={css.activeName}>{account?.name ?? t('accountsNoActive')}</strong>
      <span className={css.activeDetail}>{account?.detail ?? t('accountsAddToActivate')}</span>
    </div>
  )
}

function EmptyAccounts({ provider, signingIn, t }: {
  readonly provider: AccountProviderView | undefined
  readonly signingIn: boolean
  readonly t: AccountsManagerCardProps['t']
}) {
  return (
    <div className={css.empty}>
      <span className={css.emptyMark}>{provider?.label.slice(0, 1) ?? ''}</span>
      <strong>{signingIn ? t('accountsWaitingSignIn')
        : `${t('accountsNoProviderPrefix')} ${provider?.label ?? ''} ${t('accountsNoProviderSuffix')}`}</strong>
      <span>{provider?.authMode === 'api-key' ? t('accountsAddKeyHint') : t('accountsAddBrowserHint')}</span>
    </div>
  )
}

function AccountCard({ account, contexts, provider, busy, editing, editName, onEditName, onActivate, onSelectContext, onBeginEdit,
  onCancelEdit, onSaveName, onRemove, t }: {
  readonly account: ManagedAccountView
  readonly contexts: readonly ManagedAccountView[]
  readonly provider: AccountProviderView | undefined
  readonly busy: boolean
  readonly editing: boolean
  readonly editName: string
  readonly onEditName: (value: string) => void
  readonly onActivate: () => void
  readonly onSelectContext: (accountId: string) => void
  readonly onBeginEdit: () => void
  readonly onCancelEdit: () => void
  readonly onSaveName: () => void
  readonly onRemove: () => void
  readonly t: AccountsManagerCardProps['t']
}) {
  return (
    <article className={account.active ? css.accountActive : css.account}>
      <div className={css.accountHeader}>
        <span className={css.avatar}>{account.initials}</span>
        <div className={css.accountIdentity}>
          {editing
            ? <Input value={editName} onChange={(event) => { onEditName(event.currentTarget.value) }} aria-label={t('accountsName')} />
            : <strong>{account.name}</strong>}
          <span>{account.detail ?? `${provider?.label ?? ''} ${account.authMode === 'oauth'
            ? t('accountsOAuthAccount') : t('accountsApiKeyAccount')}`}</span>
          {account.active && <span className={css.activePill}>{t('accountsActive')}</span>}
        </div>
        <div className={css.accountActions}>
          {account.active
            ? <Button variant="toolbar" size="sm" disabled>{t('accountsActive')}</Button>
            : <Button variant="primary" size="sm" disabled={busy} onClick={onActivate}>{t('accountsSwitch')}</Button>}
          {editing
            ? (
              <>
                <Button variant="ghost" size="sm" onClick={onCancelEdit}>{t('cancel')}</Button>
                <Button variant="outline" size="sm" disabled={busy || editName.trim() === ''}
                  onClick={onSaveName}>{t('accountsSave')}</Button>
              </>
            )
            : (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={onBeginEdit}>{t('accountsRename')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>{t('accountsRemove')}</Button>
              </>
            )}
        </div>
      </div>
      {provider?.usageAvailable
        ? (
          <div className={css.usageSection}>
            <UsageScopeSwitch contexts={contexts} selected={account.id} onSelect={onSelectContext} t={t} />
            <UsageGrid account={account} t={t} />
          </div>
        )
        : <p className={css.usageUnavailable}>{t('accountsUsageUnavailable')}</p>}
    </article>
  )
}

function UsageScopeSwitch({ contexts, selected, onSelect, t }: {
  readonly contexts: readonly ManagedAccountView[]
  readonly selected: string
  readonly onSelect: (accountId: string) => void
  readonly t: AccountsManagerCardProps['t']
}) {
  const scoped = contexts.filter((context): context is ManagedAccountView & { readonly usageScope: AccountUsageScope } =>
    context.usageScope !== undefined)
  if (!scoped.some(context => context.usageScope === 'personal')
    || !scoped.some(context => context.usageScope === 'workspace')) return null
  return (
    <div className={css.scopeSwitch} role="group" aria-label={t('accountsUsageScope')}>
      {scoped.map(context => (
        <button key={context.id} type="button" className={context.id === selected ? css.scopeActive : css.scopeOption}
          aria-pressed={context.id === selected} onClick={() => { onSelect(context.id) }}>
          {context.usageScope === 'personal' ? t('accountsUsagePersonal') : t('accountsUsageWorkspace')}
        </button>
      ))}
    </div>
  )
}

function UsageGrid({ account, t }: {
  readonly account: ManagedAccountView
  readonly t: AccountsManagerCardProps['t']
}) {
  const windows = account.usage?.windows ?? []
  const nowMs = useUsageClock(windows.some(window => window.label === '5h' && window.resetsAtMs !== undefined))
  if (windows.length === 0) {
    return <p className={css.usageUnavailable}>{account.usageError ?? t('accountsUsagePending')}</p>
  }
  return (
    <div className={css.usageGrid}>
      {windows.map(window => <UsageBar key={window.id} window={window} nowMs={nowMs} t={t} />)}
    </div>
  )
}

function UsageBar({ window, nowMs, t }: {
  readonly window: AccountUsageWindow
  readonly nowMs: number
  readonly t: AccountsManagerCardProps['t']
}) {
  const target = Math.round(window.usedPercent)
  const reset = usageResetLabel(window, nowMs, t)
  return (
    <div className={css.usageItem}>
      <div className={css.usageLabel}><span>{window.label}</span><strong>{target}% {t('accountsUsedSuffix')}</strong></div>
      <div className={css.usageTrack} role="progressbar" aria-label={`${window.label} ${t('accountsUsageLabelSuffix')}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={target}>
        <span className={css.usageFill} data-level={accountUsageLevel(target)} style={{ width: `${String(target)}%` }} />
      </div>
      {reset === undefined ? null : <span className={css.resetTime}>{reset}</span>}
    </div>
  )
}

function useUsageClock(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    const update = (): void => { setNowMs(Date.now()) }
    const timer = window.setInterval(update, USAGE_CLOCK_INTERVAL_MS)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled])
  return nowMs
}

function usageResetLabel(
  window: AccountUsageWindow,
  nowMs: number,
  t: AccountsManagerCardProps['t'],
): string | undefined {
  if (window.resetsAtMs === undefined) return undefined
  if (window.label === '5h') {
    const totalMinutes = Math.max(0, Math.floor((window.resetsAtMs - nowMs) / 60_000))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const duration = hours === 0 ? `${String(minutes)}m` : `${String(hours)}h ${String(minutes)}m`
    return `${t('accountsResetsInPrefix')} ${duration}`
  }
  const date = new Date(window.resetsAtMs).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${t('accountsResetsPrefix')} ${date}`
}

function managerIsOpen(managerOpen: { readonly current: boolean }): boolean {
  return managerOpen.current
}
