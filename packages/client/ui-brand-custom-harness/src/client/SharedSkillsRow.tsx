import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconFolderOpenOutline16, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { createSharedSkillsRowStore } from './shared-skills-store.ts'
import css from './SharedSkillsRow.module.css'

/** Host-backed actions supplied to the shared-skills settings row. */
export interface SharedSkillsRowInjected {
  chooseDirectory: () => Promise<{ path?: string; error?: string }>
  setDirectory: (directory: string) => Promise<void>
  resetDirectory: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
}

/** Complete props composed for the Harnessy General-settings row. */
export type SharedSkillsRowProps = PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createSharedSkillsRowStore>>
  & PropsLocale<'customHarnessBrand'>
  & SharedSkillsRowInjected

/** Render the live shared skill-directory preference. */
export function SharedSkillsRow({
  useStore, t, chooseDirectory, setDirectory, resetDirectory, setEnabled,
}: SharedSkillsRowProps) {
  const state = useStore(value => value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const ready = state.status === 'ready'
  const disabled = busy || !ready || !state.writable
  const customized = state.defaultDirectory !== '' && state.directory !== state.defaultDirectory

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('sharedSkillsWriteFailed'))
    } finally {
      setBusy(false)
    }
  }

  const choose = (): void => {
    void run(async () => {
      const pickedDirectory = await chooseDirectory()
      if (pickedDirectory.error !== undefined) throw new Error(pickedDirectory.error)
      if (pickedDirectory.path !== undefined) await setDirectory(pickedDirectory.path)
    })
  }

  const status = state.status === 'loading'
    ? t('sharedSkillsLoading')
    : state.status === 'unavailable'
      ? t('sharedSkillsUnavailable')
      : state.enabled ? t('sharedSkillsLive') : t('sharedSkillsDisabled')

  return (
    <section className={css.root} aria-label={t('sharedSkillsLabel')}>
      <div className={css.heading}>
        <div>
          <h3 className={css.title}>{t('sharedSkillsTitle')}</h3>
          <p className={css.summary}>{t('sharedSkillsDescription')}</p>
        </div>
        <Switch
          checked={state.enabled}
          disabled={disabled}
          label={t('sharedSkillsToggle')}
          onChange={(enabled) => { void run(() => setEnabled(enabled)) }}
        />
      </div>
      <div className={css.directoryRow}>
        <div className={css.path} title={state.directory}>
          <IconFolderOpenOutline16 className={css.folderIcon} />
          <span>{state.directory === '' ? t('sharedSkillsLoading') : state.directory}</span>
        </div>
        <div className={css.actions}>
          {customized && (
            <Button size="sm" variant="ghost" disabled={disabled}
              onClick={() => { void run(resetDirectory) }}>
              {t('sharedSkillsUseDefault')}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={disabled} onClick={choose}>
            {t('sharedSkillsChoose')}
          </Button>
        </div>
      </div>
      <p className={error === undefined ? css.status : css.error} role={error === undefined ? undefined : 'alert'}>
        {error ?? status}
      </p>
    </section>
  )
}
