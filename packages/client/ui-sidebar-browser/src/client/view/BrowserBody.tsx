/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular, Tooltip,
  IconRightUpOutlineRegular,
  IconSettingsOutlineRegular,
  IconStopFillRegular,
  SHIELD_OUTLINE_PATH,
  ICON_REGULAR_STROKE,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopWebsiteProfile } from '../../types.ts'
import type { SidebarRightTabParamsFor } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { openResponsiveTabParams, type BrowserResponsiveInjected } from '../responsive.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import { BrowserProfileBar } from './BrowserProfileBar.tsx'
import { BrowserFeedback } from './BrowserFeedback.tsx'
import { BrowserControl } from './BrowserControl.tsx'
import { BrowserAddressSuggestions } from './BrowserAddressSuggestions.tsx'
import { BrowserAnnotationIcon } from './BrowserAnnotationIcon.tsx'
import { BrowserFindBar } from './BrowserFindBar.tsx'
import { BrowserPageActions, type BrowserPageCommand } from './BrowserPageActions.tsx'
import { BrowserResponsiveBody } from './BrowserResponsiveBody.tsx'
import { BrowserCaptureBar, BrowserShareBar } from './BrowserCaptureBar.tsx'
import { canRecordBrowser, useBrowserRecording } from './useBrowserRecording.ts'
import { BrowserRecordingSettings, readBrowserRecordingSettings } from './BrowserRecordingSettings.tsx'
import { useBrowserShare } from './useBrowserShare.ts'
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
  & PropsRenderSlots<'sidebar.right.pane.tab.browser.profiles' | 'sidebar.right.pane.tab.browser.responsive'>
  & InjectFace<BrowserResponsiveInjected>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

function useBrowserDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>()
  return [edit?.revision === revision ? edit.value : url ?? '',
    (value) => { setEdit({ revision, value }) }]
}

