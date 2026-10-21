/** Desktop-first right-sidebar presentation; parent injection owns pages, approvals and processes. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, HoverCard, Input, Tooltip, IconInfoOutlineRegular, IconCompareSplitOutlineRegular,
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabParamsFor } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DevicePreviewInjected, DeviceProjectState, DeviceSurfaceState } from './model.ts'
import { initialPreviewView, type DeviceLaneView, type DevicePreviewStore } from './store.ts'
import { orientedViewport, type DeviceLane, type DeviceViewport } from './viewport.ts'
import type {} from './copy.ts'
import { DeviceControls } from './DeviceControls.tsx'
import { DeviceFrame } from './DeviceFrame.tsx'
import css from './DevicePreview.module.css'

/** All registration inputs are derived from framework shares. */
export type DevicePreviewProps = PropsRuntime<'sidebar.right.pane.tab.browser.responsive'>
  & PropsStore<DevicePreviewStore>
  & PropsLocale<'devicePreview'>
  & InjectFace<DevicePreviewInjected>

type LaneProps = {
  readonly parent: DevicePreviewProps
  readonly lane: DeviceLane
  readonly view: DeviceLaneView
  readonly surface: DeviceSurfaceState | undefined
  readonly liveAvailable: boolean
  readonly active: boolean
}

function PreviewLane({ parent, lane, view, surface, liveAvailable, active }: LaneProps): ReactNode {
  const { tab } = parent
  const { t, actions } = parent
  const available = liveAvailable && surface?.phase !== 'unavailable'
  const initialUrl = (tab.navigation.params as SidebarRightTabParamsFor<'browser'>)?.url ?? ''
  const publishScale = useCallback((scale: number): void => {
    actions.initialize(tab.id, initialUrl)
    actions.setScale(tab.id, lane, scale)
  }, [actions, tab.id, lane, initialUrl])
  const resizeViewport = useCallback((viewport: DeviceViewport): void => {
    actions.setDimensions(tab.id, lane, orientedViewport(viewport, view.orientation))
  }, [actions, tab.id, lane, view.orientation])
  return <section className={css.lane} hidden={!active} aria-label={t(lane)}>
    <DeviceControls tabId={tab.id} lane={lane} view={view} t={t} actions={actions} liveAvailable={available} />
    <div className={css.noticeSlot} role="status">
      {surface?.failure !== undefined && t(`error.${surface.failure}`)}
      {surface?.failure === undefined && surface?.phase === 'error' && t('error.load')}
      {surface?.failure === undefined && surface?.phase === 'unavailable' && t('unavailable')}
    </div>
    <DeviceFrame tabId={tab.id} lane={lane} view={view} t={t} live={available} visible={tab.visible && active}
      surface={surface} mountSurface={parent.mountSurface} updateSurface={parent.updateSurface}
      publishScale={publishScale} resizeViewport={resizeViewport} />
  </section>
}

function PreviewNavigation({ parent, lane, surface, urlDraft, compare, toggleCompare, liveAvailable, showingLive }: {
  readonly parent: DevicePreviewProps
  readonly lane: DeviceLane
  readonly surface: DeviceSurfaceState | undefined
  readonly urlDraft: string
  readonly compare: boolean
  readonly toggleCompare: () => void
  readonly liveAvailable: boolean
  readonly showingLive: boolean
}): ReactNode {
  const { t, tab } = parent
  const [edit, setEdit] = useState<{ readonly address: string | undefined; readonly draft: string }>()
  const draft = edit?.address === surface?.url ? edit?.draft ?? surface?.url ?? urlDraft : surface?.url ?? urlDraft
  const navigate = (event: FormEvent): void => {
    event.preventDefault()
    if (!liveAvailable || draft.trim() === '') return
    parent.actions.setSource(tab.id, lane, 'live')
    parent.navigate(tab.id, lane, draft.trim())
  }
  return <form className={css.navigation} onSubmit={navigate}>
    <Tooltip portal label={t('back')}><Button size="sm" variant="toolbar" aria-label={t('back')} disabled={!showingLive || !surface?.canGoBack}
      onClick={() => { parent.goBack(tab.id, lane) }}><IconChevronLeftOutlineRegular size={14} /></Button></Tooltip>
    <Tooltip portal label={t('forward')}><Button size="sm" variant="toolbar" aria-label={t('forward')} disabled={!showingLive || !surface?.canGoForward}
      onClick={() => { parent.goForward(tab.id, lane) }}><IconChevronRightOutlineRegular size={14} /></Button></Tooltip>
    <Tooltip portal label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys}>
      <Button size="sm" variant="toolbar" aria-label={t('reload')} aria-keyshortcuts={tab.refreshShortcut?.aria}
        disabled={!showingLive || surface?.url === undefined} onClick={() => { parent.reload(tab.id, lane) }}>
        <IconRefreshOutlineRegular size={14} />
      </Button>
    </Tooltip>
    <Input className={css.address as string} aria-label={t('url')} placeholder={t('url.placeholder')} value={draft} spellCheck={false}
      disabled={!liveAvailable}
      onChange={(event) => {
        setEdit({ address: surface?.url, draft: event.currentTarget.value })
        parent.actions.setUrl(tab.id, event.currentTarget.value)
      }} />
    <Button type="submit" size="sm" variant="primary" disabled={!liveAvailable || draft.trim() === ''}>{t('go')}</Button>
    <Tooltip portal label={t(compare ? 'single' : 'compare')}>
      <Button size="sm" variant="ghost" aria-label={t(compare ? 'single' : 'compare')} aria-pressed={compare}
        onClick={toggleCompare}><IconCompareSplitOutlineRegular size={14} />{t('compare.short')}</Button>
    </Tooltip>
  </form>
}

