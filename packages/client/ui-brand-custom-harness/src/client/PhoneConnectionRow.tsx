/** General-settings phone connection row and application-owned clipboard toast. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PhoneConnectionNotice, PhoneConnectionState } from './phone-connection.ts'
import css from './PhoneConnectionRow.module.css'

/** Credential-free desktop data and actions projected by the plugin registration. */
export interface PhoneConnectionRowInjected {
  readonly hooks: { readonly phoneConnection: ObservableSnapshot<PhoneConnectionState> }
  readonly describe: () => Promise<void>
  readonly copy: () => Promise<void>
}

/** Renderer-composed General-settings props. */
export type PhoneConnectionRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'customHarnessBrand'> & InjectFace<PhoneConnectionRowInjected>

/**
 * Display private-network setup or a credential-free root, never the pairing URL.
 * @param props - Renderer-bound desktop state, callbacks, and localized product copy.
 * @returns the desktop phone connection row.
 */
export function PhoneConnectionRow({ usePhoneConnection, describe, copy, t }: PhoneConnectionRowProps) {
  const state = usePhoneConnection(snapshot => snapshot)
  return <section className={css.root} aria-label={t('phoneConnectionTitle')}>
    <h3 className={css.title}>{t('phoneConnectionTitle')}</h3>
    <p className={css.summary}>{t('phoneConnectionDescription')}</p>
    {state.status === 'loading' && <div className={css.loading} aria-busy="true"><StateDot state="ongoing" /></div>}
    {state.status === 'unavailable' && <div className={css.actions}>
      <p className={css.error} role="alert">{t('phoneConnectionReadFailed')}</p>
      <Button size="sm" variant="outline" onClick={() => { void describe() }}>{t('retry')}</Button>
    </div>}
    {state.status === 'disabled' && <div className={css.details}>
      <p className={css.summary}>{t('phoneConnectionDisabled')}</p>
      <p className={css.summary}>{t('phoneConnectionSetup')}</p>
      <p className={css.summary}>{t('phoneConnectionPrivateServe')}</p>
    </div>}
    {state.status === 'enabled' && <div className={css.details}>
      <div className={css.actions}>
        <code className={css.remoteRoot}>{state.remoteRoot}</code>
        <Button size="sm" variant="outline" disabled={state.copying} onClick={() => { void copy() }}>
          {t('phoneConnectionCopy')}
        </Button>
      </div>
      <p className={css.summary}>{t('phoneConnectionOpenOnPhone')}</p>
    </div>}
    <p className={css.warning}>{t('phoneConnectionAccessWarning')}</p>
    <p className={css.warning}>{t('phoneConnectionClipboardWarning')}</p>
  </section>
}

/** Root-owned clipboard outcomes remain visible after settings close. */
export interface PhoneConnectionToastInjected {
  readonly hooks: { readonly phoneConnectionNotice: ObservableSnapshot<PhoneConnectionNotice | undefined> }
  readonly dismiss: (id: string) => void
}

/** Renderer-composed application toast props. */
export type PhoneConnectionToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'customHarnessBrand'> & InjectFace<PhoneConnectionToastInjected>

/**
 * Announce copying without rendering pairing credentials or raw IPC errors.
 * @param props - Renderer-bound outcome, guarded dismissal, and localized copy.
 * @returns the current app-wide toast, or null when no clipboard outcome is pending.
 */
export function PhoneConnectionToast({ usePhoneConnectionNotice, dismiss, t }: PhoneConnectionToastProps) {
  const notice = usePhoneConnectionNotice(snapshot => snapshot)
  if (notice === undefined) return null
  return <Toast key={notice.id}
    text={notice.outcome === 'copied' ? t('phoneConnectionCopied') : t('phoneConnectionCopyFailed')}
    {...(notice.outcome === 'copied' ? { tone: 'success' as const } : {})}
    onDone={() => { dismiss(notice.id) }} />
}
