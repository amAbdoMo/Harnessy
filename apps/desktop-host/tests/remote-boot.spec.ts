/** Loader composition keeps private HTTPS requests behind the existing Host and authentication fences. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { assertDesktopRemoteConnection, resolveDesktopRemoteConnection } from '../src/remote-connection.ts'

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

  const competing = new Context()
  onTestFinished(() => competing.fiber.dispose())
  const collision = competing.plugin(WebServer, { host: '127.0.0.1', port: remote.listenPort })
  await expect(collision.await()).rejects.toThrow(/EADDRINUSE/)
  expect(ctx.webServer.port).toBe(remote.listenPort)
})
