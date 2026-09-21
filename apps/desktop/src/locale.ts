/** Typed English copy owned by the Electron shell. */

export const en = {
  fileMenu: 'File',
  editMenu: 'Edit',
  viewMenu: 'View',
  helpMenu: 'Help',
  aboutMenu: 'About Harnessy',
  aboutDetail: 'Harnessy {version}',
  startupFailed: 'Harnessy could not start',
  trayOpen: 'Open Harnessy',
  trayExit: 'Exit Harnessy',
  trayTooltip: 'Harnessy — running in the background',
  pluginsMenu: 'Desktop Plugins…',
  pluginsMenuPackagedOnly: 'Desktop Plugins… (available in packaged applications)',
  pluginManagerTitle: 'Desktop Plugins',
  pluginWindowTitle: 'Harnessy — Desktop Plugins',
  pluginManagerDescription: 'Plugins are installed only in the Desktop node_modules and are managed by the bundled pnpm.',
  refresh: 'Refresh',
  npmPackage: 'npm package',
  install: 'Install',
  installed: 'Installed',
  noPlugins: 'No Desktop plugins are installed.',
  remove: 'Remove',
  update: 'Update',
  targetVersion: 'Enter the target version for {name}',
  removing: 'Removing {name}…',
  updating: 'Updating {name}…',
  installing: 'Installing {spec}…',
  operationComplete: 'Done. The Desktop backend has restarted.',
  refreshing: 'Refreshing…',
  refreshed: 'Plugin list refreshed.',
  loadingPlugins: 'Reading Desktop plugins…',
} as const

/** Desktop message keys and values. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }

/** Locale payload exposed to the Desktop-owned renderer. */
export interface DesktopLocale {
  readonly id: 'en'
  readonly messages: DesktopMessages
}

/** Resolve every Electron locale to the shipped English dictionary. */
export function resolveDesktopLocale(_locale: string): DesktopLocale {
  return { id: 'en', messages: en }
}

/** Replace named placeholders in one locale-owned message. */
export function formatDesktopMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder)
}