function ProjectControls({ parent, project, lane }: {
  readonly parent: DevicePreviewProps
  readonly project: DeviceProjectState
  readonly lane: DeviceLane
}): ReactNode {
  const { tab } = parent
  const { t } = parent
  return <section className={css.project} aria-label={t('project.title')}>
    <span role="status">{t(`project.${project.phase}`)}</span>
    {project.phase !== 'external' && <Button size="sm" variant="ghost" disabled={!project.canStop}
      onClick={() => { parent.stopProject(tab.id) }}>{t('project.stop')}</Button>}
    {project.url !== undefined && <Button size="sm" variant="ghost"
      onClick={() => {
        if (project.url === undefined) return
        parent.actions.setSource(tab.id, lane, 'live')
        parent.navigate(tab.id, lane, project.url)
      }}>{t('project.open')}</Button>}
  </section>
}

/**
 * Responsive Browser content. Drafts navigate only after Go, mode selection or a fresh native opening.
 * @param props - framework-bound stores, locale, tab facts and parent adapter callbacks.
 * @returns one device or an expanded independent phone/tablet comparison.
 */
export function DevicePreview(props: DevicePreviewProps): ReactNode {
  const { tab } = props
  const params = tab.navigation.params as SidebarRightTabParamsFor<'browser'>
  const { t, actions } = props
  const saved = props.useStore(state => state.byTab[tab.id])
  const view = saved ?? initialPreviewView(params?.url)
  const runtime = props.useDevicePreview(state => state)
  const tabRuntime = runtime.byTab[tab.id]
  useEffect(() => {
    actions.initialize(tab.id, params?.url ?? '')
    if (params?.previewId !== undefined && params.url !== undefined) actions.setUrl(tab.id, params.url)
    if (props.retainTab(tab.id, tab.signal, params?.url, params?.previewId)) {
      for (const lane of ['phone', 'tablet'] as const) actions.setSource(tab.id, lane, 'live')
      props.selectMobile()
    }
  }, [actions, props.retainTab, tab.id, tab.signal, params?.url, params?.previewId, props.selectMobile])
  const navigated = useRef<Partial<Record<DeviceLane, number>>>({})
  const importedRevision = useRef<number>()
  const selected = props.mode === 'tablet' ? 'tablet' : 'phone'
  useEffect(() => {
    const navigation = props.navigation
    if (props.mode === 'desktop' || navigation === undefined) return
    if (importedRevision.current !== navigation.revision) {
      importedRevision.current = navigation.revision
      actions.setUrl(tab.id, navigation.url)
    }
    if (navigated.current[selected] === navigation.revision) return
    navigated.current[selected] = navigation.revision
    actions.setSource(tab.id, selected, 'live')
    props.navigate(tab.id, selected, navigation.url)
  }, [actions, props.navigation, props.mode, props.navigate, tab.id, selected])
  useEffect(() => {
    if (props.mode === 'desktop') return
    return tab.actions.bindCommands({ refresh: () => {
      if (!runtime.liveAvailable) return
      const lanes: readonly DeviceLane[] = view.compare ? ['phone', 'tablet'] : [selected]
      for (const lane of lanes) {
        if (view[lane].source === 'live' && tabRuntime?.[lane].phase !== 'unavailable' && tabRuntime?.[lane].url !== undefined) {
          props.reload(tab.id, lane)
        }
      }
    } })
  }, [tab.actions, tab.id, props.reload, runtime.liveAvailable, tabRuntime, view, selected, props.mode])
  const toggleCompare = (): void => {
    actions.setCompare(tab.id, !view.compare)
    if (view.compare) return
    const other = selected === 'phone' ? 'tablet' : 'phone'
    const url = tabRuntime?.[selected].url
    if (runtime.liveAvailable && view[other].source === 'live' && url !== undefined && tabRuntime?.[other].url === undefined) {
      actions.setSource(tab.id, other, 'live')
      props.navigate(tab.id, other, url)
      if (props.navigation !== undefined) navigated.current[other] = props.navigation.revision
    }
    if (!props.fullscreen) props.expandComparison()
  }
  return <div className={css.root}>
    <header className={css.header}>
      <PreviewNavigation key={`${selected}:${props.navigation?.revision ?? 0}`} parent={props} lane={selected}
        surface={tabRuntime?.[selected]} urlDraft={view.urlDraft} compare={view.compare} toggleCompare={toggleCompare}
        liveAvailable={runtime.liveAvailable}
        showingLive={runtime.liveAvailable && view[selected].source === 'live' && tabRuntime?.[selected].phase !== 'unavailable'} />
      {!runtime.liveAvailable && <p className={css.hint} role="status">{t('desktopOnly')}</p>}
      {tabRuntime?.project !== undefined && <ProjectControls parent={props} project={tabRuntime.project} lane={selected} />}
    </header>
    <div className={clsx(css.devices, view.compare && css.comparison)}>
      {(['phone', 'tablet'] as const).map(lane => <PreviewLane key={lane}
        parent={props} lane={lane} view={view[lane]} surface={tabRuntime?.[lane]} liveAvailable={runtime.liveAvailable}
        active={view.compare || selected === lane} />)}
    </div>
    <footer className={css.statusBar}>
      <span>{t(runtime.liveAvailable && view[selected].source === 'live'
        && tabRuntime?.[selected].phase !== 'unavailable' ? 'live' : 'image')}</span>
      <HoverCard inline anchor={<Button size="sm" variant="ghost"><IconInfoOutlineRegular size={14} />{t('about')}</Button>}
        content={<p className={css.aboutCopy}>{t('limitation')}</p>} />
    </footer>
  </div>
}
