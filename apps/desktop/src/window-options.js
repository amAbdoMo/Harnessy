/** BrowserWindow options: a native shell with no renderer access to Node or Electron. */
export function createWindowOptions({ icon, productName, useDarkColors = false }) {
  return {
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: productName,
    icon,
    backgroundColor: useDarkColors ? '#06151d' : '#f4f9fa',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  }
}
