import { useState } from 'react'
import type { SessionWorkspaceMode } from '../session-workspace.ts'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { createSessionWorkspaceRowStore } from './session-workspace-store.ts'
import css from './SessionWorkspaceRow.module.css'

/** Host-backed actions supplied to the Session workspace settings row. */
export interface SessionWorkspaceRowInjected {
  chooseDirectory: () => Promise<{ path?: string; error?: string }>
  setMode: (mode: SessionWorkspaceMode) => Promise<void>
  useRemoteDirectory: (directory: string) => Promise<void>
}

/** Complete props composed for the Harnessy General-settings row. */
export type SessionWorkspaceRowProps = PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createSessionWorkspaceRowStore>>
  & PropsLocale<'customHarnessBrand'>
  & SessionWorkspaceRowInjected

/** Render the working-directory choice for new ungrouped Sessions. */
export function SessionWorkspaceRow({
  useStore, t, chooseDirectory, setMode, useRemoteDirectory,
}: SessionWorkspaceRowProps) {
  const state = useStore(value => value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const disabled = busy || state.status !== 'ready' || !state.writable

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('sessionWorkspaceWriteFailed'))
    } finally {
      setBusy(false)
    }
  }

  const chooseRemoteDirectory = (): void => {
    void run(async () => {
      const picked = await chooseDirectory()
      if (picked.error !== undefined) throw new Error(picked.error)
      if (picked.path !== undefined) await useRemoteDirectory(picked.path)
    })
  }

  const selectRemote = (): void => {
    if (state.remoteRoot === '') {
      chooseRemoteDirectory()
      return
    }
    void run(() => setMode('remote-website'))
  }

  const status = state.status === 'loading'
    ? t('sessionWorkspaceLoading')
    : state.status === 'unavailable'
      ? t('sessionWorkspaceUnavailable')
      : t('sessionWorkspaceProjectOverride')

  return (
    <section className={css.root} aria-label={t('sessionWorkspaceLabel')}>
      <div>
        <h3 className={css.title}>{t('sessionWorkspaceTitle')}</h3>
        <p className={css.summary}>{t('sessionWorkspaceDescription')}</p>
      </div>
      <div className={css.choices} role="group" aria-label={t('sessionWorkspaceChoices')}>
        <button
          type="button"
          className={css.choice}
          aria-pressed={state.mode === 'remote-website'}
          disabled={disabled}
          onClick={selectRemote}
        >
          <span className={css.choiceTitle}>{t('sessionWorkspaceRemote')}</span>
          <span className={css.recommended}>{t('sessionWorkspaceRecommended')}</span>
          <span className={css.choiceSummary}>{t('sessionWorkspaceRemoteDescription')}</span>
        </button>
        <button
          type="button"
          className={css.choice}
          aria-pressed={state.mode === 'harnessy-default'}
          disabled={disabled}
          onClick={() => { void run(() => setMode('harnessy-default')) }}
        >
          <span className={css.choiceTitle}>{t('sessionWorkspaceDefault')}</span>
          <span className={css.choiceSummary}>{t('sessionWorkspaceDefaultDescription')}</span>
        </button>
      </div>
      {state.mode === 'remote-website' && (
        <div className={css.directoryRow}>
          <div className={css.path} title={state.remoteRoot}>
            <IconFolderOpenOutline16 className={css.folderIcon} />
            <span>{state.remoteRoot}</span>
          </div>
          <Button size="sm" variant="outline" disabled={disabled} onClick={chooseRemoteDirectory}>
            {t('sessionWorkspaceChangeFolder')}
          </Button>
        </div>
      )}
      <p className={error === undefined ? css.status : css.error} role={error === undefined ? undefined : 'alert'}>
        {error ?? status}
      </p>
    </section>
  )
}
