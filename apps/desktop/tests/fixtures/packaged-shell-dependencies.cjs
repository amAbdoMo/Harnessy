/** Load the installed updater and require its logging dependencies to belong to the application. */
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
for (const path of [debug, requireDebug.resolve('ms')]) {
  assert.ok(path.startsWith(resources + sep), `Updater dependency resolved outside application resources: ${path}`)
}
console.log('Packaged shell: updater and logging dependencies loaded from application resources')
