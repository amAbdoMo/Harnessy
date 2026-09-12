import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccountProviderId, AccountProviderView, AccountsState, AccountUsageWindow, ManagedAccountView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { createAccountsMenuStore } from './accounts-menu-store.ts'
import css from './AccountsManagerCard.module.css'

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
  const active = accounts.find(account => account.active)
  const total = state?.accounts.length ?? 0

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
                  {accounts.map(account => (
                    <AccountCard key={account.id} account={account} provider={provider}
                      busy={busyAccount === account.id} editing={editing === account.id} editName={editName}
                      onEditName={setEditName} onActivate={() => { void activate(account) }}
                      onBeginEdit={() => { setEditing(account.id); setEditName(account.name) }}
                      onCancelEdit={() => { setEditing(undefined) }} onSaveName={() => { void saveName(account) }}
                      onRemove={() => { void remove(account) }} t={t} />
                  ))}
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

function AccountCard({ account, provider, busy, editing, editName, onEditName, onActivate, onBeginEdit,
  onCancelEdit, onSaveName, onRemove, t }: {
  readonly account: ManagedAccountView
  readonly provider: AccountProviderView | undefined
  readonly busy: boolean
  readonly editing: boolean
  readonly editName: string
  readonly onEditName: (value: string) => void
  readonly onActivate: () => void
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
        ? <UsageGrid account={account} t={t} />
        : <p className={css.usageUnavailable}>{t('accountsUsageUnavailable')}</p>}
    </article>
  )
}

function UsageGrid({ account, t }: {
  readonly account: ManagedAccountView
  readonly t: AccountsManagerCardProps['t']
}) {
  const windows = account.usage?.windows ?? []
  if (windows.length === 0) {
    return <p className={css.usageUnavailable}>{account.usageError ?? t('accountsUsagePending')}</p>
  }
  return (
    <div className={css.usageGrid}>
      {windows.map(window => <UsageBar key={window.id} window={window} t={t} />)}
    </div>
  )
}

function UsageBar({ window, t }: {
  readonly window: AccountUsageWindow
  readonly t: AccountsManagerCardProps['t']
}) {
  const target = Math.round(window.usedPercent)
  const [width, setWidth] = useState(0)
  const reset = useMemo(() => window.resetsAtMs === undefined
    ? undefined
    : new Date(window.resetsAtMs).toLocaleString(undefined, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }), [window.resetsAtMs])
  useEffect(() => {
    setWidth(0)
    const frame = requestAnimationFrame(() => { setWidth(target) })
    return () => { cancelAnimationFrame(frame) }
  }, [target])
  return (
    <div className={css.usageItem}>
      <div className={css.usageLabel}><span>{window.label}</span><strong>{target}% {t('accountsUsedSuffix')}</strong></div>
      <div className={css.usageTrack} role="progressbar" aria-label={`${window.label} ${t('accountsUsageLabelSuffix')}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={target}>
        <span className={css.usageFill} style={{ width: `${String(width)}%` }} />
      </div>
      {reset === undefined ? null : <span className={css.resetTime}>{t('accountsResetsPrefix')} {reset}</span>}
    </div>
  )
}

function managerIsOpen(managerOpen: { readonly current: boolean }): boolean {
  return managerOpen.current
}
