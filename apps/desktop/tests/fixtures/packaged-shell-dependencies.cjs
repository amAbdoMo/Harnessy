/** Load the installed updater and taskbar native binding from application-owned dependencies. */
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { dirname, join, resolve, sep } = require('node:path')

const root = resolve(process.argv[2])
const resources = dirname(root)
const requireShell = createRequire(join(root, 'package.json'))
const updater = requireShell('electron-updater')
assert.equal(typeof updater.NsisUpdater, 'function', 'The packaged Windows updater must load')
const requireUpdater = createRequire(requireShell.resolve('electron-updater'))
const requireBuilder = createRequire(requireUpdater.resolve('builder-util-runtime'))
const debug = requireBuilder.resolve('debug')
const requireDebug = createRequire(debug)
const koffi = requireShell('koffi')
assert.equal(typeof koffi.load, 'function', 'The packaged native taskbar binding must load')
if (process.platform === 'win32') {
  koffi.load('gdi32.dll')
  koffi.load('user32.dll')
}
for (const path of [debug, requireDebug.resolve('ms'), requireShell.resolve('koffi')]) {
  assert.ok(path.startsWith(resources + sep), `Updater dependency resolved outside application resources: ${path}`)
}
console.log('Packaged shell: updater, logging and taskbar dependencies loaded from application resources')
