import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopWebsiteHostSnapshot } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, QUIT_INSPECTION_DEADLINE_MS } from '../src/host-process.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []
const hosts: DesktopHostProcess[] = []
const releaseNativeWork: Array<() => void> = []

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'website-control') {
    const command = message.command
    if (command.action === 'sync' || command.action === 'drain' || command.action === 'remove') {
      process.send({ type: 'website-control', requestId: message.requestId })
      return
    }
    const snapshot = { id: command.id, profile: 'cd1b6493-c881-4967-a544-b0a49f2d847f', sessionId: 'owner',
      epoch: command.action === 'revoke' ? 2 : command.epoch, status: command.action === 'commit' ? 'granted' : command.action === 'revoke' ? 'revoked' : 'pending' }
    if (command.action === 'revoke' || command.epoch === 97) snapshot.terminal = true
    if (command.action === 'revoke') process.send({ type: 'website-revoked', snapshot })
    if (command.epoch === 99) snapshot.epoch = 1
    if (command.epoch === 98) {
      process.send({ type: 'update-tasks', requestId: message.requestId, active: false, error: 'wrong channel' })
      return
    }
    process.send({ type: 'website-control', requestId: message.requestId, snapshot })
    return
  }
  if (message.type === 'website-mcp') {
    if (message.serverName === 'missing') process.send({ type: 'website-mcp', requestId: message.requestId, error: 'MCP server is unavailable' })
    else if (message.serverName === 'wrong') process.send({ type: 'update-tasks', requestId: message.requestId, active: false, error: 'unrelated failure' })
    else process.send({ type: 'website-mcp', requestId: message.requestId, binding: { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/wp-json/mcp' } })
    return
  }
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type === 'quit-inspection') {
    // Ids divisible by three never answer; the others report scheduled work for odd ids.
    if (message.requestId % 3 === 0) return
    process.send({ type: 'quit-inspection', requestId: message.requestId, activeTasks: false, scheduledTasks: message.requestId % 2 === 1 })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

const OPERATION_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const snapshot = { id: '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce',
  profile: 'cd1b6493-c881-4967-a544-b0a49f2d847f', sessionId: 'owner-session', epoch: 7, status: 'granted' }
const results = []
const server = createServer((request, response) => {
  if (request.url === '/start') process.send({ type: 'website-operation', operationId: 1, operation: 'page-info', snapshot })
  if (request.url === '/cancel') process.send({ type: 'website-operation-cancel', operationId: 1 })
  if (request.url === '/disconnect') process.disconnect()
  if (request.url === '/exit') {
    response.end(JSON.stringify(results), () => {
      server.close()
      server.closeAllConnections()
    })
    return
  }
  response.end(JSON.stringify(results))
})
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port }))
let shutdownRequested = false
function finish() {
  server.close(() => {
    writeFileSync(join(process.argv[3], 'operation-results.json'), JSON.stringify(results))
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
}
process.on('message', message => {
  if (message.type === 'website-operation-result') {
    results.push(message)
    if (shutdownRequested) finish()
  }
  if (message.type !== 'shutdown') return
  shutdownRequested = true
  if (process.env.DSH_TEST_OPERATION_DRAIN !== '1' || results.length > 0) finish()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
  onPlatformSession?: ConstructorParameters<typeof DesktopHostProcess>[8],
): DesktopHostProcess {
  const host = new DesktopHostProcess(
    process.execPath, runtime, profile, undefined, environment, onFailure, undefined, undefined, onPlatformSession,
  )
  hosts.push(host)
  return host
}

afterEach(async () => {
  for (const release of releaseNativeWork.splice(0)) release()
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('refuses private observation without a captured owner and disallows late registration', async () => {
    const host = hostProcess(projectWithHost(OPERATION_HOST))
    const native = vi.fn(async () => ({ origin: 'https://portal.example.test', title: 'never', titleTruncated: false }))
    const { url } = await host.start()
    expect(() => host.onWebsitePageInfo(native, () => {})).toThrow('before child startup')
    await fetch(new URL('/start', url))
    await expect.poll(async (): Promise<unknown> => (await (await fetch(url)).json())).toMatchObject([{ operationId: 1, outcome: 'rejected' }])
    expect(native).not.toHaveBeenCalled()
  })

  it.each(['throw', 'callback'] as const)('closes operation admission after a %s transport failure even when a shell listener throws', async (failureMode) => {
    const runtime = projectWithHost(OPERATION_HOST)
    const failed = Promise.withResolvers<Error>()
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { diagnostic.mockRestore() })
    const host = hostProcess(runtime, runtime, failed.resolve, process.env, () => { throw new Error('closed shell') })
    const native = vi.fn(async () => ({ origin: 'https://portal.example.test', title: 'bounded', titleTruncated: false }))
    const detach = host.onWebsitePageInfo(native, () => {})
    onTestFinished(detach)
    const { url } = await host.start()
    const { ChildProcess, spawn } = await import('node:child_process')
    const child: unknown = vi.mocked(spawn).mock.results.at(-1)?.value
    if (!(child instanceof ChildProcess)) throw new Error('Fixture did not capture its child')
    const failure = new Error('private IPC transport unavailable')
    const send = vi.spyOn(child, 'send').mockImplementationOnce((...args) => {
      if (failureMode === 'throw') throw failure
      const callback = args.at(-1)
      if (typeof callback === 'function') callback(failure)
      return false
    })
    onTestFinished(() => { send.mockRestore() })
    await fetch(new URL('/start', url))
    expect(await failed.promise).toBe(failure)
    await expect(host.websiteControl({ action: 'sync', profiles: [] })).rejects.toThrow('unavailable')
    await fetch(new URL('/start', url))
    await host.stop(true)
    expect(native).toHaveBeenCalledTimes(1)
    expect(diagnostic).toHaveBeenCalled()
  })

  it('dispatches private page-info to its sole native owner and replies only after cancelled native work settles', async () => {
    const host = hostProcess(projectWithHost(OPERATION_HOST))
    const physical = Promise.withResolvers<{ origin: string; title: string; titleTruncated: boolean }>()
    releaseNativeWork.push(() =>{  physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false }) })
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted: PromiseWithResolvers<void> = Promise.withResolvers()
    const native = vi.fn(async (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => {
      expect(snapshot.epoch).toBe(7)
      signal.addEventListener('abort', () =>{  aborted.resolve() }, { once: true })
      entered.resolve(signal)
      return physical.promise
    })
    const detach = host.onWebsitePageInfo(native, () => {})
    onTestFinished(async () => { physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false }); await detach() })
    expect(() => host.onWebsitePageInfo(native, () => {})).toThrow('already registered')
    const { url } = await host.start()
    await fetch(new URL('/start', url))
    const signal = await entered.promise
    await fetch(new URL('/cancel', url))
    await aborted.promise
    expect(signal.aborted).toBe(true)
    expect(await (await fetch(url)).json()).toEqual([])
    physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false })
    await expect.poll(async (): Promise<unknown> => (await (await fetch(url)).json())).toMatchObject([{ operationId: 1, outcome: 'rejected' }])
    await fetch(new URL('/start', url))
    await host.stop(true)
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('fences native work immediately on disconnect while the child remains alive and drains only after physical settlement', async () => {
    const runtime = projectWithHost(OPERATION_HOST)
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const physical = Promise.withResolvers<{ origin: string; title: string; titleTruncated: boolean }>()
    const release = () => { physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false }) }
    releaseNativeWork.push(release)
    const entered = Promise.withResolvers<{ snapshot: DesktopWebsiteHostSnapshot; signal: AbortSignal }>()
    const native = vi.fn(async (snapshot: DesktopWebsiteHostSnapshot, signal: AbortSignal) => {
      entered.resolve({ snapshot, signal })
      return physical.promise
    })
    const detach = host.onWebsitePageInfo(native, () => {})
    onTestFinished(async () => { release(); await detach() })
    const { url } = await host.start()
    const { ChildProcess, spawn } = await import('node:child_process')
    const child: unknown = vi.mocked(spawn).mock.results.at(-1)?.value
    if (!(child instanceof ChildProcess)) throw new Error('Fixture did not capture its child')
    releaseNativeWork.push(() => { child.kill() })
    const disconnected = new Promise<void>((resolve) => { child.once('disconnect', resolve) })
    const exited = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    await fetch(new URL('/start', url))
    const { snapshot, signal } = await entered.promise
    const pendingControl = host.inspectQuit().then(() => undefined, (error: unknown) => error)
    await fetch(new URL('/disconnect', url))
    await disconnected
    expect(signal.aborted).toBe(true)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host disconnected'))
    expect(await pendingControl).toEqual(new Error('dsh desktop host disconnected'))
    expect(child.connected).toBe(false)
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expect(await (await fetch(url)).json()).toEqual([])
    await expect(host.websiteControl({ action: 'sync', profiles: [] })).rejects.toThrow('unavailable')
    // Exercise a packet already queued at the captured process boundary after IPC loss.
    child.emit('message', { type: 'website-operation', operationId: 2, operation: 'page-info', snapshot })
    await Promise.resolve()
    expect(native).toHaveBeenCalledTimes(1)
    expect(await (await fetch(new URL('/exit', url))).json()).toEqual([])
    await exited
    expect(failure).toHaveBeenCalledTimes(1)
    let settled = false
    const stopping = host.stop().then(() => { settled = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(settled).toBe(false)
    release()
    await stopping
    expect(settled).toBe(true)
    expect(native).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledTimes(1)
  })

  it.each(['dispose', 'shutdown'] as const)('withholds private success on %s before native quiescence and isolates a replacement child', async (action) => {
    const runtime = projectWithHost(OPERATION_HOST)
    const host = hostProcess(runtime)
    const physical = Promise.withResolvers<{ origin: string; title: string; titleTruncated: boolean }>()
    releaseNativeWork.push(() =>{  physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false }) })
    const entered = Promise.withResolvers<AbortSignal>()
    const detach = host.onWebsitePageInfo(async (_snapshot, signal) => { entered.resolve(signal); return physical.promise }, () => {})
    onTestFinished(async () => { physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false }); await detach() })
    const { url } = await host.start()
    await fetch(new URL('/start', url))
    const signal = await entered.promise
    let settled = false
    const pendingTeardown = action === 'dispose' ? detach() : host.stop(true)
    if (action === 'dispose') expect(detach()).toBe(pendingTeardown)
    const teardown = pendingTeardown.then(() => { settled = true })
    expect(signal.aborted).toBe(true)
    if (action === 'shutdown') await expect.poll(() => existsSync(join(runtime, 'operation-results.json'))).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    const replacement = hostProcess(projectWithHost(OPERATION_HOST))
    const replacementOwner = vi.fn(async () => ({ origin: 'https://replacement.example.test', title: 'fresh', titleTruncated: false }))
    const detachReplacement = replacement.onWebsitePageInfo(replacementOwner, () => {})
    onTestFinished(detachReplacement)
    const fresh = await replacement.start()
    physical.resolve({ origin: 'https://portal.example.test', title: 'late', titleTruncated: false })
    await teardown
    expect(await (await fetch(fresh.url)).json()).toEqual([])
    if (action === 'dispose') {
      await expect.poll(async (): Promise<unknown> => (await (await fetch(url)).json())).toMatchObject([{ operationId: 1, outcome: 'rejected' }])
      await host.stop(true)
    }
    const recorded: unknown = JSON.parse(readFileSync(join(runtime, 'operation-results.json'), 'utf8'))
    if (action === 'dispose') expect(recorded).toMatchObject([{ operationId: 1, outcome: 'rejected' }])
    else expect(recorded).toEqual([])
    await fetch(new URL('/start', fresh.url))
    await expect.poll(async (): Promise<unknown> => (await (await fetch(fresh.url)).json())).toMatchObject([
      { operationId: 1, outcome: 'success', value: { origin: 'https://replacement.example.test', title: 'fresh' } },
    ])
    expect(replacementOwner).toHaveBeenCalledTimes(1)
  })

  it('completes graceful shutdown when the child drains a physically pending native operation', async () => {
    const runtime = projectWithHost(OPERATION_HOST)
    const host = hostProcess(runtime, runtime, undefined, { ...process.env, DSH_TEST_OPERATION_DRAIN: '1' })
    const physical = Promise.withResolvers<{ origin: string; title: string; titleTruncated: boolean }>()
    const entered = Promise.withResolvers<AbortSignal>()
    releaseNativeWork.push(() =>{  physical.resolve({ origin: 'https://portal.example.test', title: 'private', titleTruncated: false }) })
    const detach = host.onWebsitePageInfo(async (_snapshot, signal) => {
      entered.resolve(signal)
      return physical.promise
    }, () => {})
    onTestFinished(async () => { physical.resolve({ origin: 'https://portal.example.test', title: 'private', titleTruncated: false }); await detach() })
    const { url } = await host.start()
    await fetch(new URL('/start', url))
    const signal = await entered.promise
    const stopping = host.stop(true)
    expect(signal.aborted).toBe(true)
    physical.resolve({ origin: 'https://portal.example.test', title: 'private', titleTruncated: false })
    await expect(stopping).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(join(runtime, 'operation-results.json'), 'utf8'))).toEqual([
      { type: 'website-operation-result', operationId: 1, snapshot: {
        id: '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce', profile: 'cd1b6493-c881-4967-a544-b0a49f2d847f',
        sessionId: 'owner-session', epoch: 7, status: 'granted',
      }, outcome: 'rejected' },
    ])
  }, 30_000)

  it('correlates exact website domain requests separately from process-control IDs and revoke notifications', async () => {
    const host = hostProcess(projectWithHost())
    const id = '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteHostSnapshot['id']
    await expect(host.websiteControl({ action: 'validate', id, epoch: 1 })).rejects.toThrow('Host is unavailable')
    const revocations: DesktopWebsiteHostSnapshot[] = []
    const detach = host.onWebsiteRevoked((snapshot) => { revocations.push(snapshot) })
    await host.start()
    expect(await host.websiteControl({ action: 'validate', id, epoch: 1 })).toMatchObject({ id, epoch: 1, status: 'pending' })
    expect(await host.websiteControl({ action: 'commit', id, epoch: 1 })).toMatchObject({ id, epoch: 1, status: 'granted' })
    await expect(host.websiteControl({ action: 'validate', id, epoch: 99 })).rejects.toThrow('different request or generation')
    await expect(host.websiteControl({ action: 'validate', id, epoch: 98 })).rejects.toThrow('different control response')
    expect(await host.websiteControl({ action: 'revoke', id })).toMatchObject({ id, epoch: 2, status: 'revoked' })
    expect(revocations).toHaveLength(1)
    expect(revocations[0]).toMatchObject({ id, status: 'revoked', terminal: true })
    await host.websiteControl({ action: 'drain', id })
    await host.websiteControl({ action: 'remove', id })
    detach()
    await host.websiteControl({ action: 'revoke', id })
    expect(revocations).toHaveLength(1)
    await host.stop(true)
  })

  it.each(['validate', 'commit'] as const)('rejects terminal snapshots while the %s response still admits work', async (action) => {
    const host = hostProcess(projectWithHost())
    const id = '38ac2aa4-f8ce-4b37-951c-80a4c0c117ce' as DesktopWebsiteHostSnapshot['id']
    await host.start()
    await expect(host.websiteControl({ action, id, epoch: 97 })).rejects.toThrow('invalid IPC event')
  })

  it('correlates website inspection by request id and type before interpreting errors', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectWebsiteMcp('portal')).rejects.toThrow('Website MCP registry: Host is unavailable')
    await host.start()
    expect(await Promise.all([host.inspectWebsiteMcp('portal'), host.updateTasks('lock')])).toEqual([
      { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/wp-json/mcp' }, true,
    ])
    await expect(host.inspectWebsiteMcp('missing')).rejects.toThrow('MCP server is unavailable')
    await expect(host.inspectWebsiteMcp('wrong')).rejects.toThrow('different control response')
    await host.stop(true)
    await expect(host.inspectWebsiteMcp('portal')).rejects.toThrow('Website MCP registry: Host is unavailable')
  })

  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it('correlates quit inspections with task requests and fails an unanswered one at its own deadline', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: Host is unavailable')
    await host.start()
    // Request ids 1 and 2: the fixture answers by id parity, so both control kinds share one id space.
    expect(await Promise.all([host.inspectQuit(), host.updateTasks('inspect')]))
      .toEqual([{ activeTasks: false, scheduledTasks: true }, false])
    const started = Date.now()
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: inspection timed out')
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUIT_INSPECTION_DEADLINE_MS - 50)
    expect(await host.inspectQuit()).toEqual({ activeTasks: false, scheduledTasks: false })
  }, 15_000)

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn<(error: Error) => void>()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure.mock.calls[0]?.[0].message).toMatch(/dsh desktop host (?:disconnected|exited with 7): plugin crashed/)
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.disconnect()', 'host disconnected'],
    ['process.exit(0)', /host (?:disconnected|stopped)/],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })
})

it.each([null, 'stable-account'])('carries Platform identity %s over private IPC and clears credentials on shutdown', async (userId) => {
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'", "process.send({ type: 'platform-session', session: { origin: 'https://platform.deepseek.com', userId: " + JSON.stringify(userId) + ", token: 'fixture-secret', embeddedPageDist: 'feat/test' } }); process.send({ type: 'ready'"))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await host.start()
  expect(changed).toHaveBeenCalledWith({ origin: 'https://platform.deepseek.com', userId, token: 'fixture-secret', embeddedPageDist: 'feat/test' })
  await host.stop()
  expect(changed).toHaveBeenLastCalledWith(null)
})

it.each([undefined, '', 7])('rejects malformed Platform account identity %s on private IPC', async (userId) => {
  const session = { origin: 'https://platform.deepseek.com', token: 'fixture-secret', userId }
  const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'",
    `process.send({ type: 'platform-session', session: ${JSON.stringify(session)} }); process.send({ type: 'ready'`))
  const changed = vi.fn()
  const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, changed)
  hosts.push(host)
  await expect(host.start()).rejects.toThrow('invalid IPC event')
  expect(changed.mock.calls).toEqual([[null]])
  await host.stop()
})
