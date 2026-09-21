/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  menuOpen: 'dsh-desktop:menu-open',
  notificationsShow: 'dsh-desktop:notifications-show',
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
} as const

/** Native menu groups opened from the integrated Windows title bar. */
export type DesktopMenuSection = 'file' | 'edit' | 'view' | 'help'

/** Narrow bridge exposed to the main application renderer. */
export interface DshDesktopAppApi {
  readonly protocolVersion: 1
  readonly titlebar: {
    openMenu(section: DesktopMenuSection): Promise<void>
  }
  readonly notifications: {
    show(payload: DesktopNotificationPayload): Promise<boolean>
  }
}

/** Secret-free copy accepted by the native operating-system notification surface. */
export interface DesktopNotificationPayload {
  readonly title: string
  readonly body: string
}

/**
 * Validate notification copy crossing the renderer-to-main process boundary.
 * @param value - untrusted IPC argument.
 * @returns bounded native notification copy.
 */
export function parseDesktopNotificationPayload(value: unknown): DesktopNotificationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh desktop: notification payload must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.title !== 'string' || typeof candidate.body !== 'string') {
    throw new Error('dsh desktop: notification title and body must be strings')
  }
  const title = candidate.title.trim()
  const body = candidate.body.trim()
  if (title.length === 0 || title.length > 120 || body.length === 0 || body.length > 500) {
    throw new Error('dsh desktop: notification title or body has an invalid length')
  }
  return { title, body }
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
}
