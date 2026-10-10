/** The saved profile one Browser tab belongs to, with its control actions. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsHooks } from '@deepseek-ai/dsh-client-ui-slots'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { DesktopWebsiteControl, DesktopWebsiteProfileId, DesktopWebsiteRequestId } from '../../types.ts'
import type { WebsiteRequestPageState } from '../browser/WebsiteRequestPage.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { WebsiteProfileCommands } from '../browser/profiles.ts'
import css from './Browser.module.css'

/** Bar inputs: this tab's profile, the profile share, and its actions. */
export interface BrowserProfileBarProps {
  readonly profileId: DesktopWebsiteProfileId
  readonly profiles: WebsiteProfileCommands
  readonly requests: WebsiteRequestPageState | undefined
  /** @param id - exact request selected by the human, or no selection. */
  readonly selectRequest: (id: DesktopWebsiteRequestId | undefined) => void
  /** @returns after admission of the selected request settles. */
  readonly resumeRequest: () => Promise<void>
  /** @returns after immediate revocation and drainage settle. */
  readonly takeoverRequest: () => Promise<void>
  /** @returns after a fresh Session roster read. */
  readonly reloadRequests: () => Promise<void>
  readonly useWebsiteProfiles: PropsHooks<BrowserInjected['hooks']>['useWebsiteProfiles']
  readonly t: TranslateNS<'sidebarBrowser'>
}

/** Status word and guidance for one control state. */
function controlCopy(control: DesktopWebsiteControl, t: BrowserProfileBarProps['t']): { readonly status: string; readonly hint: string } {
  switch (control) {
    case 'human': return { status: t('profiles.detail.human'), hint: t('profiles.bar.human') }
    case 'agent': return { status: t('profiles.detail.agent'), hint: t('profiles.bar.agent') }
    case 'clearing': return { status: t('profiles.detail.clearing'), hint: t('profiles.bar.clearing') }
    case 'cleanup-failed': return { status: t('profiles.detail.cleanupFailed'), hint: t('profiles.bar.cleanupFailed') }
    /* v8 ignore next 2 -- closed-union backstop; only reached if a control state is forged */
    default: return assertNever(control)
  }
}

/**
 * Show who controls this signed-in page and let the user change that.
 *
 * Resume is the only way back to agent observation, so a human login never hands
 * over silently; Sign out and Forget clear the account's stored sign-in data,
 * and Forget confirms first because it removes the saved profile itself.
 */
export function BrowserProfileBar({ profileId, profiles, useWebsiteProfiles, requests, selectRequest,
  resumeRequest, takeoverRequest, reloadRequests, t }: BrowserProfileBarProps): ReactNode {
  const state = useWebsiteProfiles(current => current)
  const [confirming, setConfirming] = useState(false)
  const [choosingRequest, setChoosingRequest] = useState(false)
  const profile = state.profiles.find(candidate => candidate.id === profileId)
  if (profile === undefined) {
    return <div className={css.profileBar}><p className={css.profileHint}>{t('profiles.missing')}</p></div>
  }
  const blocked = state.creating || state.busy !== undefined
  const clearing = profile.control === 'clearing' || profile.control === 'cleanup-failed'
  const copy = profile.control === 'agent' && !requests?.granted
    ? { status: t('profiles.detail.reserved'), hint: t('profiles.bar.reserved') }
    : controlCopy(clearing ? profile.control : requests?.granted ? 'agent' : 'human', t)
  const localAdmission = requests !== undefined && (requests.granted || requests.busy !== undefined || requests.blocked)
  const accountTakeover = !clearing && profile.control === 'agent' && !localAdmission
  const available = requests?.requests.filter(request => !request.terminal) ?? []
  const requestLabel = requests?.selected === undefined
    ? t('requests.choose') : t('requests.label', { id: requests.selected })
  return (
    <div className={css.profileBar}>
      <div className={css.profileHead}>
        <span className={css.profileName}>{profile.name}</span>
        {profile.accountLabel !== '' && <span className={css.profileDetail}>{profile.accountLabel}</span>}
        <span className={css.profileStatus}>{copy.status}</span>
      </div>
      <p className={css.profileHint}>{copy.hint}</p>
      <div className={css.profileActions}>
        {!clearing && <Menu portal open={choosingRequest} onClose={() => { setChoosingRequest(false) }}
          items={available.length === 0 ? [{ type: 'label', id: 'empty', text: t('requests.empty') }]
            : available.map(request => ({ id: request.id, label: t('requests.label', { id: request.id }),
              disabled: requests?.phase !== 'ready' || requests.busy !== undefined || blocked,
            }))}
          onSelect={(id) => { selectRequest(available.find(request => request.id === id)?.id); setChoosingRequest(false) }}
          anchor={<Button size="sm" variant="outline" disabled={blocked || requests === undefined}
            aria-haspopup="menu" aria-expanded={choosingRequest}
            onClick={() => { setChoosingRequest(open => !open) }}>{requestLabel}</Button>} />}
        {!clearing && <Button size="sm" variant="primary" disabled={blocked || profile.control !== 'human' || !requests?.canResume}
          title={t('requests.resume.title')} onClick={() => { void resumeRequest() }}>{t('profiles.resume')}</Button>}
        {(requests?.canTakeover || accountTakeover) && <Button size="sm" variant="outline" disabled={accountTakeover && blocked}
          title={t('profiles.takeControl.title')} onClick={() => {
            if (requests?.canTakeover) void takeoverRequest()
            else void profiles.takeover(profile.id)
          }}>{t('profiles.takeControl')}</Button>}
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          title={t('profiles.signOut.title')} onClick={() => { void profiles.signOut(profile.id) }}>{t('profiles.signOut')}</Button>}
        {!clearing && <Button size="sm" variant="outline" disabled={blocked}
          title={t('profiles.forget.title')} onClick={() => { setConfirming(true) }}>{t('profiles.forget')}</Button>}
      </div>
      {requests?.phase === 'failed' && <p className={css.profileHint} role="status">{t('requests.loadFailed')} {' '}
        <Button size="sm" variant="outline" onClick={() => { void reloadRequests() }}>{t('retry')}</Button></p>}
      {requests?.blocked && <p className={css.profileHint} role="status">{t('requests.blocked')}</p>}
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
