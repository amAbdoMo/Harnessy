/** Owned loopback TLS fixture only; never attaches to the user's Harness or browser session. */
import assert from 'node:assert/strict'
import { randomUUID, X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'

const root = process.argv[2]
assert.ok(root && resolve(root) === root)
app.setPath('userData', join(root, 'chromium'))
app.disableHardwareAcceleration()
// Retain this owned process until all fixture windows, Sessions and TLS sockets settle.
app.on('window-all-closed', () => {})
async function main() {
const inputPath = join(root, 'fixture-input.json')
const { certificates } = JSON.parse(await readFile(inputPath, 'utf8'))
await unlink(inputPath)
const { bindBrowserCertificateErrors } = await import(pathToFileURL(join(root, 'source-policy.mjs')).href)
const { DesktopBrowserGuests } = await import(pathToFileURL(join(root, 'source-guests.mjs')).href)
const leaves = certificates.map(value => new X509Certificate(Buffer.from(value.der, 'base64')))
const sockets = new Set()
const windows = []
const leaseFixtures = []
let requests = 0
const server = createServer({ pfx: Buffer.from(certificates[0].pfx, 'base64'), passphrase: 'fixture', handshakeTimeout: 5000 }, (_request, response) => {
  requests++
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Owned TLS fixture loaded</title><p>Owned synthetic TLS page.</p>')
})
server.on('connection', socket => {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
})
const observations = []
let failure
try {
  console.info('NATIVE_STAGE policy-loaded')
  await app.whenReady()
  console.info('NATIVE_STAGE electron-ready')
  await new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveReady)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `https://127.0.0.1:${address.port}`
  function fixture(accepted) {
    const partition = `owned-certificate-${randomUUID()}`
    const window = new BrowserWindow({ show: false, webPreferences: {
      partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    } })
    const guest = window.webContents
    const prompts = []
    guest.on('certificate-error', (_event, url, error, certificate, _callback, mainFrame) => {
      observations.push({ url, error, mainFrame, fingerprint: certificate.fingerprint,
        validStart: certificate.validStart, validExpiry: certificate.validExpiry })
    })
    const dispose = bindBrowserCertificateErrors(guest, guest,
      url => !window.isDestroyed() && new URL(url).origin === origin,
      async prompt => { prompts.push({ origin: prompt.origin, fingerprint: prompt.fingerprint }); return accepted })
    const value = { window, guest, prompts, dispose, storage: session.fromPartition(partition) }
    windows.push(value)
    return value
  }
  // Exercise both real reservation/attachment entry paths, not just the certificate helper.
  for (const profile of [undefined, 'owned-local-profile']) {
    const ownerWindow = new BrowserWindow({ show: false, webPreferences: {
      webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false,
    } })
    await ownerWindow.loadURL('data:text/html,<!doctype html><title>Owned native guest host</title><body></body>')
    const prompts = []
    const guests = new DesktopBrowserGuests(() => undefined, () => true,
      async prompt => { prompts.push(prompt); return true })
    guests.bind(ownerWindow, () => () => {})
    ownerWindow.webContents.on('will-attach-webview', (event, _preferences, params) => {
      console.info('NATIVE_STAGE will-attach', JSON.stringify({ src: params.src, partition: params.partition, denied: event.defaultPrevented }))
    })
    ownerWindow.webContents.on('console-message', (_event, _level, message) => { console.info('NATIVE_STAGE renderer', message) })
    const reservation = profile === undefined
      ? guests.acquire(ownerWindow.webContents, 'owned-workspace', origin)
      : guests.acquireProfile(ownerWindow.webContents, profile, origin)
    leaseFixtures.push({ guests, ownerWindow, reservation })
    const guest = await new Promise((resolveGuest, reject) => {
      const deadline = setTimeout(() => reject(new Error('Owned webview attachment timed out')), 10000)
      ownerWindow.webContents.once('did-attach-webview', (_event, value) => {
        value.once('dom-ready', () => { clearTimeout(deadline); resolveGuest(value) })
      })
      const html = `<webview partition="${reservation.partition}" src="about:blank#${reservation.lease}"></webview>`
      void ownerWindow.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}`)
        .catch(error => { clearTimeout(deadline); reject(error) })
    })
    const titled = new Promise((resolveTitle, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Owned lease title did not commit; URL=${guest.getURL()}; prompts=${prompts.length}; requests=${requests}`)), 10000)
      const onTitle = (_event, title) => {
        if (title === 'Owned TLS fixture loaded') { clearTimeout(deadline); guest.removeListener('page-title-updated', onTitle); resolveTitle() }
      }
      guest.on('page-title-updated', onTitle)
    })
    await guest.loadURL(`${origin}/${profile === undefined ? 'ordinary-lease' : 'saved-profile-lease'}`)
    await titled
    assert.equal(guest.getTitle(), 'Owned TLS fixture loaded')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].fingerprint, leaves[0].fingerprint256)
    assert.equal(prompts[0].owner, ownerWindow.webContents)
    assert.ok(!reservation.partition.startsWith('persist:'))
    if (profile !== undefined) assert.equal(guests.inspectWebsite(ownerWindow.webContents, reservation.lease)?.profile, profile)
    await guests.release(ownerWindow.webContents, reservation.lease)
    ownerWindow.destroy()
  }
  const first = fixture(true)
  await first.guest.loadURL(`${origin}/first`)
  assert.equal(first.guest.getTitle(), 'Owned TLS fixture loaded')
  assert.equal(first.prompts.length, 1)
  assert.equal(first.prompts[0].fingerprint, leaves[0].fingerprint256)
  assert.equal(observations[0].fingerprint,
    `sha256/${Buffer.from(leaves[0].fingerprint256.replaceAll(':', ''), 'hex').toString('base64')}`)
  assert.equal(observations[0].mainFrame, true)
  await first.guest.loadURL(`${origin}/reload`)
  assert.equal(first.prompts.length, 1)
  server.setSecureContext({ pfx: Buffer.from(certificates[1].pfx, 'base64'), passphrase: 'fixture' })
  for (const socket of sockets) socket.destroy()
  await first.storage.closeAllConnections()
  await first.guest.loadURL(`${origin}/rotated`)
  assert.equal(first.prompts.length, 2)
  assert.equal(first.prompts[1].fingerprint, leaves[1].fingerprint256)
  const denied = fixture(false)
  const beforeDenied = requests
  await assert.rejects(denied.guest.loadURL(`${origin}/new-session`), /ERR_CERT_AUTHORITY_INVALID/u)
  assert.equal(denied.prompts.length, 1)
  assert.equal(denied.prompts[0].fingerprint, leaves[1].fingerprint256)
  assert.equal(requests, beforeDenied, 'Denied new Session must not send an HTTP request')
} catch (error) {
  failure = error
} finally {
  for (const { guests, ownerWindow, reservation } of leaseFixtures) {
    if (!ownerWindow.isDestroyed()) {
      await guests.release(ownerWindow.webContents, reservation.lease)
      ownerWindow.destroy()
    }
  }
  for (const item of windows) {
    item.dispose()
    if (!item.window.isDestroyed()) {
      const destroyed = new Promise(resolveDestroyed => item.guest.once('destroyed', resolveDestroyed))
      item.window.destroy()
      await destroyed
    }
    await item.storage.clearStorageData()
    await item.storage.closeAllConnections()
  }
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()))
}
if (failure !== undefined) {
  console.error(failure)
  app.exit(1)
} else {
  assert.equal(sockets.size, 0)
  console.info(`NATIVE_CERTIFICATE_RESULT ${JSON.stringify({ pid: process.pid, electron: process.versions.electron,
    quiescent: true, observations, checks: ['actual-native-base64', 'manual-consent', 'canonical-prompt',
      'ordinary-real-guest-lease', 'saved-profile-real-guest-lease',
      'same-leaf-reuse', 'certificate-rotation', 'new-session-cancel'] })}`)
  app.exit(0)
}
}
// Electron must finish evaluating its entry module before readiness; do not top-level-await it.
void main().catch(error => { console.error(error); app.exit(1) })
