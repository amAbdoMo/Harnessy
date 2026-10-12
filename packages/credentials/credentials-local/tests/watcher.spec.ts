import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

const fsHarness = vi.hoisted(() => ({
  nextReadError: undefined as NodeJS.ErrnoException | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (path: unknown, ...rest: never[]) => {
      const error = fsHarness.nextReadError
      if (error !== undefined) {
        fsHarness.nextReadError = undefined
        throw error
      }
      return (actual.readFile as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile,
  }
})

function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

// chokidar is the nondeterministic OS boundary: faking it lets these tests
// drive the event pipeline (error events, races with unreadable files)
// deterministically. Real end-to-end watching stays covered by local.spec.ts.
vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWatcher extends EventEmitter {
    close = vi.fn(() => Promise.resolve())
  }
  const instances: Array<{ path: string; options: unknown; watcher: InstanceType<typeof FakeWatcher> }> = []
  return {
    watch: vi.fn((path: string, options: unknown) => {
      const watcher = new FakeWatcher()
      instances.push({ path, options, watcher })
      return watcher
    }),
    __instances: instances,
  }
})

interface FakeChokidar {
  __instances: Array<{
    path: string
    options: { awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } }
    watcher: import('node:events').EventEmitter
  }>
}

async function fakeInstances(): Promise<FakeChokidar['__instances']> {
  const chokidar = await import('chokidar') as unknown as FakeChokidar
  return chokidar.__instances
}

const KEY = credentialRef('DSH_CRED_PIPE')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  fsHarness.nextReadError = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
  ;(await fakeInstances()).length = 0
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-watch-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => {
    await fiber.dispose()
  })
  await fiber
  return ctx
}

