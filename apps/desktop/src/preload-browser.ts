/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type {
  DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopWebsiteProfilesBridge, DesktopWebsiteRequestsBridge,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  const profileListeners = new Set<() => void>()
  ipcRenderer.on(DESKTOP_IPC.websiteProfilesChanged, () => {
    for (const listener of [...profileListeners]) {
      try { listener() }
      catch (error) { console.error('Website profile listener failed', error) }
    }
  })
  const requestListeners = new Set<() => void>()
  ipcRenderer.on(DESKTOP_IPC.websiteRequestsChanged, () => {
    for (const listener of [...requestListeners]) {
      try { listener() }
      catch (error) { console.error('Website request listener failed', error) }
    }
  })
  return {
    requests: {
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
      acquire: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesAcquire, id) as ReturnType<DesktopWebsiteProfilesBridge['acquire']>,
      setControl: (id, control) => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesControl, id, control) as Promise<void>,
      signOut: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesSignOut, id) as Promise<void>,
      forget: id => ipcRenderer.invoke(DESKTOP_IPC.websiteProfilesForget, id) as Promise<void>,
      onChanged: (listener) => { profileListeners.add(listener); return () => { profileListeners.delete(listener) } },
    },
    acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace) as ReturnType<DesktopBrowserBridge['acquire']>,
    command: (lease, command) => ipcRenderer.invoke(DESKTOP_IPC.browserCommand, lease, command) as Promise<void>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
