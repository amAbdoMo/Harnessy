/** Desktop-first right-sidebar presentation; parent injection owns pages, approvals and processes. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Tooltip, IconCompareSplitOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabParamsFor } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DevicePreviewInjected, DeviceProjectState, DeviceSurfaceState } from './model.ts'
import { initialPreviewView, type DeviceLaneView, type DevicePreviewStore } from './store.ts'
import type { DeviceLane } from './viewport.ts'
import type {} from './copy.ts'
import { DeviceControls } from './DeviceControls.tsx'
import { DeviceFrame } from './DeviceFrame.tsx'
import css from './DevicePreview.module.css'

/** All registration inputs are derived from framework shares. */
export type DevicePreviewProps = PropsRuntime<'sidebar.right.pane.tab'>
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
  const { tab } = parent.useTabInfo()
  const { t, actions } = parent
  const [edit, setEdit] = useState<{ readonly address: string | undefined; readonly draft: string }>()
  const draft = edit?.address === surface?.url ? edit?.draft ?? surface?.url ?? '' : surface?.url ?? ''
  const available = liveAvailable && surface?.phase !== 'unavailable'
  const live = available && view.source === 'live'
  const initialUrl = tab.navigation.params?.url ?? ''
  const publishScale = useCallback((scale: number): void => {
    actions.initialize(tab.id, initialUrl)
    actions.setScale(tab.id, lane, scale)
  }, [actions, tab.id, lane, initialUrl])
  const navigate = (event: FormEvent): void => { event.preventDefault(); if (live && draft.trim() !== '') parent.navigate(tab.id, lane, draft.trim()) }
  return <section className={css.lane} hidden={!active} aria-label={t(lane)}>
    <h2 className={css.laneTitle}>{t(lane)}</h2>
    <DeviceControls tabId={tab.id} lane={lane} view={view} t={t} actions={actions} liveAvailable={available} />
    {live && <form className={css.navigation} onSubmit={navigate}>
      <Tooltip portal label={t('back')}><Button size="sm" variant="toolbar" aria-label={t('back')} disabled={!surface?.canGoBack}
        onClick={() => { parent.goBack(tab.id, lane) }}><IconChevronLeftOutlineRegular size={14} /></Button></Tooltip>
      <Tooltip portal label={t('forward')}><Button size="sm" variant="toolbar" aria-label={t('forward')} disabled={!surface?.canGoForward}
        onClick={() => { parent.goForward(tab.id, lane) }}><IconChevronRightOutlineRegular size={14} /></Button></Tooltip>
      <Tooltip portal label={t('reload')}><Button size="sm" variant="toolbar" aria-label={t('reload')} disabled={surface?.url === undefined}
        onClick={() => { parent.reload(tab.id, lane) }}><IconRefreshOutlineRegular size={14} /></Button></Tooltip>
      <Input className={css.address as string} aria-label={t('url')} value={draft} spellCheck={false}
        onChange={(event) => { setEdit({ address: surface?.url, draft: event.currentTarget.value }) }} />
      <Button type="submit" size="sm" variant="outline" disabled={draft.trim() === ''}>{t('go')}</Button>
    </form>}
    <div className={css.noticeSlot} role="status">
      {surface?.failure !== undefined && t(`error.${surface.failure}`)}
      {surface?.failure === undefined && surface?.phase === 'error' && t('error.load')}
      {surface?.failure === undefined && surface?.phase === 'unavailable' && t('unavailable')}
    </div>
    <DeviceFrame tabId={tab.id} lane={lane} view={view} t={t} live={available} visible={tab.visible && active}
      surface={surface} mountSurface={parent.mountSurface} updateSurface={parent.updateSurface} publishScale={publishScale} />
  </section>
}

function ProjectControls({ parent, project }: { readonly parent: DevicePreviewProps; readonly project: DeviceProjectState }): ReactNode {
  const { tab } = parent.useTabInfo()
  const { t } = parent
  return <section className={css.project} aria-label={t('project.title')}>
    <span role="status">{t(`project.${project.phase}`)}</span>
    {project.phase !== 'external' && <Button size="sm" variant="ghost" disabled={!project.canStop}
      onClick={() => { parent.stopProject(tab.id) }}>{t('project.stop')}</Button>}
    {project.url !== undefined && <Button size="sm" variant="ghost"
      onClick={() => { if (project.url !== undefined) parent.actions.setUrl(tab.id, project.url) }}>{t('project.open')}</Button>}
  </section>
}

