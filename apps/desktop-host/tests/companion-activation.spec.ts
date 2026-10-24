import { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { composition, config } from '../../../packages/host/companion-host/tests/composition.ts'
import { SocketTransport } from '../../../packages/host/companion-host/tests/transport.ts'
import { RECORD_KEY, fingerprint } from '../../../packages/host/companion-host/src/records.ts'
import { exportPublicKey, generateP256KeyPair, parseId } from '@deepseek-ai/dsh-companion-protocol'
import type { GrantId } from '@deepseek-ai/dsh-companion-protocol'
import { DesktopCompanionActivation } from '../src/companion-activation.ts'
import { installDesktopCompanionControls } from '../src/companion.ts'

// Only the external socket is replaced; activation, Host, Loader and positive-case credential storage are real.
vi.mock('ws', async () => {
  const { SocketTransport: WebSocket } = await import('../../../packages/host/companion-host/tests/transport.ts')
  return { WebSocket }
})

const consentKey = credentialKey('companion-host', 'desktop-consent')
const consent: CredentialRecord = { kind: 'grant', payload: { v: 1, httpsOrigin: config.httpsOrigin } }

/** In-memory external credential I/O for cases that must never acquire the real Host's dependencies. */
class CredentialIo extends CredentialProvider {
  readonly records = new Map<CredentialKey, CredentialRecord>()
  readonly writes: CredentialKey[] = []
  readonly reads: CredentialKey[] = []
  attempts = 0
  beforeRead: (() => Promise<void>) | undefined
  beforeWrite: (() => Promise<void>) | undefined
  afterWrite: (() => void) | undefined

  fail(): void { this.notifySourceFailure() }
  override resolve(): never { throw new Error('Unexpected reference I/O') }
  override describe(): never { throw new Error('Unexpected reference I/O') }
  override set(): never { throw new Error('Unexpected reference I/O') }
  override unset(): never { throw new Error('Unexpected reference I/O') }
  override describeRecord(): never { throw new Error('Unexpected record metadata I/O') }
  override listRecords(): never { throw new Error('Unexpected enumeration I/O') }
  override deleteRecord(): never { throw new Error('Unexpected deletion I/O') }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.reads.push(key)
    await this.beforeRead?.()
    return this.records.get(key)
  }

  override modifyRecord(key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    this.attempts++
    return this.withRecords(async () => {
      await this.beforeWrite?.()
      const next = await mutate(this.records.get(key))
      if (next !== undefined) {
        this.records.set(key, next)
        this.writes.push(key)
        this.afterWrite?.()
      }
      return this.records.get(key)
    })
  }
}

function minimal(record?: CredentialRecord) {
  const ctx = new Context()
  const io = new CredentialIo(ctx)
  const owner = new AbortController()
  const release: (() => void)[] = []
  const pending: Promise<unknown>[] = []
  if (record !== undefined) io.records.set(consentKey, record)
  onTestFinished(async () => {
    owner.abort()
    for (const finish of release) finish()
    await Promise.allSettled(pending)
    await ctx.fiber.dispose()
  })
  const activation = new DesktopCompanionActivation(ctx, config, owner)
  return { ctx, io, owner, activation,
    releaseOnCleanup: (finish: () => void) => { release.push(finish) },
    settleOnCleanup: (work: Promise<unknown>) => { pending.push(work) } }
}

function unmounted(fixture: ReturnType<typeof minimal>): void {
  expect(fixture.ctx.get('companionHost')).toBeUndefined()
  expect(fixture.io.records.has(RECORD_KEY)).toBe(false)
  expect(fixture.io.writes.filter(key => key !== consentKey)).toEqual([])
  expect(SocketTransport.instances).toHaveLength(0)
}

async function readyDependencies() {
  const fixture = await composition({})
  onTestFinished(async () => {
    fixture.owner.abort()
    await fixture.close()
    for (const socket of SocketTransport.instances) expect(socket.readyState).toBe(3)
    SocketTransport.instances.length = 0
  })
  const entry = [...fixture.ctx.loader.entries()].find(row => row.options.id === 'companion')
  if (entry === undefined) throw new Error('Missing fixture companion entry')
  await fixture.ctx.loader.update(entry.id, { disabled: true })
  await fixture.ctx.loader.await()
  expect(fixture.ctx.get('companionHost')).toBeUndefined()
  expect(await fixture.ctx.credentials.readRecord(RECORD_KEY)).toBeUndefined()
  expect(SocketTransport.instances).toHaveLength(0)
  return fixture
}

