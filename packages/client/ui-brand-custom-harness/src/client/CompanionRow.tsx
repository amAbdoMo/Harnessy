/** General-settings entry for status-only native companion management. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompanionState } from './companion.ts'
import css from './PhoneConnectionRow.module.css'

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
 * Show public status without offering renderer-owned pairing or approval actions.
 * @param props - Framework-bound status, native callbacks, and localized copy.
 * @returns the native companion settings row.
 */
export function CompanionRow({ useCompanion, describe, open, t }: CompanionRowProps) {
  const state = useCompanion(snapshot => snapshot)
  const status = state.status
  return <section className={css.root} aria-label={t('companionTitle')} aria-busy={state.busy !== undefined}>
    <h3 className={css.title}>{t('companionTitle')}</h3>
    <p className={css.summary}>{t('companionDescription')}</p>
    <div className={css.details}>
      {status !== undefined && <>
        <p className={css.summary} role="status">{t(!status.available ? 'companionUnavailable'
          : status.connected ? 'companionConnected' : 'companionDisconnected')}</p>
        <p className={css.summary}>{t('companionPairedCount', { count: status.pairedCount })}</p>
      </>}
      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={state.busy !== undefined}
          onClick={() => { void describe() }}>{t('companionRefresh')}</Button>
        <Button size="sm" variant="outline" disabled={state.busy !== undefined}
          onClick={() => { void open() }}>{t('companionOpen')}</Button>
      </div>
      <div className={css.companionFeedback}>
        {state.busy !== undefined && <div className={css.loading}><StateDot state="ongoing" /></div>}
        {state.error !== undefined && <p className={css.error} role="alert">
          {t(state.error === 'read' ? 'companionReadFailed' : 'companionOpenFailed')}
        </p>}
      </div>
    </div>
    <p className={css.summary}>{t('companionPairing')}</p>
    <p className={css.warning}>{t('companionAuthority')}</p>
    <p className={css.warning}>{t('companionKeepAwake')}</p>
  </section>
}
