/** Typed English and Chinese copy owned by the Electron shell. */

export const en = {
  fileMenu: 'File',
  editMenu: 'Edit',
  viewMenu: 'View',
  helpMenu: 'Help',
  aboutMenu: 'About Harnessy',
  aboutDetail: 'Harnessy {version}',
  startupFailed: 'Harnessy could not start',
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

/** Every Desktop locale supplies the complete English key set. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }

export const zh = {
  fileMenu: '文件',
  editMenu: '编辑',
  viewMenu: '视图',
  helpMenu: '帮助',
  aboutMenu: '关于 Harnessy',
  aboutDetail: 'Harnessy {version}',
  startupFailed: 'Harnessy 无法启动',
  pluginsMenu: '桌面插件…',
  pluginsMenuPackagedOnly: '桌面插件…（打包应用中可用）',
  pluginManagerTitle: '桌面插件',
  pluginWindowTitle: 'Harnessy — 桌面插件',
  pluginManagerDescription: '插件只安装到桌面端自己的 node_modules，并由内置 pnpm 管理。',
  refresh: '刷新',
  npmPackage: 'npm 包',
  install: '安装',
  installed: '已安装',
  noPlugins: '还没有安装桌面插件。',
  remove: '移除',
  update: '更新',
  targetVersion: '输入 {name} 的目标版本',
  removing: '正在移除 {name}…',
  updating: '正在更新 {name}…',
  installing: '正在安装 {spec}…',
  operationComplete: '操作完成，桌面后端已重新启动。',
  refreshing: '正在刷新…',
  refreshed: '插件列表已刷新。',
  loadingPlugins: '正在读取桌面插件…',
} as const satisfies DesktopMessages

/** Locale payload exposed to the Desktop-owned renderer. */
export interface DesktopLocale {
  readonly id: 'en' | 'zh-CN'
  readonly messages: DesktopMessages
}

/** Resolve Electron's locale to one shipped Desktop dictionary. */
export function resolveDesktopLocale(locale: string): DesktopLocale {
  return locale.toLowerCase().startsWith('zh')
    ? { id: 'zh-CN', messages: zh }
    : { id: 'en', messages: en }
}

/** Replace named placeholders in one locale-owned message. */
export function formatDesktopMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder)
}
