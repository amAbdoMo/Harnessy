/** Windows differential transfer qualification with synthetic bytes and the real updater. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { DesktopNsisUpdater, DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'
import { artifactDigest, createArtifactUpdateServer } from './artifact-update-server.mjs'

const blockSize = 32 * 1024

async function writePayload(file, values) {
  const blocks = values.map(value => Buffer.alloc(blockSize, value))
  const checksums = blocks.map(bytes => createHash('sha256').update(bytes).digest('base64'))
  await writeFile(file, Buffer.concat(blocks))
  await writeFile(`${file}.blockmap`, gzipSync(JSON.stringify({ version: '2', files: [
    { name: 'file', offset: 0, sizes: blocks.map(block => block.length), checksums },
  ] })))
}

/** @param {string} root Private fixture directory allocated by the launcher. */
export async function qualifyDifferentialUpdates(root) {
  const old = join(root, 'old.exe')
  const target = join(root, 'target.exe')
  await writePayload(old, [1, 2, 3])
  await writePayload(target, [1, 7, 3])
  const server = await createArtifactUpdateServer({ signed: target, unsigned: target,
    old, signedBlockmap: `${target}.blockmap`, oldBlockmap: `${old}.blockmap` })
  const result = []
  const forbidden = () => { throw new Error('Installer execution is forbidden in differential qualification') }
  try {
    for (const mode of ['changed-bytes-only', 'missing-base', 'missing-old-blockmap', 'ignore-ranges']) {
      const directory = join(root, mode)
      const config = join(directory, 'app-update.yml')
      const cache = join(directory, 'cache')
      await mkdir(cache, { recursive: true })
      await writeFile(config, 'updaterCacheDirName: cache\n')
      if (mode !== 'missing-base') await writePayload(join(cache, 'installer.exe'), [1, 2, 3])
      server.select('signed', false, mode)
      const start = server.requests.length
      const payload = () => server.requests.slice(start).filter(request => request.path.endsWith('.exe'))
      const updater = new DesktopNsisUpdater(undefined, {
        version: '1.0.0', name: 'differential-qualification', isPackaged: true,
        appUpdateConfigPath: config, userDataPath: directory, baseCachePath: directory,
        whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden,
      })
      const diagnostics = []
      updater.logger = { info: () => {}, warn: () => {}, error: message => diagnostics.push(String(message)) }
      updater.httpExecutor = new DesktopUpdateHttpExecutor(5_000)
      updater.setFeedURL({ provider: 'generic', url: server.url, channel: 'nightly', useMultipleRangeRequest: false })
      updater.quitAndInstall = forbidden
      const coordinator = new DesktopUpdateCoordinator(state => state, forbidden, updater, () => true, () => '1.0.0')
      coordinator.setStableOnly(false)
      try {
        const state = await coordinator.check()
        if (mode === 'changed-bytes-only') {
          assert.equal(state.phase, 'ready', diagnostics.join('\n'))
          assert.deepEqual(payload().map(request => request.bytes), [blockSize])
          assert.ok(payload().every(request => request.range))
        } else {
          assert.equal(state.phase, 'full-download-required')
          assert.equal(state.totalBytes, blockSize * 3)
          assert.equal(await coordinator.check(true), state)
          assert.equal(await coordinator.download(state.version), state)
          assert.ok(payload().every(request => request.range))
          if (mode === 'ignore-ranges') assert.equal(payload().length, 1)
          assert.equal((await coordinator.downloadFull(state)).phase, 'ready')
          assert.deepEqual(payload().filter(request => !request.range).map(request => request.bytes), [blockSize * 3])
        }
        assert.equal(await artifactDigest(updater.installerPath), server.artifacts.signed.sha512)
        result.push(mode)
      } finally { coordinator.dispose() }
    }
    assert.deepEqual(server.failures, [])
    return result
  } finally { await server.close() }
}
