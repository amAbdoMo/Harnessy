/** The saved profile one Browser tab belongs to, with its control actions. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfileId } from '../../types.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { WebsiteProfileCommands } from '../browser/profiles.ts'
import { resolveWebsiteProfileInput, type WebsiteProfileInputIssue } from '../browser/profile-input.ts'
import css from './Browser.module.css'

/** Bar inputs: this tab's profile, the profile share, and its actions. */
export interface BrowserProfileBarProps {
  readonly profileId: DesktopWebsiteProfileId
  readonly profiles: WebsiteProfileCommands
  readonly useWebsiteProfiles: PropsHooks<BrowserInjected['hooks']>['useWebsiteProfiles']
  readonly t: TranslateNS<'sidebarBrowser'>
  readonly onUrlChanged: (url: string) => void
}

/** Account settings kept in the collapsed toolbar menu; tab ownership controls live beside the address. */
export function BrowserProfileBar({ profileId, profiles, useWebsiteProfiles, t, onUrlChanged }: BrowserProfileBarProps): ReactNode {
  const state = useWebsiteProfiles(current => current)
  const [confirming, setConfirming] = useState(false)
  const [editingLogin, setEditingLogin] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [editingUrl, setEditingUrl] = useState(false)
  const [url, setUrl] = useState('')
  const [urlIssue, setUrlIssue] = useState<WebsiteProfileInputIssue['reason']>()
  const profile = state.profiles.find(candidate => candidate.id === profileId)
  if (profile === undefined) {
    return <div className={css.profileBar}><p className={css.profileHint}>{t('profiles.missing')}</p></div>
  }
  const blocked = state.creating || state.busy !== undefined
  const clearing = profile.control === 'clearing' || profile.control === 'cleanup-failed'
  const closeLogin = (): void => { setEditingLogin(false); setUsername(''); setPassword('') }
  const saveLogin = (): void => {
    if (blocked || password.length === 0) return
    void profiles.saveLogin(profile.id, { username, password }).finally(closeLogin)
  }
  const saveUrl = (): void => {
    if (blocked || clearing) return
    const resolved = resolveWebsiteProfileInput({ ...profile, url })
    if (!resolved.ok) { setUrlIssue(resolved.issue.reason); return }
    void profiles.setUrl(profile.id, resolved.value.url).then((saved) => {
      if (saved) { setEditingUrl(false); onUrlChanged(resolved.value.url) }
    })
  }
  return (
    <div className={css.profileBar}>
      <div className={css.profileHead}>
        <span className={css.profileName}>{profile.name}</span>
        {profile.accountLabel !== '' && <span className={css.profileDetail}>{profile.accountLabel}</span>}
        {clearing && <span className={css.profileStatus}>{t(profile.control === 'clearing' ? 'profiles.detail.clearing' : 'profiles.detail.cleanupFailed')}</span>}
      </div>
      {clearing && <p className={css.profileHint}>{t(profile.control === 'clearing' ? 'profiles.bar.clearing' : 'profiles.bar.cleanupFailed')}</p>}
      <div className={css.profileActions}>
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          onClick={() => { setUrl(profile.url); setUrlIssue(undefined); setEditingUrl(true) }}>{t('profiles.url.edit')}</Button>}
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          onClick={() => { setEditingLogin(true) }}>{t(profile.hasSavedLogin ? 'profiles.login.saved' : 'profiles.login.save')}</Button>}
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          title={t('profiles.signOut.title')} onClick={() => { void profiles.signOut(profile.id) }}>{t('profiles.signOut')}</Button>}
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          title={t('profiles.forget.title')} onClick={() => { setConfirming(true) }}>{t('profiles.forget')}</Button>}
      </div>
      {editingUrl && <div className={css.profileForm} role="group" aria-label={t('profiles.url.edit')}>
        <label className={css.profileField}><span className={css.profileFieldLabel}>{t('profiles.create.url')}</span>
          <Input value={url} disabled={blocked || clearing} aria-invalid={urlIssue !== undefined}
            onChange={(event) => { setUrl(event.currentTarget.value); setUrlIssue(undefined) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); saveUrl() }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditingUrl(false) }
            }} /></label>
        <p className={css.profileFieldHint}>{t('profiles.url.hint')}</p>
        {urlIssue !== undefined && <p className={css.profileFieldError} role="alert">{t(`profiles.failure.${urlIssue}`)}</p>}
        <div className={css.profileActions}>
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => { setEditingUrl(false) }}>{t('cancel')}</Button>
          <Button size="sm" variant="primary" disabled={blocked || clearing} onClick={saveUrl}>{t('profiles.login.action')}</Button>
        </div>
      </div>}
      {editingLogin && <Modal open onClose={() => { if (!blocked) closeLogin() }} closeLabel={t('close')}
        title={t('profiles.login.title')} description={t('profiles.login.description')}
        footer={<>
          {profile.hasSavedLogin && <Button variant="outline" disabled={blocked} onClick={() => {
            void profiles.removeLogin(profile.id).finally(closeLogin)
          }}>{t('profiles.login.remove')}</Button>}
          <Button variant="outline" disabled={blocked} onClick={closeLogin}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked || password.length === 0} onClick={saveLogin}>{t('profiles.login.action')}</Button>
        </>}>
        <div className={css.profileForm}>
          <label className={css.profileField}><span className={css.profileFieldLabel}>{t('profiles.login.username')}</span>
            <Input value={username} autoComplete="off" disabled={blocked} data-modal-autofocus
              onChange={(event) => { setUsername(event.currentTarget.value) }} /></label>
          <label className={css.profileField}><span className={css.profileFieldLabel}>{t('profiles.login.password')}</span>
            <Input type="password" value={password} autoComplete="off" disabled={blocked}
              onChange={(event) => { setPassword(event.currentTarget.value) }} /></label>
        </div>
      </Modal>}
      {confirming && (
        <Modal
          open
          onClose={() => { setConfirming(false) }}
          closeLabel={t('close')}
          title={t('profiles.forgetConfirm.title')}
          description={t('profiles.forgetConfirm.description')}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => { setConfirming(false); void profiles.forget(profile.id) }}>
                {t('profiles.forget')}
              </Button>
            </>
          )}
        />
      )}
    </div>
  )
}
