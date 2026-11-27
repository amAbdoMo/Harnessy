/** Settings for new Desktop Browser tabs. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BROWSER_APPEARANCES, BROWSER_VIEWPORTS, readBrowserDefaults, saveBrowserDefaults, ZOOM_PRESETS, type BrowserDefaults } from '../browser/defaults.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import css from './Browser.module.css'

const viewportChoices = Object.keys(BROWSER_VIEWPORTS) as BrowserDefaults['viewport'][]

/** Profile catalog and refresh command for the default-profile picker. */
export type BrowserDefaultsInjected = Pick<BrowserInjected, 'hooks'> & { readonly reloadProfiles: () => Promise<void> }

/** Render browser settings with the current saved-profile choices.
 * @param props - browser locale and profile catalog.
 * @returns the installation-local browser settings.
 */
export function BrowserDefaultsSection({ t, useWebsiteProfiles, reloadProfiles }: PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserDefaultsInjected>): ReactNode {
  const id = useId()
  const [defaults, setDefaults] = useState(readBrowserDefaults)
  const [failed, setFailed] = useState(false)
  const profileState = useWebsiteProfiles(current => current)
  const selectedProfile = profileState.profiles.find(profile => profile.id === defaults.profileId)
  const save = (next: BrowserDefaults): void => {
    try { saveBrowserDefaults(next) }
    catch (_error: unknown) { setFailed(true); return }
    setDefaults(next)
    setFailed(false)
  }
  return <section className={css.profileForm} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className={css.defaultsHeading}>{t('defaults.title')}</h3>
    <div className={css.profileField}>
      <label className={css.profileFieldLabel} htmlFor={`${id}-profile`}>{t('defaults.profile')}</label>
      <Select id={`${id}-profile`} value={selectedProfile?.id ?? ''}
        disabled={profileState.phase !== 'ready'}
        options={[
          { value: '', label: t('defaults.profile.none') },
          ...profileState.profiles.map(profile => ({
            value: profile.id, label: profile.accountLabel === '' ? profile.name : `${profile.name} (${profile.accountLabel})`,
          })),
        ]}
        onChange={(value) => {
          const profile = profileState.profiles.find(candidate => candidate.id === value)
          if (value === '' || profile !== undefined) save({ ...defaults, profileId: profile?.id })
        }} />
      <span className={css.profileFieldHint}>{t('defaults.profile.hint')}</span>
      {profileState.phase === 'failed' && <div className={css.profileActions}>
        <span className={css.profileFieldError} role="alert">{t('profiles.loadFailed')}</span>
        <Button size="sm" variant="outline" onClick={() => { void reloadProfiles() }}>{t('retry')}</Button>
      </div>}
    </div>
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