async function privateControlRequests(fixture: Awaited<ReturnType<typeof readyDependencies>>) {
  let deliver: (message: object) => void = () => { throw new Error('Unsolicited private response') }
  const controls = installDesktopCompanionControls(fixture.ctx, config, fixture.owner, async (message) => { deliver(message) })
  await controls.initialize()
  return (command: object, requestId: number): Promise<object> => {
    const response = Promise.withResolvers<object>()
    deliver = response.resolve
    controls.receive({ type: 'companion-control', requestId, command })
    return response.promise
  }
}

describe('Desktop companion consent and activation', () => {
  it('leaves an unconfigured deployment disabled without even requiring credentials', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const activation = new DesktopCompanionActivation(ctx, {}, new AbortController())
    await activation.initialize()
    expect(activation.describe()).toEqual({ kind: 'status', status: {
      available: false, connected: false, paired: [], candidates: [],
    } })
    await expect(activation.activate()).rejects.toThrow('disabled')
    expect(ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(0)
  })

  it('requires explicit activation on ordinary startup without mounting or writing identity', async () => {
    const f = minimal()
    await f.activation.initialize()
    expect(f.activation.describe()).toEqual({ kind: 'activationRequired' })
    expect(f.io.reads).toEqual([consentKey])
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })

  it.each([
    ['wrong credential kind', { kind: 'api-key' }],
    ['null payload', { kind: 'grant', payload: null }],
    ['missing version', { kind: 'grant', payload: { httpsOrigin: config.httpsOrigin } }],
    ['future version', { kind: 'grant', payload: { v: 2, httpsOrigin: config.httpsOrigin } }],
    ['non-string origin', { kind: 'grant', payload: { v: 1, httpsOrigin: 7 } }],
    ['extra authority field', { kind: 'grant', payload: { v: 1, httpsOrigin: config.httpsOrigin, approved: true } }],
    ['different origin', { kind: 'grant', payload: { v: 1, httpsOrigin: 'https://other.invalid' } }],
    ['noncanonical origin', { kind: 'grant', payload: { v: 1, httpsOrigin: `${config.httpsOrigin}/` } }],
  ] satisfies [string, CredentialRecord][])('refuses %s consent without replacing it or creating identity', async (_name, record) => {
    const f = minimal(record)
    await expect(f.activation.initialize()).rejects.toThrow(/consent/)
    await expect(f.activation.activate()).rejects.toThrow(/consent/)
    expect(f.io.records.get(consentKey)).toEqual(record)
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })

  it.each(['parent', 'source'] as const)('refuses startup and activation after %s failure', async (failure) => {
    const f = minimal(consent)
    if (failure === 'parent') f.owner.abort()
    else f.io.fail()
    await expect(f.activation.initialize()).rejects.toThrow()
    await expect(f.activation.activate()).rejects.toThrow()
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })

  it.each(['parent', 'source'] as const)('rechecks %s lifetime after an in-flight consent read', async (failure) => {
    const f = minimal(consent)
    const arrived = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.io.beforeRead = async () => { arrived.resolve(undefined); await release.promise }
    f.releaseOnCleanup(() => { release.resolve(undefined) })
    const pending = f.activation.initialize()
    f.settleOnCleanup(pending)
    const rejected = expect(pending).rejects.toThrow()
    await arrived.promise
    if (failure === 'parent') f.owner.abort()
    else f.io.fail()
    release.resolve(undefined)
    await rejected
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })

  it('shares a failed consent commit across simultaneous and subsequent enable requests', async () => {
    const f = minimal()
    const arrived = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('Fixture credential commit failed')
    f.io.beforeWrite = async () => { arrived.resolve(undefined); await release.promise; throw failure }
    f.releaseOnCleanup(() => { release.resolve(undefined) })
    const first = f.activation.activate()
    f.settleOnCleanup(first)
    const firstFailure = expect(first).rejects.toBe(failure)
    await arrived.promise
    const joined = expect(f.activation.activate()).rejects.toBe(failure)
    release.resolve(undefined)
    await Promise.all([firstFailure, joined])
    await expect(f.activation.activate()).rejects.toBe(failure)
    expect(f.io.attempts).toBe(1)
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })

  it.each(['parent', 'source'] as const)('does not mount if %s fails while consent is committed', async (failure) => {
    const f = minimal()
    f.io.afterWrite = () => { if (failure === 'parent') f.owner.abort(); else f.io.fail() }
    await expect(f.activation.activate()).rejects.toThrow()
    await expect(f.activation.activate()).rejects.toThrow()
    expect(f.io.records.get(consentKey)).toEqual(consent)
    expect(f.io.attempts).toBe(1)
    unmounted(f)
  })

  it.each(['enable', 'restore'] as const)('mounts the real Host only after %s consent with real Loader dependencies', async (mode) => {
    const f = await readyDependencies()
    if (mode === 'restore') await f.ctx.credentials.modifyRecord(consentKey, async () => consent)
    const commits: { key: CredentialKey; mounted: boolean; sockets: number }[] = []
    f.ctx.on('credentials/record-updated', (key) => {
      commits.push({ key, mounted: f.ctx.get('companionHost') !== undefined, sockets: SocketTransport.instances.length })
    })
    const activation = new DesktopCompanionActivation(f.ctx, config, f.owner)
    await activation.initialize()
    if (mode === 'enable') {
      expect(activation.describe()).toEqual({ kind: 'activationRequired' })
      expect(f.ctx.get('companionHost')).toBeUndefined()
      expect(SocketTransport.instances).toHaveLength(0)
      await Promise.all([activation.activate(), activation.activate()])
      expect(commits[0]).toEqual({ key: consentKey, mounted: false, sockets: 0 })
    }
    expect(commits.map(commit => commit.key)).toEqual(mode === 'enable' ? [consentKey, RECORD_KEY] : [RECORD_KEY])
    expect(await f.ctx.credentials.readRecord(consentKey)).toEqual(consent)
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toMatchObject({ kind: 'grant', payload: {
      httpsOrigin: config.httpsOrigin, grants: [],
    } })
    expect(f.ctx.get('companionHost')).toBeDefined()
    expect(activation.describe()).toMatchObject({ kind: 'status', status: {
      available: true, connected: false, paired: [], candidates: [],
    } })
    expect(SocketTransport.instances).toHaveLength(1)
    expect(SocketTransport.instances[0]?.url).toMatch(/^wss:\/\/relay\.invalid\//)
    await activation.activate()
    expect(SocketTransport.instances).toHaveLength(1)
  })

  it.each(['delete', 'replace'] as const)('withdraws the real Host when committed local consent is changed by %s', async (change) => {
    const f = await readyDependencies()
    const activation = new DesktopCompanionActivation(f.ctx, config, f.owner)
    await activation.initialize()
    await activation.activate()
    const identity = await f.ctx.credentials.readRecord(RECORD_KEY)
    const socket = SocketTransport.instances[0]
    if (socket === undefined) throw new Error('Expected an owned outbound socket')
    if (change === 'delete') await f.ctx.credentials.deleteRecord(consentKey)
    else await f.ctx.credentials.modifyRecord(consentKey, async () => ({ kind: 'grant', payload: {
      v: 1, httpsOrigin: 'https://changed.invalid',
    } }))
    expect(f.owner.signal.aborted).toBe(true)
    expect(activation.describe()).toMatchObject({ kind: 'status', status: { available: false, connected: false } })
    await socket.closed
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toEqual(identity)
    expect(SocketTransport.instances).toHaveLength(1)
  })

  it('retains a real mount failure without resetting a corrupt identity or retrying activation', async () => {
    const f = await readyDependencies()
    const damaged: CredentialRecord = { kind: 'grant', payload: { v: 1, damaged: true } }
    await f.ctx.credentials.modifyRecord(RECORD_KEY, async () => damaged)
    const activation = new DesktopCompanionActivation(f.ctx, config, f.owner)
    await activation.initialize()
    const first = activation.activate()
    await expect(first).rejects.toThrow()
    const failure: unknown = await first.catch((error: unknown) => error)
    await expect(activation.activate()).rejects.toBe(failure)
    expect(await f.ctx.credentials.readRecord(consentKey)).toEqual(consent)
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toEqual(damaged)
    expect(f.ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(0)
  })

  it.each(['active', 'failed'] as const)('does not reacquire phone authority after a credential-provider reload while %s', async (mode) => {
    const f = await readyDependencies()
    if (mode === 'failed') await f.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({
      kind: 'grant', payload: { damaged: true },
    }))
    const activation = new DesktopCompanionActivation(f.ctx, config, f.owner)
    await activation.initialize()
    if (mode === 'failed') await expect(activation.activate()).rejects.toThrow()
    else await activation.activate()
    const before = SocketTransport.instances.length
    const identity = await f.ctx.credentials.readRecord(RECORD_KEY)
    const credentials = [...f.ctx.loader.entries()].find(row => row.options.id === 'credentials')
    if (credentials === undefined) throw new Error('Missing real credential-provider fixture')
    await f.ctx.loader.update(credentials.id, { disabled: true })
    await f.ctx.loader.await()
    await f.ctx.loader.update(credentials.id, { disabled: false })
    await f.ctx.loader.await()
    expect(f.owner.signal.aborted).toBe(true)
    expect(SocketTransport.instances).toHaveLength(before)
    for (const socket of SocketTransport.instances) expect(socket.readyState).toBe(3)
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toEqual(identity)
    await expect(activation.activate()).rejects.toThrow()
  })

  it('creates no identity when consent disappears on disk before the identity mutation reconciles its source', async () => {
    const f = await readyDependencies()
    f.ctx.on('credentials/record-updated', (key) => {
      if (key === consentKey) writeFileSync(join(f.home, 'test-credentials.yaml'), 'version: 1\nrecords: {}\n')
    })
    const activation = new DesktopCompanionActivation(f.ctx, config, f.owner)
    await activation.initialize()
    await expect(activation.activate()).rejects.toThrow()
    expect(f.owner.signal.aborted).toBe(true)
    expect(await f.ctx.credentials.readRecord(consentKey)).toBeUndefined()
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toBeUndefined()
    expect(f.ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(0)
  })

  it('reports activationRequired and completes explicit private activation before publishing real status', async () => {
    const f = await readyDependencies()
    const request = await privateControlRequests(f)
    expect(await request({ kind: 'describe' }, 1)).toEqual({ type: 'companion-control', requestId: 1,
      result: { kind: 'activationRequired' } })
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(0)
    expect(await request({ kind: 'activate' }, 2)).toEqual({ type: 'companion-control', requestId: 2,
      result: { kind: 'completed' } })
    expect(await request({ kind: 'describe' }, 3)).toMatchObject({ type: 'companion-control', requestId: 3,
      result: { kind: 'status', status: { available: true, connected: false, paired: [], candidates: [] } } })
    expect(await f.ctx.credentials.readRecord(consentKey)).toEqual(consent)
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toMatchObject({ kind: 'grant', payload: { grants: [] } })
    expect(SocketTransport.instances).toHaveLength(1)
  })

  it('dispatches only exact Main permission commands to the real Host with no generic service operation', async () => {
    const f = await readyDependencies()
    const request = await privateControlRequests(f)
    let requestId = 1
    await request({ kind: 'activate' }, requestId)
    const phoneIdentityKey = exportPublicKey(generateP256KeyPair().publicKey)
    const grant = { grantId: parseId<GrantId>('permission-phone'), generation: 7, phoneIdentityKey, displayName: '', pairedAt: 1 }
    const identity = await f.ctx.credentials.readRecord(RECORD_KEY)
    if (identity?.kind !== 'grant' || typeof identity.payload !== 'object' || identity.payload === null) throw new Error('Missing real identity')
    const payload = identity.payload
    await f.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: { ...payload, grants: [grant] } }))
    await vi.waitFor(() => { expect(f.ctx.companionHost.describe().available).toBe(true) })
    const denied = await f.ctx.credentials.readRecord(RECORD_KEY)
    const command = { kind: 'setSessionManagement', grantId: grant.grantId, expectedGeneration: grant.generation,
      fingerprint: fingerprint(phoneIdentityKey), enabled: true }
    for (const malformed of [
      { ...command, extra: true }, { ...command, expectedGeneration: undefined },
      { ...command, fingerprint: '' }, { ...command, enabled: 'true' },
      { kind: 'rpc', service: 'companionHost', method: 'setSessionManagement', args: [command] },
    ]) {
      expect(await request(malformed, ++requestId)).toEqual({ type: 'companion-control', requestId, error: 'unavailable' })
      expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toEqual(denied)
    }
    for (const enabled of [true, false]) {
      expect(await request({ ...command, enabled }, ++requestId)).toEqual({
        type: 'companion-control', requestId, result: { kind: 'completed' },
      })
      expect(f.ctx.companionHost.describe().paired).toEqual([{ grantId: grant.grantId, generation: 7,
        fingerprint: command.fingerprint, displayName: '', pairedAt: 1, sessionManagement: enabled,
        modelSelection: false, toolDetails: false, sessionActivation: false }])
    }
    expect(await f.ctx.credentials.readRecord(RECORD_KEY)).toEqual(denied)
  })

  it('rejects extra activate command fields on the private receiver without granting consent', async () => {
    const f = minimal()
    const sent = Promise.withResolvers<object>()
    const controls = installDesktopCompanionControls(f.ctx, config, f.owner, async (message) => { sent.resolve(message) })
    await controls.initialize()
    expect(controls.receive({ type: 'companion-control', requestId: 1,
      command: { kind: 'activate', candidateId: 'renderer-selected', fingerprint: 'a'.repeat(64) } })).toBe(true)
    expect(await sent.promise).toEqual({ type: 'companion-control', requestId: 1, error: 'unavailable' })
    expect(f.io.writes).toEqual([])
    unmounted(f)
  })
})
