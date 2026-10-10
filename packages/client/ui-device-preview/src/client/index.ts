/** Desktop Device Preview registration; explicit openings and two ordinary pages stay outside React. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopDevicePreviewBridge, DevicePreviewId, DevicePreviewOpenRequest } from '../types.ts'
import { en, zh } from './copy.ts'
import { DevicePreview } from './DevicePreview.tsx'
import { DevicePreviewTitle } from './DevicePreviewTitle.tsx'
import { DevicePreviewNotice, type DevicePreviewStopNotice } from './DevicePreviewNotice.tsx'
import { DevicePreviewControllers } from './controller.ts'
import { createDevicePreviewStore, type DevicePreviewStore } from './store.ts'
import type { DevicePreviewInjected } from './model.ts'

const ID = '@deepseek-ai/dsh-client-ui-device-preview'
const KIND = 'device-preview'

interface SessionFace { readonly model: DevicePreviewControllers; actions: PropsStore<DevicePreviewStore>['actions'] }

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Initial editable URL; only an in-memory fresh native request authorizes automatic opening. */
    'device-preview': { readonly url?: string; readonly previewId?: DevicePreviewId }
  }
}

/** Registration services and the Desktop-only ordinary page provider. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'nativeBrowser']

/** @param ctx - captured registration context. Registers the guide, tab, title and outliving explicit Stop feedback. */
export function apply(ctx: Context): void {
  const desktop = globalThis as typeof globalThis & { readonly dshDesktop?: { readonly preview?: DesktopDevicePreviewBridge } }
  const transport = desktop.dshDesktop?.preview
  if (transport === undefined) throw new Error('Device preview requires the Desktop preview transport')
  const namespace = 'devicePreview'
  const t = ctx.locale.bind(namespace)
  const store = createDevicePreviewStore()
  const requests = new Map<DevicePreviewId, DevicePreviewOpenRequest>()
  const sessions = new Map<SessionId, SessionFace>()
  const notice = createSnapshotStore<DevicePreviewStopNotice | undefined>(undefined)
  let noticeSequence = 0
  const bridge: DesktopDevicePreviewBridge = { ...transport, close: (id) => { requests.delete(id); return transport.close(id) } }
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: KIND, priority: 'builtin', keepMounted: true,
    title: () => t('title'), guide: [{ id: 'new', order: 35, title: () => t('title'),
      description: () => t('guide.description'), icon: GuideArtworkBrowser }] }))

  ctx.effect(() => bridge.onOpenRequested((request) => {
    const target = ctx.sidebarRight.commandTarget(null)
    if (target === undefined || target.sessionId !== request.sessionId) {
      void bridge.acknowledge({ requestId: request.requestId, previewId: request.previewId, opened: false })
        .catch((error: unknown) => { console.error('Device preview declined-opening acknowledgement failed', error) })
      return
    }
    requests.set(request.previewId, request)
    try { ctx.sidebarRight.openTab(KIND, { params: { url: request.server.url, previewId: request.previewId } }) }
    catch (error: unknown) {
      requests.delete(request.previewId)
      console.error('Device preview tab opening failed', error)
      void bridge.acknowledge({ requestId: request.requestId, previewId: request.previewId, opened: false })
        .catch((failure: unknown) => { console.error('Device preview failed-opening acknowledgement failed', failure) })
    }
  }))

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: namespace, store,
    inject: (scopeId, actions): DevicePreviewInjected => {
      const sessionId = scopeId as SessionId
      let entry = sessions.get(sessionId)
      if (entry === undefined) {
        const captured: SessionFace = { actions, model: new DevicePreviewControllers({ sessionId, native: ctx.nativeBrowser, bridge,
          applicationOrigin: window.location.origin, request: id => requests.get(id),
          openLink: (url) => { ctx.sidebarRight.openTab('browser', { params: { url } }) },
          closed: (id) => { captured.actions.forget(id) },
          stopNotice: (success, url) => { notice.set({ sequence: ++noticeSequence, success, url }) },
        }) }
        entry = captured
        sessions.set(sessionId, entry)
      } else entry.actions = actions
      const model = entry.model
      return { retainTab: model.retainTab, mountSurface: model.mountSurface, updateSurface: model.updateSurface,
        navigate: model.navigate, reload: model.reload, goBack: model.goBack, goForward: model.goForward,
        stopProject: model.stopProject, expandComparison: () => {
          const target = ctx.sidebarRight.commandTarget()
          if (target !== undefined && target.sessionId === sessionId) ctx.sidebarRight.toggleFullscreen(target)
        }, hooks: { devicePreview: model.source } }
    },
  }, DevicePreview)))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID, locale: namespace,
  }, DevicePreviewTitle)))
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'device-preview.stop-notice', locale: namespace,
    inject: () => ({ dismiss: (sequence: number) => {
      if (notice.getSnapshot()?.sequence === sequence) notice.set(undefined)
    }, hooks: { stopNotice: notice } }),
  }, DevicePreviewNotice)))
  ctx.effect(() => async () => {
    requests.clear()
    const results = await Promise.allSettled([...sessions.values()].map(entry => entry.model.dispose()))
    sessions.clear()
    const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (errors.length !== 0) throw new AggregateError(errors, 'Device preview plugin could not drain')
  })
}
