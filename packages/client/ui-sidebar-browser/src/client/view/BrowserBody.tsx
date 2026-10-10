/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular, Tooltip,
  IconRightUpOutlineRegular,
  SHIELD_OUTLINE_PATH,
  ICON_REGULAR_STROKE,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfile } from '../../types.ts'
import type { SidebarRightTabParamsFor } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import { BrowserProfileBar } from './BrowserProfileBar.tsx'
import type {} from './BrowserProfilePicker.tsx'
import css from './Browser.module.css'

const EMPTY_FRAME = emptyBrowserFrame()

function SandboxPolicyIcon({ sandboxed }: { readonly sandboxed: boolean }): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinejoin="round" />
      {sandboxed
        ? <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        : <path d="M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z" fill="currentColor" transform="translate(1.2 0.8)" />}
    </svg>
  )
}

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore>
  & PropsRenderSlots<'sidebar.right.pane.tab.browser.profiles'>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

function useBrowserDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>()
  return [edit?.revision === revision ? edit.value : url ?? '',
    (value) => { setEdit({ revision, value }) }]
}

/** Render provider-neutral navigation state and optional controls. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const {
    mount, loadUrl, restore, goBack, goForward, reload, setSandbox, profiles, useBrowserState, useStore, useTabInfo,
    setVisible, selectRequest, resumeRequest, takeoverRequest, reloadRequests, useWebsiteRequests,
    useWebsiteProfiles, renderSlot, t,
  } = props
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload(tab.id) } }), [tab.actions, tab.id, reload])
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(tab.navigation.params?.url)
  const profileId = (tab.navigation.params as SidebarRightTabParamsFor<'browser'>)?.profileId
  const viewportId = useId()
  const [mountEpoch, setMountEpoch] = useState(0)
  const state = useBrowserState(tab.id)
  const requests = useWebsiteRequests(tab.id, current => current)
  const profileState = useWebsiteProfiles(current => current)
  const frame = state?.frame ?? EMPTY_FRAME
  const restoreTarget = state === undefined ? currentBrowserTarget(initial.current) : state.restoreTarget
  const target = frame.target ?? restoreTarget
  const [draft, setDraft] = useBrowserDraft(target?.url ?? initialUrl.current, state?.addressRevision ?? 0)
  /** A link opened from a saved-profile page stays in that account's own tab. */
  const openUrl = (url: string): void => {
    tab.actions.openTab('browser', {
      params: profileId === undefined ? { url } : { url, profileId },
      revealIfOpened: false,
    })
  }

  useLayoutEffect(() => {
    const hide = mount({
      tabId: tab.id, signal: tab.signal, viewportId, applicationOrigin: window.location.origin,
      initial: initial.current, initialUrl: initialUrl.current, profileId,
      openTab: openUrl,
    })
    setMountEpoch(value => value + 1)
    return hide
  }, [mount, tab.id, tab.signal, tab.actions, viewportId, props.actions, profileId])

  useLayoutEffect(() => {
    setVisible(tab.id, tab.visible)
    return () => { setVisible(tab.id, false) }
  }, [setVisible, tab.id, tab.visible, mountEpoch])

  const unknown = frame.address === 'unknown'
  const externalUrl = unknown ? undefined : target?.url
  const sandboxed = frame.sandboxEnabled
  const humanAccessBlocked = profileId !== undefined
    && (profiles === undefined || profileState.phase !== 'ready'
      || profileState.profiles.find(profile => profile.id === profileId)?.control !== 'human'
      || requests === undefined || requests.phase !== 'ready' || requests.granted || requests.busy !== undefined || requests.blocked
      || requests.requests.some(request => request.status === 'granted'))
  const failure = state?.addressFailure
  const error = frame.error
  const submit = (event: FormEvent): void => { event.preventDefault(); if (!humanAccessBlocked) loadUrl(tab.id, draft) }

  return (
    <div className={css.root}>
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={humanAccessBlocked || !frame.canGoBack} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={humanAccessBlocked || !frame.canGoForward} onClick={() => { goForward(tab.id) }}><IconChevronRightOutlineRegular /></button>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('reload')} aria-keyshortcuts={tab.refreshShortcut?.aria} disabled={humanAccessBlocked || target === undefined || mountEpoch === 0} onClick={() => { reload(tab.id) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <div className={css.addressBox}>
          <input
            className={[css.address, unknown ? css.addressUnknown : ''].join(' ')}
            value={draft}
            aria-label={t('address.placeholder')}
            placeholder={t('address.placeholder')}
            spellCheck={false}
            disabled={humanAccessBlocked}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
          {unknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
          <button type="submit" className={[css.tool, css.addressGo].join(' ')} aria-label={t('go')} title={t('go')} disabled={humanAccessBlocked}><IconLinkOutlineRegular /></button>
        </div>
        <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={humanAccessBlocked || externalUrl === undefined}
          onClick={externalUrl === undefined ? undefined : () => { window.open(externalUrl, '_blank', 'noopener,noreferrer') }}
        ><IconRightUpOutlineRegular size={14} /></button>
        {sandboxed !== undefined && <button
          type="button"
          className={[css.tool, sandboxed ? '' : css.sandboxOff].join(' ')}
          aria-label={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          title={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          aria-pressed={!sandboxed}
          disabled={humanAccessBlocked}
          onClick={() => { setSandbox(tab.id, !sandboxed) }}
        ><SandboxPolicyIcon sandboxed={sandboxed} /></button>}
        {profiles !== undefined && renderSlot('sidebar.right.pane.tab.browser.profiles', {
          profileId,
          openProfile: (profile: DesktopWebsiteProfile) => {
            tab.actions.openTab('browser', { params: { url: profile.url, profileId: profile.id }, revealIfOpened: false })
          },
        })}
      </form>
      {profileId !== undefined && (profiles === undefined
        // This carrier cannot reach the desktop profile registry; say so instead
        // of showing controls that would store nothing.
        ? <p className={css.profileNotice}>{t('profiles.desktopOnly')}</p>
        : <BrowserProfileBar profileId={profileId} profiles={profiles} useWebsiteProfiles={useWebsiteProfiles}
          requests={requests} selectRequest={(id) => { selectRequest(tab.id, id) }}
          resumeRequest={() => resumeRequest(tab.id)} takeoverRequest={() => takeoverRequest(tab.id)}
          reloadRequests={() => reloadRequests(tab.id)} t={t} />)}
      {sandboxed === false && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
      {error !== undefined && <div className={css.failure} role="status">{error.code !== undefined && error.description !== undefined
        ? t('load.failed.detail', { code: String(error.code), description: error.description })
        : t('load.failed')}</div>}
      {failure !== undefined && <div className={css.failure} role="alert">{t(`error.${failure}`)}</div>}
      <div className={css.content} aria-busy={frame.loading}>
        <div id={viewportId} className={css.viewport} aria-label={t('type.label')} ref={(element) => { element?.toggleAttribute('inert', humanAccessBlocked) }} />
        {restoreTarget !== undefined && <section className={css.restore} aria-label={t('restore.previous')}>
          <p className={css.restoreLabel}>{t('restore.previous')}</p>
          <p className={css.restoreTitle}>{restoreTarget.title}</p>
          <p className={css.restoreUrl}>{restoreTarget.url}</p>
          <Button variant="primary" size="sm" disabled={humanAccessBlocked || mountEpoch === 0} onClick={() => { restore(tab.id) }}>
            {t('restore.action')}
          </Button>
        </section>}
        {restoreTarget === undefined && (target === undefined || frame.loading) && error === undefined && <div className={css.placeholder}>
          <div className={css.start}>{t(target === undefined ? 'start' : 'loading')}</div>
        </div>}
      </div>
      {unknown && <p className={css.limit}>{t('address.unknown')}</p>}
    </div>
  )
}