/**
 * Registration-ready tab body. A URL draft never navigates without a human Start or Go.
 * @param props - framework-bound stores, locale, tab facts and parent adapter callbacks.
 * @returns one device or an expanded independent phone/tablet comparison.
 */
export function DevicePreview(props: DevicePreviewProps): ReactNode {
  const { tab, sidebar } = props.useTabInfo()
  const params = tab.navigation.params as SidebarRightTabParamsFor<'device-preview'>
  const { t, actions } = props
  const saved = props.useStore(state => state.byTab[tab.id])
  const view = saved ?? initialPreviewView(tab.navigation.params?.url)
  const runtime = props.useDevicePreview(state => state)
  const tabRuntime = runtime.byTab[tab.id]
  useEffect(() => {
    actions.initialize(tab.id, tab.navigation.params?.url ?? '')
    if (params?.previewId !== undefined && params.url !== undefined) actions.setUrl(tab.id, params.url)
    if (props.retainTab(tab.id, tab.signal, tab.navigation.params?.url, params?.previewId)) {
      for (const lane of ['phone', 'tablet'] as const) actions.setSource(tab.id, lane, 'live')
    }
  }, [actions, props.retainTab, tab.id, tab.signal, tab.navigation.params?.url, params?.previewId])
  useEffect(() => tab.actions.bindCommands({ refresh: () => {
    if (!runtime.liveAvailable) return
    const lanes: readonly DeviceLane[] = view.compare ? ['phone', 'tablet'] : [view.selected]
    for (const lane of lanes) if (view[lane].source === 'live' && tabRuntime?.[lane].url !== undefined) props.reload(tab.id, lane)
  } }), [tab.actions, tab.id, props.reload, runtime.liveAvailable, tabRuntime, view])
  const start = (event: FormEvent): void => {
    event.preventDefault()
    const url = view.urlDraft.trim()
    if (!runtime.liveAvailable || url === '') return
    for (const lane of ['phone', 'tablet'] as const) { actions.setSource(tab.id, lane, 'live'); props.navigate(tab.id, lane, url) }
  }
  return <div className={css.root}>
    <header className={css.header}>
      <form className={css.startRow} onSubmit={start}>
        <Input className={css.address as string} value={view.urlDraft} placeholder={t('url.placeholder')} aria-label={t('url')}
          spellCheck={false} onChange={(event) => { actions.setUrl(tab.id, event.currentTarget.value) }} />
        <Button type="submit" size="sm" variant="primary" disabled={!runtime.liveAvailable || view.urlDraft.trim() === ''}>{t('start')}</Button>
      </form>
      <div className={css.controlRow}>
        {!view.compare && <div className={css.choiceGroup} role="group" aria-label={t('device')}>
          {(['phone', 'tablet'] as const).map(lane => <Button key={lane} size="sm" variant="ghost" aria-pressed={view.selected === lane}
            onClick={() => { actions.selectLane(tab.id, lane) }}>{t(lane)}</Button>)}
        </div>}
        <Button size="sm" variant="outline" aria-pressed={view.compare}
          onClick={() => {
            actions.setCompare(tab.id, !view.compare)
            if (!view.compare && !sidebar.fullscreen) props.expandComparison()
          }}><IconCompareSplitOutlineRegular size={14} />{t(view.compare ? 'single' : 'compare')}</Button>
      </div>
      {view.compare && <p className={css.hint}>{t('compare.hint')}</p>}
      <p className={css.hint}>{t('limitation')}</p>
      {!runtime.liveAvailable && <p className={css.hint} role="status">{t('desktopOnly')}</p>}
      {tabRuntime?.project !== undefined && <ProjectControls parent={props} project={tabRuntime.project} />}
    </header>
    <div className={clsx(css.devices, view.compare && css.comparison)}>
      {(['phone', 'tablet'] as const).map(lane => <PreviewLane key={lane}
        parent={props} lane={lane} view={view[lane]} surface={tabRuntime?.[lane]} liveAvailable={runtime.liveAvailable}
        active={view.compare || view.selected === lane} />)}
    </div>
  </div>
}
