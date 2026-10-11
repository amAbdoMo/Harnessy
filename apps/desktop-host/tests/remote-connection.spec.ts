/** Private remote opt-in validation and the source composition that owns Desktop readiness. */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { assertDesktopRemoteConnection, desktopWebArguments, resolveDesktopRemoteConnection } from '../src/remote-connection.ts'

const environment = { DSH_DESKTOP_REMOTE_URL: 'https://pc.tailnet.ts.net/', DSH_DESKTOP_LISTEN_PORT: '43821' }

function remote() {
  const value = resolveDesktopRemoteConnection(environment)
  if (value === undefined) throw new Error('Fixture remote opt-in missing')
  return value
}

describe('Desktop private remote configuration', () => {
  it('retains dynamic local-only startup without an opt-in and suppresses credential output in both modes', () => {
    expect(resolveDesktopRemoteConnection({})).toBeUndefined()
    expect(desktopWebArguments(undefined)).toEqual(['--no-open', '--no-print-url', '--port', '0'])
    const enabled = resolveDesktopRemoteConnection({
      DSH_DESKTOP_REMOTE_URL: 'HTTPS://PC.TAILNET.ts.net:443', DSH_DESKTOP_LISTEN_PORT: '43821',
    })
    expect(enabled).toEqual(remote())
    expect(desktopWebArguments(enabled)).toEqual([
      '--no-open', '--no-print-url', '--host', '127.0.0.1', '--port', '43821',
      '--public-url', 'https://pc.tailnet.ts.net/', '--trusted-host', 'pc.tailnet.ts.net',
    ])
  })

  it.each([
    { DSH_DESKTOP_REMOTE_URL: environment.DSH_DESKTOP_REMOTE_URL },
    { DSH_DESKTOP_LISTEN_PORT: environment.DSH_DESKTOP_LISTEN_PORT },
    { ...environment, DSH_DESKTOP_REMOTE_URL: '' },
    { ...environment, DSH_DESKTOP_LISTEN_PORT: '' },
    ...['0', '65536', '-1', '1.5', '1e3', ' 80', '80\n', 'NaN'].map(port => ({ ...environment, DSH_DESKTOP_LISTEN_PORT: port })),
    ...[
      'http://pc.tailnet.ts.net/', 'https://pc.example.net/', 'https://tailnet.ts.net/',
      'https://sub.pc.tailnet.ts.net/', 'https://-pc.tailnet.ts.net/', 'https://pc.tailnet.ts.net:8443/',
      'https://pc.tailnet.ts.net:/', 'https://pc.tailnet.ts.net:0443/', 'https://pc.tailnet.ts.net/path',
      'https://pc.tailnet.ts.net/./', 'https://pc.tailnet.ts.net/%2f', 'https://pc.tailnet.ts.net/?token=secret',
      'https://pc.tailnet.ts.net/#secret', 'https://user:secret@pc.tailnet.ts.net/',
      ' https://pc.tailnet.ts.net/', 'https://pc.tailnet.ts.net/\n', 'https://pc.tailnet.ts.net\\',
    ].map(root => ({ ...environment, DSH_DESKTOP_REMOTE_URL: root })),
  ])('rejects an incomplete or unsafe opt-in without including its input in diagnostics (%j)', (input) => {
    expect(() => resolveDesktopRemoteConnection(input)).toThrow(/DSH_DESKTOP_/)
    try { resolveDesktopRemoteConnection(input) }
    catch (error) { expect(String(error)).not.toContain('secret') }
  })

  it.each([
    ['0.0.0.0', 43821, 401], ['127.0.0.1', 43822, 401],
    ['127.0.0.1', 43821, 403], ['127.0.0.1', 43821, undefined],
  ] as const)('refuses readiness after a bind or admission override (%s, %s, %s)', (host, port, rejection) => {
    const ctx = new Context()
    ctx.provide('webServer', { host, port })
    ctx.provide('connection', { requestRejection: () => rejection })
    expect(() =>{  assertDesktopRemoteConnection(ctx, remote()) }).toThrow(/Desktop phone connection requires/)
  })

  it('requires authentication after checking the remote Host and matching HTTPS Origin', () => {
    const ctx = new Context()
    ctx.provide('webServer', { host: '127.0.0.1', port: 43821 })
    ctx.provide('connection', { requestRejection: (request: { headers: Record<string, string> }) => {
      expect(request.headers).toEqual({ host: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net', 'sec-fetch-site': 'same-origin' })
      return 401
    } })
    expect(() =>{  assertDesktopRemoteConnection(ctx, remote()) }).not.toThrow()
  })

  it('keeps the ready URL loopback and carries only the clean remote root over private Host IPC', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const patch = readFileSync(new URL('../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(entry).toContain('args: desktopWebArguments(remote)')
    expect(entry).toContain('assertDesktopRemoteConnection(ctx, remote)')
    expect(entry).toContain('ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)')
    expect(entry).toContain('{ remoteRoot: remote.remoteRoot }')
    expect(patch).toContain('printUrl: !!js ctx.webStartup.printUrl')
  })
})
