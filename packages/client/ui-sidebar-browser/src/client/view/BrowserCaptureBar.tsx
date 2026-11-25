/** Inline recording status and private browser-share controls. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { useBrowserRecording } from './useBrowserRecording.ts'
import type { useBrowserShare } from './useBrowserShare.ts'
import css from './Browser.module.css'

function download(video: Blob): void {
  const url = URL.createObjectURL(video)
  const link = document.createElement('a')
  link.href = url
  link.download = 'harnessy-browser-recording.webm'
  document.body.append(link)
  try { link.click() }
  finally { link.remove(); setTimeout(() => { URL.revokeObjectURL(url) }, 1000) }
}

/** @param props - current recording and localized controls. @returns Status and local file actions. */
export function BrowserCaptureBar({ recording, t }: PropsLocale<'sidebarBrowser'> & {
  readonly recording: ReturnType<typeof useBrowserRecording>
}): ReactNode {
  const { state, stop, discard } = recording
  if (state === undefined) return null
  return <div className={css.captureBar}>
    <p className={css.captureStatus} role="status">{t(`recording.${state.phase}`)}</p>
    {state.phase === 'starting' && <Button variant="outline" size="sm" onClick={discard}>{t('cancel')}</Button>}
    {state.phase === 'recording' && <Button variant="outline" size="sm" onClick={stop}>{t('recording.stop')}</Button>}
    {state.phase === 'ready' && <>
      <Button variant="primary" size="sm" onClick={() => { download(state.video) }}>{t('recording.save')}</Button>
      <Button variant="outline" size="sm" onClick={discard}>{t('recording.discard')}</Button>
    </>}
  </div>
}

function BrowserShareActions({ url, t, stop }: PropsLocale<'sidebarBrowser'> & {
  readonly url: string
  readonly stop: () => void
}): ReactNode {
  const [copyStatus, setCopyStatus] = useState<'share.copied' | 'share.copyFailed'>()
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(url); setCopyStatus('share.copied') }
    catch (_error: unknown) { setCopyStatus('share.copyFailed') }
  }
  return <>
    <p className={css.captureStatus} role="status">{t(copyStatus ?? 'share.sharing')}</p>
    <Button variant="outline" size="sm" onClick={() => { void copy() }}>{t('share.copy')}</Button>
    <Button variant="outline" size="sm" onClick={stop}>{t('share.stop')}</Button>
  </>
}

/** @param props - current share and localized controls. @returns Status, copy link and stop actions. */
export function BrowserShareBar({ share, t }: PropsLocale<'sidebarBrowser'> & {
  readonly share: ReturnType<typeof useBrowserShare>
}): ReactNode {
  if (share.state === undefined) return null
  return <div className={css.captureBar}>
    {share.state.phase === 'sharing'
      ? <BrowserShareActions key={share.state.url} url={share.state.url} t={t} stop={share.stop} />
      : <p className={css.captureStatus} role="status">{t(`share.${share.state.phase}`)}</p>}
  </div>
}
