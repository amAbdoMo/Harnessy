/** Lease-scoped browser operations and one main-process subscription per event per window. */
import { ipcRenderer } from 'electron'
import type {
  DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopWebsiteProfilesBridge, DesktopWebsiteRequestsBridge, DesktopWebsiteHostSnapshot,
  DesktopWebsiteProfileId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

function subscribeLeaseEvent<Args extends readonly [string] | readonly [string, number]>(channel: string,
  eventArgs: (request: { readonly url: string; readonly revision?: unknown }) => Args | undefined,
): (lease: DesktopBrowserLeaseId, listener: (...args: Args) => void) => () => void {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(...args: Args) => void>>()
  ipcRenderer.on(channel, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || Array.isArray(request) || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || request.lease.length === 0 || request.lease.length > 200
      || /\s|[\x00-\x1f\x7f-\x9f]/u.test(request.lease)
      || typeof request.url !== 'string' || request.url.length === 0 || request.url.length > 16 * 1024) return
    let address: URL
    try { address = new URL(request.url) }
    catch (error) { void error; return }
    if ((address.protocol !== 'https:' && address.protocol !== 'http:') || address.username !== '' || address.password !== '') return
    const args = eventArgs({ url: request.url, revision: 'revision' in request ? request.revision : undefined })
    if (args === undefined) return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      if (!callbacks.has(callback)) continue
      try { callback(...args) }
      catch (error) { console.error('Desktop browser lease listener failed', error) }
    }
  })
  return (lease, listener) => {
    let callbacks = listeners.get(lease)
    if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
    callbacks.add(listener)
    return () => {
      callbacks.delete(listener)
      if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
    }
  }
}

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const onOpenRequested = subscribeLeaseEvent(DESKTOP_IPC.browserOpenRequested, request => [request.url] as const)
  const onReacquireRequested = subscribeLeaseEvent(DESKTOP_IPC.browserReacquireRequested, (request) => {
    const revision = request.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return undefined
    return [request.url, revision] as const
  })
  const profileListeners = new Set<() => void>()
  ipcRenderer.on(DESKTOP_IPC.websiteProfilesChanged, () => {
    for (const listener of [...profileListeners]) {
      try { listener() }
      catch (error) { console.error('Website profile listener failed', error) }
    }
  })
  const requestListeners = new Set<() => void>()
  const preparedListeners = new Set<(request: DesktopWebsiteHostSnapshot) => void>()
  ipcRenderer.on(DESKTOP_IPC.websiteRequestPrepared, (_event, request: DesktopWebsiteHostSnapshot) => {
    for (const listener of [...preparedListeners]) {
      try { listener(request) }
      catch (_error: unknown) { console.error('Website request could not open its saved profile') }
    }
  })
  ipcRenderer.on(DESKTOP_IPC.websiteRequestsChanged, () => {
    for (const listener of [...requestListeners]) {
      try { listener() }
      catch (error) { console.error('Website request listener failed', error) }
    }
  })
  return {
    bind: (lease, sessionId) => ipcRenderer.invoke(DESKTOP_IPC.browserBind, lease, sessionId) as Promise<void>,
    control: (lease, human) => ipcRenderer.invoke(DESKTOP_IPC.browserControl, lease, human) as Promise<void>,
    status: lease => ipcRenderer.invoke(DESKTOP_IPC.browserStatus, lease) as ReturnType<NonNullable<DesktopBrowserBridge['status']>>,
    capture: lease => ipcRenderer.invoke(DESKTOP_IPC.browserCapture, lease) as ReturnType<NonNullable<DesktopBrowserBridge['capture']>>,
    pick: (lease, point) => ipcRenderer.invoke(DESKTOP_IPC.browserPick, lease, point) as ReturnType<NonNullable<DesktopBrowserBridge['pick']>>,
    completeOpen: (requestId, lease) => ipcRenderer.invoke(DESKTOP_IPC.browserCompleteOpen, requestId, lease) as Promise<void>,
    onAgentOpen: (listener) => {
      const receive = (_event: unknown, input: unknown): void => {
        if (typeof input !== 'object' || input === null || !('requestId' in input) || typeof input.requestId !== 'string'
          || !('sessionId' in input) || typeof input.sessionId !== 'string' || !('url' in input) || typeof input.url !== 'string') return
        if ('profileId' in input && typeof input.profileId !== 'string') return
        listener({ requestId: input.requestId, sessionId: input.sessionId, url: input.url,
          ...('profileId' in input && typeof input.profileId === 'string' ? { profileId: input.profileId as DesktopWebsiteProfileId } : {}) })
      }
      ipcRenderer.on(DESKTOP_IPC.browserAgentOpen, receive)
      return () => { ipcRenderer.removeListener(DESKTOP_IPC.browserAgentOpen, receive) }
    },
    onControlChanged: (listener) => {
      ipcRenderer.on(DESKTOP_IPC.browserControlChanged, listener)
      return () => { ipcRenderer.removeListener(DESKTOP_IPC.browserControlChanged, listener) }
    },
    requests: {
      onPrepared: (listener) => { preparedListeners.add(listener); return () => { preparedListeners.delete(listener) } },
      list: session => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsList, session) as ReturnType<DesktopWebsiteRequestsBridge['list']>,
      prepare: input => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsPrepare, input) as ReturnType<DesktopWebsiteRequestsBridge['prepare']>,
      visible: (id, visible) => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsVisible, id, visible) as ReturnType<DesktopWebsiteRequestsBridge['visible']>,
      acknowledge: receipt => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsAcknowledge, receipt) as Promise<void>,
      resume: receipt => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsResume, receipt) as ReturnType<DesktopWebsiteRequestsBridge['resume']>,
      takeover: id => ipcRenderer.invoke(DESKTOP_IPC.websiteRequestsTakeover, id) as Promise<void>,
      onChanged: (listener) => { requestListeners.add(listener); return () => { requestListeners.delete(listener) } },
    },
    profiles: {
      list: () => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesList) as ReturnType<DesktopWebsiteProfilesBridge['list']>,
      create: input => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesCreate, input) as ReturnType<DesktopWebsiteProfilesBridge['create']>,
      setUrl: (id, url) => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesUrl, id, url) as Promise<void>,
      acquire: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesAcquire, id) as ReturnType<DesktopWebsiteProfilesBridge['acquire']>,
      setControl: (id, control) => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesControl, id, control) as Promise<void>,
      setAccess: (id, access) => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesAccess, id, access) as Promise<void>,
      saveLogin: (id, login) => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesSaveLogin, id, login) as Promise<void>,
      removeLogin: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesRemoveLogin, id) as Promise<void>,
      signOut: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesSignOut, id) as Promise<void>,
      forget: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesForget, id) as Promise<void>,
      onChanged: (listener) => { profileListeners.add(listener); return () => { profileListeners.delete(listener) } },
    },
    acquire: (workspace, addressHint) => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace, addressHint) as ReturnType<DesktopBrowserBridge['acquire']>,
    command: (lease, command) => ipcRenderer.invoke(DESKTOP_IPC.browserCommand, lease, command) as Promise<void>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onOpenRequested,
    onReacquireRequested,
  }
}