describe('watcher pipeline', () => {
  it('clamps the write-settle poll interval for a zero debounce', async () => {
    const dir = await tempDir()
    await boot({ path: join(dir, '.credentials.yaml'), debounceMs: 0 })
    const [instance] = await fakeInstances()
    expect(instance!.options.awaitWriteFinish).toEqual({ stabilityThreshold: 0, pollInterval: 1 })
  })

  it('permanently aborts source authority before once-only payload-free fanout while later writes remain readable', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, debounceMs: 5 })
    const recordKey = credentialKey('watcher-test', 'grant')
    const lastGood = { kind: 'grant' as const, payload: { token: 'last-good' } }
    await ctx.credentials.modifyRecord(recordKey, () => Promise.resolve(lastGood))
    const signal = ctx.credentials.sourceFailureSignal
    const seen: { listener: string; aborted: boolean; args: unknown[] }[] = []
    ctx.on('credentials/source-failed', (...args: unknown[]) => {
      seen.push({ listener: 'throwing', aborted: signal.aborted, args })
      throw new Error('source observer failed')
    })
    ctx.on('credentials/source-failed', (...args: unknown[]) => {
      seen.push({ listener: 'later', aborted: signal.aborted, args })
    })
    const [instance] = await fakeInstances()
    expect(signal.aborted).toBe(false)

    expect(() => instance!.watcher.emit('error', new Error('watch backend failure'))).not.toThrow()
    expect(signal.aborted).toBe(true)
    expect(seen).toEqual([
      { listener: 'throwing', aborted: true, args: [] },
      { listener: 'later', aborted: true, args: [] },
    ])
    expect(await ctx.credentials.readRecord(recordKey)).toEqual(lastGood)

    await ctx.credentials.set(KEY, 'arrived')
    const replacement = { kind: 'grant' as const, payload: { token: 'replacement' } }
    await ctx.credentials.modifyRecord(recordKey, () => Promise.resolve(replacement))
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'arrived', source: 'file' })
    expect(await ctx.credentials.readRecord(recordKey)).toEqual(replacement)
    expect(ctx.credentials.sourceFailureSignal).toBe(signal)
    expect(signal.aborted).toBe(true)
    instance!.watcher.emit('error', new Error('second watch backend failure'))
    expect(seen).toEqual([
      { listener: 'throwing', aborted: true, args: [] },
      { listener: 'later', aborted: true, args: [] },
    ])
  })

  it('keeps the last good snapshot when the file turns unreadable at runtime', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: good\n')
    const ctx = await boot({ path, debounceMs: 5 })

    await chmod(path, 0o000)
    cleanups.push(() => chmod(path, 0o600))
    const [instance] = await fakeInstances()
    instance!.watcher.emit('all', 'change', path)
    // The warn-and-keep path is asynchronous; give the serialized refresh a turn.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'good', source: 'file' })
  })

  it('keeps the last good snapshot when the read fails after its permission check', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: good\n')
    const ctx = await boot({ path, debounceMs: 5 })
    fsHarness.nextReadError = Object.assign(new Error('version: 1\nrefs:\n  EACCES: injected read failure\n'), { code: 'EACCES' })

    const [instance] = await fakeInstances()
    instance!.watcher.emit('all', 'change', path)
    await vi.waitFor(() => {
      expect(fsHarness.nextReadError).toBeUndefined()
    })
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'good', source: 'file' })
  })

  it('quiesces the refresh pipeline before dispose completes', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: initial\n')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path, debounceMs: 5 })
    await fiber
    let disposed = false
    let postDisposeCommits = 0
    ctx.on('credentials/reference-updated', () => {
      if (disposed) postDisposeCommits += 1
    })

    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: changed\n')
    const [instance] = await fakeInstances()
    // Two queued refreshes: dispose interrupts one mid-flight and the other
    // before it starts, so both closed guards must hold.
    instance!.watcher.emit('all', 'change', path)
    instance!.watcher.emit('all', 'change', path)
    await fiber.dispose()
    disposed = true
    instance!.watcher.emit('all', 'change', path)
    instance!.watcher.emit('ready')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(postDisposeCommits).toBe(0)
  })

  it('empties the snapshot when the document is deleted and emits the removals', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: doomed\n')
    const ctx = await boot({ path, debounceMs: 5 })
    const seen: string[] = []
    ctx.on('credentials/reference-updated', (ref) => {
      seen.push(ref)
    })

    await rm(path)
    const [instance] = await fakeInstances()
    instance!.watcher.emit('all', 'unlink', path)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    })
    expect(seen).toEqual([KEY])
  })

  it('keeps the last good snapshot when an external edit makes the document invalid', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: a\n')
    const ctx = await boot({ path, debounceMs: 5 })
    const seen: string[] = []
    ctx.on('credentials/reference-updated', (ref) => {
      seen.push(ref)
    })

    const failed = Promise.withResolvers<undefined>()
    const failures: boolean[] = []
    ctx.on('credentials/source-failed', () => {
      failures.push(ctx.credentials.sourceFailureSignal.aborted)
      failed.resolve(undefined)
    })
    await writeCredentials(path, 'version: 1\nrefs:\n  BAD-KEY: 2\n  DSH_CRED_PIPE: b\n')
    const [instance] = await fakeInstances()
    instance!.watcher.emit('all', 'change', path)
    await failed.promise
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'a', source: 'file' })
    expect(seen).toEqual([])
    expect(failures).toEqual([true])

    // Repair restores cached values, not source authority.
    await writeCredentials(path, 'version: 1\nrefs:\n  DSH_CRED_PIPE: b\n')
    instance!.watcher.emit('all', 'change', path)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'b', source: 'file' })
    })
    expect(seen).toEqual([KEY])
    expect(ctx.credentials.sourceFailureSignal.aborted).toBe(true)
    expect(failures).toEqual([true])
  })

  it('treats an event for a still-absent file as a no-op', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, debounceMs: 5 })
    const [instance] = await fakeInstances()
    instance!.watcher.emit('all', 'add', path)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
  })

  it('reconciles at watcher ready so a change during setup is not missed', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, `version: 1\nrefs:\n  ${KEY}: a\n`)
    const ctx = await boot({ path, debounceMs: 5 })
    // Written after the initial load but before the watcher became active:
    // no 'all' event will ever fire for it.
    await writeCredentials(path, `version: 1\nrefs:\n  ${KEY}: written-before-ready\n`)
    const [instance] = await fakeInstances()
    instance!.watcher.emit('ready')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'written-before-ready', source: 'file' })
    })
  })
})
