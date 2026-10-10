/** Narrow device-preview controls exposed only to the trusted application renderer. */
import { ipcRenderer } from 'electron'
import type { DesktopDevicePreviewBridge, DevicePreviewOpenRequest } from '@deepseek-ai/dsh-client-ui-device-preview/types'
import { DESKTOP_IPC } from './ipc.ts'
import { parseDevicePreviewOpenRequest } from './device-preview-protocol.ts'

/** @returns private IPC-backed controls and one contained opening-event subscription. */
export function createDesktopDevicePreviewBridge(): DesktopDevicePreviewBridge {
  const listeners = new Set<(request: DevicePreviewOpenRequest) => void>()
  ipcRenderer.on(DESKTOP_IPC.devicePreviewOpen, (_event, input: unknown) => {
    let request: DevicePreviewOpenRequest
    try { request = parseDevicePreviewOpenRequest(input) }
    catch (error: unknown) { console.error('Device preview opening event rejected', error); return }
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try { listener(request) }
      catch (error: unknown) { console.error('Device preview opening listener failed', error) }
    }
  })
  return {
    onOpenRequested: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    acknowledge: acknowledgement => ipcRenderer.invoke(DESKTOP_IPC.devicePreviewAcknowledge, acknowledgement) as Promise<void>,
    bind: binding => ipcRenderer.invoke(DESKTOP_IPC.devicePreviewBind, binding) as Promise<void>,
    unbind: binding => ipcRenderer.invoke(DESKTOP_IPC.devicePreviewUnbind, binding) as Promise<void>,
    close: id => ipcRenderer.invoke(DESKTOP_IPC.devicePreviewClose, id) as Promise<void>,
    stop: id => ipcRenderer.invoke(DESKTOP_IPC.devicePreviewStop, id) as Promise<void>,
  }
}
