/** Local preferences for native browser recordings. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Checkbox, Modal, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserRecordingIndicators } from '../../types.ts'
import css from './Browser.module.css'

const FRAME_RATES = ['8', '15', '24', '30'] as const
const STORAGE_KEY = 'dsh.browser.recording'
const DEFAULT_SETTINGS: BrowserRecordingSettingsValue = { frameRate: '8', clicks: false, keys: false }

/** Local recording settings retained between sessions on the current Desktop installation. */
export interface BrowserRecordingSettingsValue extends BrowserRecordingIndicators {
  readonly frameRate: typeof FRAME_RATES[number]
}

/** @returns the saved options, or the default when storage is unavailable or malformed. */
export function readBrowserRecordingSettings(): BrowserRecordingSettingsValue {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof stored === 'object' && stored !== null && 'frameRate' in stored && 'clicks' in stored && 'keys' in stored) {
      const frameRate = FRAME_RATES.find(rate => rate === stored.frameRate)
      if (frameRate !== undefined && typeof stored.clicks === 'boolean' && typeof stored.keys === 'boolean') {
        return { frameRate, clicks: stored.clicks, keys: stored.keys }
      }
    }
  } catch (_error: unknown) { /* A denied or obsolete preference must not prevent recording. */ }
  return DEFAULT_SETTINGS
}

/** @param props - locale and dialog close action. @returns Recording preference form. */
export function BrowserRecordingSettings({ t, close }: PropsLocale<'sidebarBrowser'> & { readonly close: () => void }): ReactNode {
  const [draft, setDraft] = useState(readBrowserRecordingSettings)
  const [failed, setFailed] = useState(false)
  const frameRateId = useId()
  const save = (): void => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)) }
    catch (_error: unknown) { setFailed(true); return }
    close()
  }
  return <Modal open title={t('recording.settings')} onClose={close} closeLabel={t('close')} footer={<>
    <Button variant="outline" onClick={close}>{t('cancel')}</Button>
    <Button variant="primary" onClick={save}>{t('recording.settings.save')}</Button>
  </>}>
    <div className={css.profileForm}>
      <div className={css.profileField}>
        <label className={css.profileFieldLabel} htmlFor={frameRateId}>{t('recording.settings.frameRate')}</label>
        <Select id={frameRateId} value={draft.frameRate}
          options={FRAME_RATES.map(rate => ({ value: rate, label: t('recording.settings.fps', { rate }) }))}
          onChange={(value) => {
            const frameRate = FRAME_RATES.find(rate => rate === value)
            if (frameRate !== undefined) setDraft(previous => ({ ...previous, frameRate }))
          }} />
      </div>
      <Checkbox checked={draft.clicks} label={t('recording.settings.clicks')}
        onChange={(clicks) => { setDraft(previous => ({ ...previous, clicks })) }} />
      <div className={css.profileField}>
        <Checkbox checked={draft.keys} label={t('recording.settings.keys')}
          onChange={(keys) => { setDraft(previous => ({ ...previous, keys })) }} />
        <span className={css.profileFieldHint}>{t('recording.settings.keyHint')}</span>
      </div>
      {failed && <span className={css.profileFieldError} role="alert">{t('recording.settings.saveFailed')}</span>}
    </div>
  </Modal>
}
