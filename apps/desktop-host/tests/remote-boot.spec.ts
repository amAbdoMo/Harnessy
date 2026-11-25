/** Loader composition keeps private HTTPS requests behind the existing Host and authentication fences. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { assertDesktopRemoteConnection, resolveDesktopRemoteConnection } from '../src/remote-connection.ts'
import { installBrowserShare } from '../src/browser-share.ts'

function readRoute(port: number, path: string, headers: Readonly<Record<string, string>>, method = 'GET'): Promise<{
  status: number | undefined
  headers: IncomingHttpHeaders
  body: string
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, headers, method }, (response) => {
      response.setEncoding('utf8')
      let body = ''
      response.on('data', (chunk: string) => { body += chunk })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode, headers: response.headers, body }) })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

it('admits the private authority only after authentication, keeps authority-bound cookies and refuses an occupied fixed port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-boot-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:credentials',
    '- name: cordis:webserver',
    '  config: { host: 127.0.0.1, port: 0 }',
    '- name: cordis:connection',
    '  config: { trustedHosts: [pc.tailnet.ts.net] }', '',
  ].join('\n'))
  const ctx = await boot('phone-test', config, [], (owner) => {
    owner.loader.builtins.webserver = WebServer
    owner.loader.builtins.connection = Connection
    owner.loader.builtins.credentials = {
      apply(inner: Context) {
        // Persistent credential storage is the external boundary; the real authentication and trust code run unchanged.
        inner.provide('credentials', { modifyRecord: async () => ({
          kind: 'grant', payload: { version: 1, secret: Buffer.alloc(32, 7).toString('base64url') },
        }) })
      },
    }
  })
  onTestFinished(() => ctx.fiber.dispose())
  const remote = resolveDesktopRemoteConnection({
    DSH_DESKTOP_REMOTE_URL: 'https://pc.tailnet.ts.net/', DSH_DESKTOP_LISTEN_PORT: String(ctx.webServer.port),
  })
  if (remote === undefined) throw new Error('Fixture remote opt-in missing')
  expect(() =>{  assertDesktopRemoteConnection(ctx, remote) }).not.toThrow()
  const headers = { host: remote.hostname, origin: 'https://pc.tailnet.ts.net', 'sec-fetch-site': 'same-origin' }
  expect(ctx.connection.requestRejection({ headers })).toBe(401)
  expect(ctx.connection.requestRejection({ headers: { ...headers, host: 'attacker.example' } })).toBe(403)
  expect(ctx.connection.requestRejection({ headers: { ...headers, origin: 'https://attacker.example' } })).toBe(403)
  expect(ctx.connection.requestRejection({ headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).toBe(403)
  expect(ctx.connection.requestRejection({ headers: { host: remote.hostname + ':8443' } })).toBe(401)

  const login = new URL(ctx.connection.authenticatedUrl(remote.remoteRoot))
  let cookie = ''
  expect(ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers }, {
    writeHead(_status, responseHeaders) { cookie = responseHeaders?.['set-cookie']?.split(';')[0] ?? '' },
    end() {},
  })).toBe(false)
  expect(cookie).not.toBe('')
  expect(ctx.connection.requestRejection({ headers: { ...headers, cookie } })).toBeUndefined()
  expect(ctx.connection.requestRejection({ headers: { host: `127.0.0.1:${String(ctx.webServer.port)}`, cookie } })).toBe(401)

  const viewId = 'e7ceaa5b-761d-4e48-9abc-9fa732df8617'
  const viewPath = `/api/browser-share?view=${viewId}`
  let captures = 0
  let stops = 0
  let live = true
  const browserShare = installBrowserShare(ctx, remote, async (message) => {
    if ('type' in message && message.type === 'browser-share-stop') {
      expect(message).toMatchObject({ id: viewId })
      stops++
      const status = live ? 'stopped' : 'ended'
      live = false
      browserShare.receive({ ...message, type: 'browser-share-stop-result', status })
      return
    }
    expect(message).toMatchObject({ type: 'browser-share-frame', id: viewId })
    captures++
    browserShare.receive({ ...message, type: 'browser-share-frame-result', status: live ? 'frame' : 'ended', jpeg: 'anBlZw==' })
  })
  const view = () => readRoute(remote.listenPort, viewPath, { ...headers, cookie })
  const frame = (requestHeaders: Readonly<Record<string, string>>) => readRoute(remote.listenPort, `${viewPath}&frame=1`, requestHeaders)
  await expect(frame(headers)).resolves.toMatchObject({ status: 401 })
  await expect(frame({ ...headers, cookie, 'sec-fetch-site': 'cross-site' })).resolves.toMatchObject({ status: 403 })
  expect(captures).toBe(0)
  const viewer = await view()
  expect(viewer).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' } })
  expect(viewer.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(viewer.body).toContain('Shared browser view')
  expect(viewer.body).toContain('Stop sharing')
  await expect(frame({ ...headers, cookie })).resolves.toMatchObject({ status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'jpeg' })
  const stop = (requestHeaders: Readonly<Record<string, string>>) => readRoute(remote.listenPort, viewPath, requestHeaders, 'POST')
  await expect(stop(headers)).resolves.toMatchObject({ status: 401 })
  await expect(stop({ host: remote.hostname, cookie })).resolves.toMatchObject({ status: 403 })
  await expect(stop({ ...headers, cookie, origin: 'https://other.example' })).resolves.toMatchObject({ status: 403 })
  expect(stops).toBe(0)
  await expect(stop({ ...headers, cookie })).resolves.toMatchObject({ status: 204 })
  expect(stops).toBe(1)
  await expect(stop({ ...headers, cookie })).resolves.toMatchObject({ status: 410 })
  await expect(frame({ ...headers, cookie })).resolves.toMatchObject({ status: 410 })

  const competing = new Context()
  onTestFinished(() => competing.fiber.dispose())
  const collision = competing.plugin(WebServer, { host: '127.0.0.1', port: remote.listenPort })
  await expect(collision.await()).rejects.toThrow(/EADDRINUSE/)
  expect(ctx.webServer.port).toBe(remote.listenPort)
})
