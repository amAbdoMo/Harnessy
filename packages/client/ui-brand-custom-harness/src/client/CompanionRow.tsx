/** General-settings card for native companion status and collapsed setup guidance. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronRightOutlineRegular, IconPhoneOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompanionState } from './companion.ts'
import css from './CompanionRow.module.css'

/** Plugin-owned public status and native management callbacks. */
export interface CompanionRowInjected {
  readonly hooks: { readonly companion: ObservableSnapshot<CompanionState> }
  readonly describe: () => Promise<void>
  readonly open: () => Promise<void>
}

/** Renderer-composed General-settings props. */
export type CompanionRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'customHarnessBrand'> & InjectFace<CompanionRowInjected>

/**
 * Show public status and native actions, keeping errors outside collapsed guidance.
 * @param props - Framework-bound status, native callbacks, and localized copy.
 * @returns the native companion settings card.
 */
export function CompanionRow({ useCompanion, describe, open, t }: CompanionRowProps) {
  const state = useCompanion(snapshot => snapshot)
  const status = state.status
  return <div className={css.frame}><section className={css.root} aria-label={t('companionTitle')} aria-busy={state.busy !== undefined}>
    <header className={css.header}>
      <span className={css.iconTile}><IconPhoneOutlineRegular size={28} /></span>
      <div className={css.heading}>
        <h3 className={css.title}>{t('companionTitle')}</h3>
        <p className={css.summary}>{t('companionDescription')}</p>
      </div>
    </header>
    <div className={css.body}>
      <div className={css.status}>
        {status !== undefined && <>
          <div className={css.statusLine}>
            <p className={css.statusPill} role="status" data-state={!status.available ? 'unavailable'
              : status.connected ? 'connected' : 'disconnected'}>
              <StateDot state={!status.available ? 'warning' : status.connected ? 'done' : 'idle'} />
              {t(!status.available ? 'companionUnavailable'
                : status.connected ? 'companionConnected' : 'companionDisconnected')}
            </p>
            {status.available && <p className={css.summary}>{t('companionPairedCount', { count: status.pairedCount })}</p>}
          </div>
          {!status.available && <p className={css.summary}>{t('companionSetupAttention')}</p>}
        </>}
      </div>
      <div className={css.actions}>
        <Button variant="primary" className={css.action} disabled={state.busy !== undefined}
          onClick={() => { void open() }}>{t('companionOpen')}</Button>
        <Button variant="outline" className={css.action} disabled={state.busy !== undefined}
          onClick={() => { void describe() }}>{t('companionRefresh')}</Button>
      </div>
    </div>
    <div className={css.feedback}>
      {state.busy !== undefined && <div className={css.loading}><StateDot state="ongoing" /></div>}
      {state.error !== undefined && <p className={css.error} role="alert">
        {t(state.error === 'read' ? 'companionReadFailed' : 'companionOpenFailed')}
      </p>}
    </div>
    <details className={css.disclosure}>
      <summary className={css.disclosureSummary}>
        <span>{t('companionRequirements')}</span>
        <IconChevronRightOutlineRegular className={css.chevron} />
      </summary>
      <div className={css.guidance}>
        {status !== undefined && !status.available && <p className={css.summary}>{t('companionUnavailableDetails')}</p>}
        <p className={css.summary}>{t('companionPairing')}</p>
        <p className={css.summary}>{t('companionAuthority')}</p>
        <p className={css.summary}>{t('companionKeepAwake')}</p>
      </div>
    </details>
  </section></div>
}
