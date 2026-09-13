import { useEffect, useRef, useState } from 'react'
import type {
  AccountsState, AccountUsageWindow, ManagedAccountView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconChevronUpOutline14,
  IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { createAccountsMenuStore } from './accounts-menu-store.ts'
import css from './AccountLauncher.module.css'

/** Private account query supplied by the Harnessy browser plugin. */
export interface AccountLauncherInjected {
  hooks: {
    accountUsage: ObservableSnapshot<AccountsState | undefined>
  }
  refreshAccounts: () => void
}

/** Complete props for the Harnessy sidebar account launcher. */
export type AccountLauncherProps = PropsRuntime<'settings.launcher'>
  & PropsStore<ReturnType<typeof createAccountsMenuStore>>
  & PropsLocale<'customHarnessBrand'>
  & InjectFace<AccountLauncherInjected>

function activeCodexAccount(state: AccountsState | undefined): ManagedAccountView | undefined {
  return state?.accounts.find(account => account.provider === 'openai-codex' && account.active)
}

function accountSubtitle(account: ManagedAccountView | undefined, fallback: string, template: string): string {
  const plan = account?.detail?.split('·').at(-1)?.trim().toLocaleUpperCase()
  return template.replace('{plan}', plan === undefined || plan === '' ? fallback : plan)
}

function compactUsageWindows(account: ManagedAccountView | undefined): readonly AccountUsageWindow[] {
  return account?.usage?.windows.filter(window => window.label === '5h' || window.label === '7d') ?? []
}

function usageLevel(usedPercent: number): 'normal' | 'warning' | 'danger' {
  if (usedPercent >= 95) return 'danger'
  return usedPercent >= 80 ? 'warning' : 'normal'
}

function CompactUsageMeter({ window }: { readonly window: AccountUsageWindow }) {
  const target = Math.round(window.usedPercent)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    setWidth(0)
    const frame = requestAnimationFrame(() => { setWidth(target) })
    return () => { cancelAnimationFrame(frame) }
  }, [target])
  return (
    <span className={css.compactUsageItem}>
      <span className={css.compactUsageLabel}><span>{window.label}</span><strong>{target}%</strong></span>
      <span className={css.compactUsageTrack} aria-hidden="true">
        <span className={css.compactUsageFill} data-level={usageLevel(target)} style={{ width: `${String(width)}%` }} />
      </span>
    </span>
  )
}

function AccountSummary({ name, subtitle, windows }: {
  readonly name: string
  readonly subtitle: string
  readonly windows: readonly AccountUsageWindow[]
}) {
  return (
    <span className={css.accountSummary}>
      <span className={css.identity}><strong>{name}</strong><span>{subtitle}</span></span>
      {windows.length === 0 ? null : (
        <span className={css.compactUsage}>
          {windows.map(window => <CompactUsageMeter key={window.id} window={window} />)}
        </span>
      )}
    </span>
  )
}

/** Render the active account footer and its compact account/settings menu. */
export function AccountLauncher({
  wide, openSettings, openSection, useAccountUsage, refreshAccounts, actions, t,
}: AccountLauncherProps) {
  const accountState = useAccountUsage(state => state)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const account = activeCodexAccount(accountState)
  const name = account?.name ?? t('accountsNone')
  const initials = account?.initials ?? 'H'
  const subtitle = accountSubtitle(account, t('accountsOAuthAccount'), t('accountsCodexSummary'))
  const usageWindows = compactUsageWindows(account)
  const accessibleName = [name, subtitle, ...usageWindows.map(window =>
    `${window.label} ${String(Math.round(window.usedPercent))}% ${t('accountsUsedSuffix')}`)].join(', ')

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const toggleMenu = (): void => {
    if (!open) refreshAccounts()
    setOpen(current => !current)
  }
  const openAccounts = (): void => {
    actions.requestManager()
    openSection('models')
    setOpen(false)
  }
  const openSettingsPanel = (): void => {
    openSettings()
    setOpen(false)
  }

  return (
    <div ref={root} className={wide ? css.root : css.railRoot}>
      {open && (
        <div className={css.menu} role="menu" aria-label={t('accountsMenuLabel')}>
          <button type="button" className={css.accountMenuItem} role="menuitem"
            aria-label={accessibleName} onClick={openAccounts}>
            <span className={css.avatar}>{initials}</span>
            <AccountSummary name={name} subtitle={subtitle} windows={usageWindows} />
            <IconChevronRightOutline14 className={css.chevron} />
          </button>
          <div className={css.separator} />
          <button type="button" className={css.settingsMenuItem} role="menuitem" onClick={openSettingsPanel}>
            <IconSettingsOutline16 size={16} />
            <span>{t('accountsSettings')}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={wide ? css.trigger : css.railTrigger}
        aria-label={wide ? accessibleName : `${t('accountsOpenMenu')}: ${accessibleName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={wide ? undefined : name}
        onClick={toggleMenu}
      >
        <span className={css.avatar}>{initials}</span>
        {wide && (
          <>
            <AccountSummary name={name} subtitle={subtitle} windows={usageWindows} />
            {open
              ? <IconChevronUpOutline14 className={css.chevron} />
              : <IconChevronDownOutline14 className={css.chevron} />}
          </>
        )}
      </button>
    </div>
  )
}
