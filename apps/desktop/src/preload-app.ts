/** Context-isolated bridge for the main desktop application surface. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type DshDesktopAppApi } from './ipc.ts'

const api: DshDesktopAppApi = {
  protocolVersion: 1,
  titlebar: {
    openMenu: section => ipcRenderer.invoke(DESKTOP_IPC.menuOpen, section) as Promise<void>,
  },
  notifications: {
    show: payload => ipcRenderer.invoke(DESKTOP_IPC.notificationsShow, payload) as Promise<boolean>,
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
