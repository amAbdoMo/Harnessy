/** Super Agent publishes its service before configured coordinator and Source plugins initialize. */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold
beforeAll(async () => {
  scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    profile: { packages: [{ dir: fileURLToPath(new URL('../../../vendor/superagent', import.meta.url)), enabled: true }] },
  })
})
afterAll(async () => { vi.restoreAllMocks(); await scaffold?.close() })

it('keeps GitHub registered and completes coordinator startup after saving an account', async () => {
  const request = (path: string, init: RequestInit = {}) => scaffold.hostFetch(`/orchestrator/api/${path}`, {
    ...init, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
  })
  const sources = await request('sources')
  expect(await sources.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'github', installed: true })]))
  const spawn = scaffold.ctx.subprocess.spawn.bind(scaffold.ctx.subprocess)
  vi.spyOn(scaffold.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const args = spec.argv.slice(1).join(' ')
    const text = args === 'api user' ? '{"login":"fixture-owner","id":7}'
      : args.startsWith('api repos/fixture-owner/fixture') ? '{"name":"fixture-owner/fixture","push":true}' : undefined
    if (spec.argv[0] !== process.execPath || text === undefined) return spawn(spec)
    return spawn({ ...spec, argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', text] })
  })
  expect((await request('executor/pause', { method: 'POST', body: JSON.stringify({ paused: true }) })).status).toBe(200)
  const saved = await request('settings/source:github', { method: 'PUT', body: JSON.stringify({ revision: 0,
    value: { enabled: false, config: { repository: 'fixture-owner/fixture', cli: process.execPath } } }) })
  expect(saved.status).toBe(200)
  await vi.waitFor(async () => {
    const state = await request('state')
    expect(await state.json()).toMatchObject({ paused: true, health: { runtime: { state: 'ready' } } })
    const updated = await request('sources')
    expect(await updated.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'github', installed: true, state: 'off' })]))
  }, { timeout: 15000 })
})
