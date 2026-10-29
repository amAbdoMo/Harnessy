/** Compact tab ownership control beside the address bar. */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconPauseOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Browser.module.css'

/** Change native control while keeping a failed takeover visible. */
export function BrowserControl({ humanControl, control, disabled, t }: {
  readonly humanControl: boolean | undefined
  readonly control: (human: boolean) => Promise<void>
  readonly disabled?: boolean
  readonly t: TranslateNS<'sidebarBrowser'>
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (humanControl === undefined) return null
  return <><button type="button" className={css.tool} disabled={busy || disabled}
    aria-pressed={humanControl}
    aria-label={t(humanControl ? 'control.resume' : 'control.takeover')}
    title={t(failed ? 'control.failed' : humanControl ? 'control.resume' : 'control.takeover')}
    onClick={() => {
      setBusy(true)
      setFailed(false)
      void control(!humanControl).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
    }}>{humanControl ? <IconPlayOutlineRegular /> : <IconPauseOutlineRegular />}</button>
  {failed && <span role="alert" className={css.feedbackFailure}>{t('control.failed')}</span>}</>
}