/** Render provider-neutral navigation state and optional controls. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const { tab, sidebar } = props.useTabInfo()
  const responsiveAvailable = props.useResponsiveAvailable(value => value)
  const params = tab.navigation.params as SidebarRightTabParamsFor<'browser'>
  if (responsiveAvailable && params?.responsiveOpenId !== undefined && params.profileId === undefined && params.previewId === undefined) {
    return <BrowserResponsiveBody tab={tab} fullscreen={sidebar.fullscreen} renderSlot={props.renderSlot} t={props.t} />
  }
  if (props.profiles !== undefined && params?.profileId !== undefined && params.url === undefined) {
    return <BrowserDefaultProfileBody {...props} tab={tab} responsiveAvailable={responsiveAvailable} profileId={params.profileId} />
  }
  return <BrowserOrdinaryBody {...props} tab={tab} responsiveAvailable={responsiveAvailable} />
}

type BrowserOrdinaryBodyProps = BrowserBodyProps & {
  readonly tab: ReturnType<BrowserBodyProps['useTabInfo']>['tab']
  readonly responsiveAvailable: boolean
  readonly initialAddress?: string
}

function BrowserDefaultProfileBody(props: BrowserOrdinaryBodyProps & { readonly profileId: DesktopWebsiteProfile['id'] }): ReactNode {
  const { useWebsiteProfiles, profileId, t, profiles } = props
  const state = useWebsiteProfiles(current => current)
  const profile = state.profiles.find(candidate => candidate.id === profileId)
  if (profile !== undefined) return <BrowserOrdinaryBody {...props} initialAddress={profile.url} />
  if (state.phase === 'failed') return <div className={css.failure} role="alert">
    <div>{t('profiles.loadFailed')}</div>
    <Button size="sm" variant="outline" onClick={() => { void profiles?.reload() }}>{t('retry')}</Button>
  </div>
  return <div className={css.start} role="status">{t(state.phase === 'loading' ? 'profiles.loading' : 'profiles.missing')}</div>
}

function BrowserOrdinaryBody(props: BrowserOrdinaryBodyProps): ReactNode {
  const {
    mount, loadUrl, restore, goBack, goForward, reload, setSandbox, profiles, useBrowserState, useStore, tab,
    setVisible, useWebsiteRequests, findInPage, stopLoading, hardReload,
    useWebsiteProfiles, renderSlot, t,
  } = props
  const params = tab.navigation.params as SidebarRightTabParamsFor<'browser'>
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(params?.previewId === undefined && params?.responsiveOpenId === undefined
    ? params?.url ?? props.initialAddress : undefined)
  const profileId = params?.profileId
  const viewportId = useId()
  const [mountEpoch, setMountEpoch] = useState(0)
  const [takeoverFailed, setTakeoverFailed] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [findPage, setFindPage] = useState<string>()
  const [recordingSettingsOpen, setRecordingSettingsOpen] = useState(false)
  const findInput = useRef<HTMLInputElement>(null)
  const actionsTrigger = useRef<HTMLButtonElement>(null)
  const annotationTrigger = useRef<HTMLButtonElement>(null)
  const previousFeedbackOpen = useRef(false)
  useLayoutEffect(() => {
    if (previousFeedbackOpen.current && !feedbackOpen) annotationTrigger.current?.focus()
    previousFeedbackOpen.current = feedbackOpen
  }, [feedbackOpen])
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
      tabId: tab.id, sessionId: props.sessionId, openRequestId: params?.openRequestId, signal: tab.signal, viewportId,
      applicationOrigin: window.location.origin,
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
  const humanAccessBlocked = feedbackOpen || (props.addFeedback === undefined && profileId !== undefined
    && (profiles === undefined || profileState.phase !== 'ready'
      || profileState.profiles.find(profile => profile.id === profileId)?.control !== 'human'
      || requests === undefined || requests.phase !== 'ready' || requests.granted || requests.busy !== undefined || requests.blocked
      || requests.requests.some(request => request.status === 'granted')))
  const failure = state?.addressFailure
  const error = frame.error
  const visiblePageKey = tab.visible && profileId === undefined && !humanAccessBlocked && frame.humanControl === true
    && frame.address === 'observed' && error === undefined && target !== undefined
    ? `${state?.addressRevision ?? 0}:${target.url}` : undefined
  const findAvailable = visiblePageKey !== undefined && !frame.loading
  const findUrl = findAvailable ? target?.url : undefined
  const openFind = useCallback(() => {
    if (findUrl === undefined) return
    setFindPage(findUrl)
    findInput.current?.focus()
  }, [findUrl])
  useLayoutEffect(() => tab.actions.bindCommands({ refresh: () => { if (!feedbackOpen) reload(tab.id) },
    ...(findUrl === undefined ? {} : { find: openFind }) }),
  [tab.actions, tab.id, reload, feedbackOpen, findUrl, openFind])
  const zoom = tab.visible && !humanAccessBlocked && frame.humanControl === true && frame.address === 'observed'
    && !frame.loading && error === undefined && frame.zoomFactor !== undefined
    ? { factor: frame.zoomFactor, set: (factor: number) => props.setZoom(tab.id, factor) } : undefined
  const recordingPageKey = frame.recordingSupported === true && !frame.loading ? visiblePageKey : undefined
  const recording = useBrowserRecording(recordingPageKey)
  const share = useBrowserShare(frame.phoneShareSupported === true || frame.remoteShareSupported === true ? visiblePageKey : undefined)
  const recordingBusy = recording.state?.phase === 'starting' || recording.state?.phase === 'recording' || recording.state?.phase === 'finishing'
  const sharingBusy = share.state?.phase === 'sharing' || share.state?.phase === 'starting'
  const commands: BrowserPageCommand[] = []
  if (findAvailable && frame.devToolsAvailable === true) {
    commands.push({ id: 'devtools', label: t('page.devTools'), run: () => props.openDevTools(tab.id) })
  }
  if (findAvailable && target !== undefined && frame.recordingSupported === true && !recordingBusy && !sharingBusy
    && recording.state?.phase !== 'ready' && canRecordBrowser()) {
    commands.push({ id: 'recording', label: t('recording.start'),
      run: () => {
        const { frameRate, clicks, keys } = readBrowserRecordingSettings()
        recording.start(
          documentId => props.captureRecordingFrame(tab.id, target.url, documentId, { clicks, keys }),
          Number(frameRate), t('recording.settings.maskedKey'),
        )
      } })
    commands.push({ id: 'recording-settings', label: t('recording.settings'), run: () => { setRecordingSettingsOpen(true) } })
  }
  if (findAvailable && !sharingBusy && !recordingBusy) {
    if (frame.phoneShareSupported === true) commands.push({ id: 'phone-share', label: t('share.phoneStart'),
      run: () => share.start(() => props.beginRemoteShare(tab.id, 'phone'), 'phone') })
    if (frame.remoteShareSupported === true) commands.push({ id: 'share', label: t('share.start'),
      run: () => share.start(() => props.beginRemoteShare(tab.id, 'web')) })
  }
  const findOpen = findAvailable && findPage !== undefined && findPage === target?.url
  const closeFind = (): void => {
    setFindPage(undefined)
    actionsTrigger.current?.focus()
  }
  useEffect(() => {
    if (!findOpen) setFindPage(undefined)
  }, [findOpen])
  const untrustedCertificate = error?.code === -202
  const canStop = props.addFeedback !== undefined && frame.loading
  const refreshLabel = t(canStop ? 'load.stop' : 'reload')
  const responsivePreview = !props.responsiveAvailable || profileId !== undefined || params?.previewId !== undefined
    || frame.address !== 'observed' || target === undefined || error !== undefined ? undefined : (): void => {
      const preview = openResponsiveTabParams(target.url, window.location.origin)
      if (preview !== undefined) tab.actions.openTab('browser', { params: preview, revealIfOpened: false })
    }
  const openExternal = externalUrl === undefined ? undefined : () => { window.open(externalUrl, '_blank', 'noopener,noreferrer') }
  const submit = (event: FormEvent): void => { event.preventDefault(); if (!humanAccessBlocked) loadUrl(tab.id, draft) }

  return (
    <div className={css.root}>
      <div className={css.desktop}>
        <form data-sidebar-browser-toolbar className={css.toolbar} onSubmit={submit}
          ref={(element) => { element?.toggleAttribute('inert', feedbackOpen) }}>
          <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={humanAccessBlocked || !frame.canGoBack} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutlineRegular /></button>
          <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={humanAccessBlocked || !frame.canGoForward} onClick={() => { goForward(tab.id) }}><IconChevronRightOutlineRegular /></button>
          <Tooltip label={refreshLabel} shortcutKeys={canStop ? undefined : tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-label={refreshLabel}
              aria-keyshortcuts={canStop ? undefined : tab.refreshShortcut?.aria}
              disabled={humanAccessBlocked || target === undefined || mountEpoch === 0}
              onClick={() => { if (canStop) stopLoading(tab.id); else reload(tab.id) }}>
              {canStop ? <IconStopFillRegular size={12} /> : <IconRefreshOutlineRegular />}
            </button>
          </Tooltip>
          <div className={css.addressBox}>
            <BrowserAddressSuggestions value={draft}
              recent={tab.visible && profileId === undefined ? state?.recentNavigations ?? [] : []}
              label={t('address.placeholder')} suggestionsLabel={t('address.suggestions')}
              inputClassName={[css.address, unknown ? css.addressUnknown : ''].filter(Boolean).join(' ')}
              disabled={humanAccessBlocked} onChange={setDraft}
              onCommit={(url) => { if (!humanAccessBlocked) { setDraft(url); loadUrl(tab.id, url) } }} />
            {unknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
            <button type="submit" className={[css.tool, css.addressGo].join(' ')} aria-label={t('go')} title={t('go')} disabled={humanAccessBlocked}><IconLinkOutlineRegular /></button>
          </div>
          <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={humanAccessBlocked || externalUrl === undefined}
            onClick={openExternal}
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
          <BrowserControl humanControl={frame.humanControl} control={human => props.control(tab.id, human)} disabled={feedbackOpen} t={t} />
          {props.addFeedback !== undefined && target !== undefined && <button type="button" className={css.tool} ref={annotationTrigger}
            aria-label={t('annotation.title')} title={t('annotation.title')} aria-pressed={feedbackOpen}
            onClick={() => { setFeedbackOpen(true) }}><BrowserAnnotationIcon tool="select" /></button>}
          {profileId !== undefined && profiles !== undefined && <details className={css.accountMenu}>
            <summary className={css.tool} aria-label={t('profiles.manage')} title={t('profiles.manage')}><IconSettingsOutlineRegular /></summary>
            <div className={css.accountPopover}><BrowserProfileBar profileId={profileId} profiles={profiles}
              onUrlChanged={(url) => { tab.actions.openTab('browser', { params: { url, profileId }, replaceTab: true, revealIfOpened: false }) }}
              useWebsiteProfiles={useWebsiteProfiles}
              t={t} /></div>
          </details>}
          {props.addFeedback !== undefined && <BrowserPageActions visible={tab.visible} disabled={humanAccessBlocked}
            hasPage={frame.address === 'observed' && !frame.loading && error === undefined}
            find={findAvailable ? openFind : undefined}
            responsivePreview={responsivePreview}
            hardReload={() => { hardReload(tab.id) }} capture={() => props.capture(tab.id)}
            addFeedback={props.addFeedback} zoom={zoom} commands={commands} trigger={actionsTrigger} t={t} />}
        </form>
        {findOpen && <BrowserFindBar tabId={tab.id} input={findInput} findInPage={findInPage}
          result={frame.findResult} onClose={closeFind} t={t} />}
        {recordingSettingsOpen && recordingPageKey !== undefined && <BrowserRecordingSettings t={t}
          close={() => { setRecordingSettingsOpen(false) }} />}
        {recordingPageKey !== undefined && recording.state !== undefined && <BrowserCaptureBar recording={recording} t={t} />}
        {visiblePageKey !== undefined && share.state !== undefined && <BrowserShareBar share={share} t={t} />}
        {profileId !== undefined && profiles === undefined && <p className={css.profileNotice}>{t('profiles.desktopOnly')}</p>}
        {sandboxed === false && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
        {error !== undefined && <div className={css.failure} role="status">
          {untrustedCertificate ? <>
            <div>{t('load.failed.certificate')}</div>
            <div className={css.failureActions}>
              <Button variant="outline" size="sm" disabled={humanAccessBlocked || target === undefined}
                onClick={() => { reload(tab.id) }}>{t('retry')}</Button>
              <Button variant="outline" size="sm" disabled={humanAccessBlocked || openExternal === undefined}
                onClick={openExternal}>{t('external')}</Button>
            </div>
          </> : error.code !== undefined && error.description !== undefined
            ? t('load.failed.detail', { code: String(error.code), description: error.description })
            : t('load.failed')}
        </div>}
        {failure !== undefined && <div className={css.failure} role="alert">{t(`error.${failure}`)}</div>}
        <div className={css.content} aria-busy={frame.loading}>
          <div id={viewportId} className={css.viewport} aria-label={t('type.label')} ref={(element) => { element?.toggleAttribute('inert', humanAccessBlocked || frame.humanControl === false) }} />
          {frame.humanControl === false && <button type="button" className={css.interactionShield}
            aria-label={t('control.takeover')} title={t('control.takeover')} onClick={() => {
              setTakeoverFailed(false)
              void props.control(tab.id, true).catch(() => { setTakeoverFailed(true) })
            }} />}
          {takeoverFailed && <p className={css.failure} role="alert">{t('control.failed')}</p>}
          {feedbackOpen && props.addFeedback !== undefined && <BrowserFeedback
            capture={() => props.capture(tab.id)} pick={point => props.pick(tab.id, point)}
            addFeedback={props.addFeedback} onClose={() => { setFeedbackOpen(false) }} t={t} />}
          {restoreTarget !== undefined && <section className={css.restore} aria-label={t('restore.previous')}>
            <p className={css.restoreLabel}>{t('restore.previous')}</p>
            <p className={css.restoreTitle}>{restoreTarget.title}</p>
            <p className={css.restoreUrl}>{restoreTarget.url}</p>
            <Button variant="primary" size="sm" disabled={humanAccessBlocked || mountEpoch === 0} onClick={() => { restore(tab.id) }}>
              {t('restore.action')}
            </Button>
          </section>}
          {restoreTarget === undefined && (target === undefined || frame.loading) && error === undefined && (
            <div className={css.placeholder}>
              <div className={css.start}>{t(target === undefined ? 'start' : 'loading')}</div>
            </div>
          )}
        </div>
        {unknown && <p className={css.limit}>{t('address.unknown')}</p>}
      </div>
    </div>
  )
}
