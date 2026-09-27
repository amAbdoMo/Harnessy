/**
 * General Settings row: the installed release version plus the Desktop-only
 * update check. The check capability is absent in a browser, where the row
 * keeps the version label alone.
 */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateView } from '../types.ts'
import { updateBusy } from './desktop-update-copy.ts'
import css from './UpdateRow.module.css'

/** Carrier status and the optional Desktop-only check request. */
export interface UpdateRowInjected {
  hooks: { desktopUpdate: ObservableSnapshot<DesktopUpdateView> }
  /** Ask the shell for an immediate check; absent where no Desktop carrier exists. */
  check?: () => Promise<void>
}

/**
 * Render the installed version and, in Desktop, the check action.
 * @param props - carrier status, optional check request, and localized copy.
 * @returns the General Settings row, or nothing when the build has neither.
 */
export function UpdateRow({ useDesktopUpdate, check, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<UpdateRowInjected>) {
  const view = useDesktopUpdate(value => value)
  const [pending, setPending] = useState(false)
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined && check === undefined) return null
  // The request only resolves once the shell answered, so the local flag covers
  // the gap before its first `checking` presentation arrives.
  const checking = pending || view.presentation?.phase === 'checking'
  const busy = pending || updateBusy(view.presentation?.phase ?? 'idle')
  return <div className={css.row}>
    {version !== undefined && <div className={css.version}>{t('general.currentVersion', { version })}</div>}
    {check !== undefined && <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => {
        setPending(true)
        void check().finally(() => { setPending(false) })
      }}
    >
      {checking ? t('general.checkingForUpdates') : t('general.checkForUpdates')}
    </Button>}
  </div>
}
