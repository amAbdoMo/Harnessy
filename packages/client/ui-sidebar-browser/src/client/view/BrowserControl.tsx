/** Compact tab ownership control beside the address bar. */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import css from './Browser.module.css'

/** Change native control while keeping a failed takeover visible. */
export function BrowserControl({ humanControl, control, t }: {
  readonly humanControl: boolean | undefined
  readonly control: (human: boolean) => Promise<void>
  readonly t: TranslateNS<'sidebarBrowser'>
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (humanControl === undefined) return null
  return <button type="button" className={css.controlButton} disabled={busy}
    aria-label={t(humanControl ? 'control.resume' : 'control.takeover')}
    title={t(failed ? 'control.failed' : humanControl ? 'control.resume' : 'control.takeover')}
    onClick={() => {
      setBusy(true)
      setFailed(false)
      void control(!humanControl).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
    }}>{t(failed ? 'control.failed' : humanControl ? 'control.resume' : 'control.takeover')}</button>
}
