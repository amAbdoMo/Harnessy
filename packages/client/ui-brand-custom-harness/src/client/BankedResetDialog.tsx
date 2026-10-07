/** Account-scoped reset selection; reading the list never redeems a credit. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountResetCreditId, AccountResetCreditList, AccountResetCreditOutcome, ManagedAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountsManagerCardProps, AccountsManagerOperations } from './AccountsManagerCard.tsx'
import { useUsageClock } from './account-usage-clock.ts'
import css from './BankedResetDialog.module.css'

interface ResetInteraction {
  readonly accountId: string
  readonly controller: AbortController
  pendingCredit: string | undefined
  loading: boolean
}

/** Render the provider's individual credits and redeem only the chosen row. */
export function BankedResetDialog({ account, operations, onClose, t }: {
  readonly account: ManagedAccountView | undefined
  readonly operations: AccountsManagerOperations
  readonly onClose: () => void
  readonly t: AccountsManagerCardProps['t']
}) {
  const accountId = account?.id
  const nowMs = useUsageClock(accountId !== undefined)
  const [list, setList] = useState<AccountResetCreditList | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [pendingCredit, setPendingCredit] = useState<string | undefined>()
  const [settledCredits, setSettledCredits] = useState<ReadonlySet<string>>(new Set())
  const interaction = useRef<ResetInteraction | undefined>()

  const load = async (current: ResetInteraction): Promise<void> => {
    if (current.loading) return
    current.loading = true
    setLoading(true)
    setFailure(undefined)
    const result = await operations.listResetCredits(current.accountId, current.controller.signal)
    if (current.controller.signal.aborted) return
    current.loading = false
    setLoading(false)
    setFailure(result.error)
    if (result.list !== undefined) setList(result.list)
  }

  useEffect(() => {
    setList(undefined)
    setFailure(undefined)
    setPendingCredit(undefined)
    setSettledCredits(new Set())
    if (accountId === undefined) return
    const current: ResetInteraction = { accountId, controller: new AbortController(), pendingCredit: undefined, loading: false }
    interaction.current = current
    void load(current)
    return () => {
      current.controller.abort()
      interaction.current = undefined
    }
  }, [accountId, operations])

  const consume = async (creditId: AccountResetCreditId): Promise<void> => {
    const current = interaction.current
    const credit = list?.credits.find(value => value.id === creditId)
    if (current === undefined || current.pendingCredit !== undefined || current.loading || credit === undefined
      || credit.status !== 'available' || credit.resetType !== 'codex_rate_limits' || settledCredits.has(creditId)
      || (credit.expiresAtMs !== undefined && credit.expiresAtMs <= Date.now())) return
    current.pendingCredit = creditId
    setPendingCredit(creditId)
    const result = await operations.consumeResetCredit(current.accountId, creditId)
    if (current.controller.signal.aborted) return
    current.pendingCredit = undefined
    setPendingCredit(undefined)
    if (result.outcome === 'reset' || result.outcome === 'already-redeemed') {
      setSettledCredits(previous => new Set([...previous, creditId]))
    }
    if (result.outcome !== undefined) await load(current)
  }

  const credits = list?.credits.filter(credit => credit.resetType === 'codex_rate_limits' && credit.status === 'available') ?? []
  return <Modal open={account !== undefined} onClose={onClose} title={t('accountsBankedResets')} closeLabel={t('close')}
    description={account?.name ?? ''} className={css.dialog ?? ''} contentClassName={css.frame ?? ''}>
    <div className={css.content}>
      {loading && list === undefined ? <div className={css.loading} role="status" aria-label={t('accountsBankedResetsLoading')}><StateDot state="ongoing" /></div> : null}
      {failure === undefined ? null : <div className={css.failure} role="alert">
        <span>{t('accountsBankedResetsLoadFailed')}</span>
        <Button variant="outline" size="sm" disabled={loading || pendingCredit !== undefined}
          onClick={() => { if (interaction.current !== undefined) void load(interaction.current) }}>{t('retry')}</Button>
      </div>}
      {list === undefined ? null : credits.length === 0 ? <p className={css.empty}>{t('accountsBankedResetNone')}</p> : <ul className={css.list}>
        {credits.map((credit) => {
          const expiry = credit.expiresAtMs === undefined ? undefined : new Intl.DateTimeFormat(undefined, {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(credit.expiresAtMs)
          const settled = settledCredits.has(credit.id)
          return <li key={credit.id} className={css.row}>
            <div className={css.copy}>
              <strong>{credit.title ?? t('accountsBankedResetFull')}</strong>
              <span>{expiry === undefined ? t('accountsBankedResetExpiryUnknown')
                : t('accountsBankedResetExpires').replace('{date}', expiry)}</span>
            </div>
            <Button variant="outline" size="sm" disabled={loading || pendingCredit !== undefined || settled
              || (credit.expiresAtMs !== undefined && credit.expiresAtMs <= nowMs)}
            aria-label={t('accountsUseBankedResetExpiring').replace('{date}', expiry ?? t('accountsBankedResetExpiryUnknown'))}
            onClick={() => { void consume(credit.id) }}>
              {pendingCredit === credit.id ? t('accountsUsingBankedReset') : settled ? t('accountsBankedResetUsed') : t('accountsUseBankedReset')}
            </Button>
          </li>
        })}
      </ul>}
    </div>
  </Modal>
}

/** Transient reset outcome held outside the account-manager dialog. */
export interface ResetCreditNotice {
  readonly id: string
  readonly outcome?: AccountResetCreditOutcome
  readonly error?: string
}

/** Root-owned toast inputs; closing account dialogs cannot remove the result notice. */
export interface ResetCreditToastInjected {
  readonly hooks: { readonly resetCreditNotice: ObservableSnapshot<ResetCreditNotice | undefined> }
  readonly dismiss: (id: string) => void
}

type ResetCreditToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'customHarnessBrand'> & InjectFace<ResetCreditToastInjected>

/** Announce a settled reset operation using the existing application toast. */
export function ResetCreditToast({ useResetCreditNotice, dismiss, t }: ResetCreditToastProps) {
  const notice = useResetCreditNotice(value => value)
  if (notice === undefined) return null
  const success = notice.error === undefined && notice.outcome === 'reset'
  const text = notice.error !== undefined ? t('accountsBankedResetFailed')
    : success ? t('accountsBankedResetSucceeded')
      : notice.outcome === 'already-redeemed' ? t('accountsBankedResetAlreadyUsed')
        : notice.outcome === 'nothing-to-reset' ? t('accountsBankedResetNothingToReset') : t('accountsBankedResetNone')
  return <Toast key={notice.id} text={text} {...(success ? { tone: 'success' as const } : {})} onDone={() => { dismiss(notice.id) }} />
}
