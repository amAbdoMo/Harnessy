/** Settings for the starting presentation of ordinary Desktop Browser tabs. */
import { useId, useState, type ReactNode } from 'react'
import { Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BROWSER_APPEARANCES, BROWSER_VIEWPORTS, readBrowserDefaults, saveBrowserDefaults, ZOOM_PRESETS, type BrowserDefaults } from '../browser/defaults.ts'
import css from './Browser.module.css'

const viewportChoices = Object.keys(BROWSER_VIEWPORTS) as BrowserDefaults['viewport'][]

/** @param props - browser locale. @returns the installation-local browser settings. */
export function BrowserDefaultsSection({ t }: PropsLocale<'sidebarBrowser'>): ReactNode {
  const id = useId()
  const [defaults, setDefaults] = useState(readBrowserDefaults)
  const [failed, setFailed] = useState(false)
  const save = (next: BrowserDefaults): void => {
    try { saveBrowserDefaults(next) }
    catch (_error: unknown) { setFailed(true); return }
    setDefaults(next)
    setFailed(false)
  }
  return <section className={css.profileForm} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className={css.defaultsHeading}>{t('defaults.title')}</h3>
    <p className={css.profileFieldHint}>{t('defaults.description')}</p>
    <div className={css.profileField}>
      <label className={css.profileFieldLabel} htmlFor={`${id}-zoom`}>{t('defaults.zoom')}</label>
      <Select id={`${id}-zoom`} value={String(Math.round(defaults.zoomFactor * 100))}
        options={ZOOM_PRESETS.map(percent => ({ value: String(percent), label: t('page.zoom.percent', { percent }) }))}
        onChange={(value) => { save({ ...defaults, zoomFactor: Number(value) / 100 }) }} />
    </div>
    <div className={css.profileField}>
      <label className={css.profileFieldLabel} htmlFor={`${id}-viewport`}>{t('defaults.viewport')}</label>
      <Select id={`${id}-viewport`} value={defaults.viewport}
        options={viewportChoices.map(value => ({ value, label: t(`defaults.viewport.${value}`) }))}
        onChange={(value) => {
          const viewport = viewportChoices.find(choice => choice === value)
          if (viewport !== undefined) save({ ...defaults, viewport })
        }} />
    </div>
    <div className={css.profileField}>
      <label className={css.profileFieldLabel} htmlFor={`${id}-appearance`}>{t('defaults.appearance')}</label>
      <Select id={`${id}-appearance`} value={defaults.appearance}
        options={BROWSER_APPEARANCES.map(value => ({ value, label: t(`defaults.appearance.${value}`) }))}
        onChange={(value) => {
          const appearance = BROWSER_APPEARANCES.find(choice => choice === value)
          if (appearance !== undefined) save({ ...defaults, appearance })
        }} />
    </div>
    {failed && <span className={css.profileFieldError} role="alert">{t('defaults.saveFailed')}</span>}
  </section>
}
