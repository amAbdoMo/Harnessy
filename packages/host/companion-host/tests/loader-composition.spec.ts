/** Real source Loader and persistence; external websocket, model and scoped filesystem failures are controlled. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import {
  createPhoneHandshake, createRelayChallenge, exactRecord, exportPublicKey, generateP256KeyPair,
  parseApplicationResult, parseHttpsOrigin, parseId, parsePairingInvitation, parsePublicKey, verifyRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ChannelId, PhoneHandshake, SocketGeneration } from '@deepseek-ai/dsh-companion-protocol'
import { RECORD_KEY } from '../src/records.ts'
import type { PrivateRecord } from '../src/records.ts'
import { composition, config } from './composition.ts'
import type { Composition } from './composition.ts'
import { SocketTransport } from './transport.ts'

vi.mock('ws', async () => {
  const { SocketTransport: WebSocket } = await import('./transport.ts')
  return { WebSocket }
})

const disk = vi.hoisted(() => ({
  beforeRename: undefined as ((target: string) => Promise<void>) | undefined,
}))

// Only filesystem commit I/O is intercepted; serialization, locking and the credential provider remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
      if (typeof target === 'string') await disk.beforeRename?.(target)
      await actual.rename(source, target)
    },
  }
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const release of cleanup.splice(0).reverse()) await release() }
  finally { disk.beforeRename = undefined; SocketTransport.instances.length = 0 }
})

async function boot(override: import('../src/config.ts').Config = config, home?: string): Promise<Composition> {
  const fixture = await composition(override, home)
  cleanup.push(() => fixture.close())
  expect(fixture.ctx.get('sessionController')).toBeDefined()
  expect(fixture.ctx.get('sessionQuery')).toBeDefined()
  expect(fixture.ctx.get('sessions')).toBeDefined()
  expect(fixture.ctx.get('agents')).toBeDefined()
  return fixture
}

function socket(): SocketTransport {
  const ws = SocketTransport.instances.at(-1)
  if (ws === undefined) throw new Error('Companion did not open outbound WSS')
  return ws
}

function connect(fixture: Composition) {
  const ws = socket()
  ws.emit('open')
  const registration = exactRecord(ws.packets[0], ['v', 'type', 'role', 'identityKey', 'targetPcId'])
  const pcGeneration = parseId<SocketGeneration>('pc-incarnation')
  const challenge = createRelayChallenge({ role: 'pc', httpsOrigin: parseHttpsOrigin(config.httpsOrigin),
    identityKey: parsePublicKey(registration.identityKey),
    targetPcId: parseId(registration.targetPcId), socketGeneration: pcGeneration })
  ws.receive(challenge)
  expect(verifyRelayChallenge(challenge, ws.packets[1])).toBe(true)
  ws.receive({ v: 1, type: 'relay-ready', role: 'pc', targetPcId: challenge.targetPcId, socketGeneration: pcGeneration })
  expect(fixture.ctx.companionHost.describe().connected).toBe(true)
  return { ws, pcGeneration, pcId: challenge.targetPcId }
}

async function candidate(fixture: Composition, route: ReturnType<typeof connect>, name = 'phone-channel') {
  const privateInvitation = await fixture.ctx.companionHost.createInvitation()
  const invitation = parsePairingInvitation(privateInvitation.pairingUrl, Date.now())
  cleanup.push(async () => { invitation.secret.fill(0) })
  const key = generateP256KeyPair().privateKey
  const channelId = parseId<ChannelId>(name)
  const phoneGeneration = parseId<SocketGeneration>('phone-incarnation')
  const attempt = createPhoneHandshake({ channelBudget: config.budgets.channel,
    identityPrivateKey: key, pcIdentityKey: invitation.pcIdentityKey,
    httpsOrigin: invitation.httpsOrigin, channelId,
    authorization: { kind: 'invitation', invitationId: invitation.invitationId, pairingSecret: invitation.secret } })
  cleanup.push(async () => { attempt.close() })
  route.ws.receive({ v: 1, type: 'relay-channel-open', channelId, targetPcId: route.pcId,
    phoneIdentityKey: exportPublicKey(key), phoneSocketGeneration: phoneGeneration, pcSocketGeneration: route.pcGeneration })
  const deliver = (payload: object): void => { route.ws.receive({ v: 1, type: 'relay-data', channelId,
    targetPcId: route.pcId, sourceRole: 'phone', sourceIdentityKey: exportPublicKey(key),
    sourceSocketGeneration: phoneGeneration, targetSocketGeneration: route.pcGeneration, payload }) }
  deliver(attempt.hello)
  await vi.waitFor(() => { expect(fixture.ctx.companionHost.describe().candidates).toHaveLength(1) })
  const current = fixture.ctx.companionHost.describe().candidates[0]!
  return { current, attempt, deliver, invitation, privateInvitation, channelId, phoneGeneration }
}

function payloads(ws: SocketTransport): unknown[] {
  return ws.packets.filter(packet => packet.type === 'relay-data').map(packet => packet.payload)
}

async function stored(fixture: Composition): Promise<PrivateRecord> {
  const record = await fixture.ctx.credentials.readRecord(RECORD_KEY)
  if (record?.kind !== 'grant') throw new Error('Expected committed companion identity')
  // This record is generated by the real Host, not supplied by a mocked provider.
  return record.payload as PrivateRecord
}

async function confirm(attempt: PhoneHandshake, ws: SocketTransport, deliver: (payload: object) => void) {
  const frames = payloads(ws)
  const channel = attempt.complete(frames[0])
  cleanup.push(async () => { channel.close() })
  expect(await channel.receive(frames[1])).toEqual({ kind: 'confirmation' })
  await channel.sendConfirmation(async (frame) => { deliver(frame) })
  return channel
}

class RegressionBarrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly completion = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise

  constructor() {
    cleanup.push(async () => { this.release() })
  }

  async enter(): Promise<void> {
    this.arrival.resolve(undefined)
    await this.completion.promise
  }

  release(): void { this.completion.resolve(undefined) }
}

class RegressionModel extends LlmAdapter {
  readonly streamBarrier = new RegressionBarrier()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.streamBarrier.enter()
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'completed admitted task' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'completed admitted task' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function sessionAgent(fixture: Composition) {
  const model = new RegressionModel()
  const modules = { 'regression-prompt': SystemPrompt, 'regression-tools': Tools, 'regression-loop': AgentLoop }
  for (const [name, plugin] of Object.entries(modules)) {
    fixture.ctx.loader.builtins[name] = plugin
    await fixture.ctx.loader.create({ name: `cordis:${name}`,
      ...(name === 'regression-loop' ? { config: { agents: [] } } : {}) })
  }
  await fixture.ctx.loader.await()
  fixture.ctx.effect(() => fixture.ctx.llm.registerAdapter(['fixture'], model))
  const handle = await fixture.ctx.agents.create({ sessionId: SessionId('companion-admission'),
    meta: { cwd: fixture.home }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  cleanup.push(async () => { model.streamBarrier.release(); await handle.dispose() })
  return { agent: handle.agent, model }
}

function credentialsPath(fixture: Composition): string { return join(fixture.home, 'test-credentials.yaml') }

async function disableHost(fixture: Composition): Promise<void> {
  const entry = [...fixture.ctx.loader.entries()].find(row => row.options.id === 'companion')!
  await fixture.ctx.loader.update(entry.id, { disabled: true })
  await fixture.ctx.loader.await()
}

async function submission(channel: Awaited<ReturnType<typeof confirm>>, phone: Awaited<ReturnType<typeof candidate>>,
  sessionId: SessionId, text: string, ordinal: number): Promise<void> {
  await channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'submitText', sessionId, text,
    requestId: Buffer.alloc(16, ordinal).toString('base64url'),
    submissionId: Buffer.alloc(16, ordinal).toString('base64url') })), async (frame) => { phone.deliver(frame) })
}

describe('companion Host source Loader composition', () => {
  it('keeps an unconfigured Host unavailable without creating WSS or an identity', async () => {
    const fixture = await boot({})
    expect(fixture.ctx.companionHost.describe()).toEqual({ available: false, connected: false, paired: [], candidates: [] })
    expect(SocketTransport.instances).toHaveLength(0)
    expect(await fixture.ctx.credentials.readRecord(RECORD_KEY)).toBeUndefined()
    await expect(fixture.ctx.companionHost.createInvitation()).rejects.toThrow()
  })

  it('requires exact local fingerprint approval and commits enrollment before delivering welcome', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    expect(payloads(route.ws)).toHaveLength(0)
    expect((await stored(fixture)).grants).toHaveLength(0)
    const status = JSON.stringify(fixture.ctx.companionHost.describe())
    expect(status).not.toContain(phone.privateInvitation.pairingUrl)
    expect(status).not.toContain(Buffer.from(phone.invitation.secret).toString('base64url'))
    expect(status).not.toContain((await stored(fixture)).identityPkcs8)
    expect(phone.current.fingerprint).toBe(createHash('sha256')
      .update(Buffer.from(phone.attempt.hello.phoneIdentityKey, 'base64url')).digest('hex'))
    await expect(fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, '0'.repeat(64)))
      .rejects.toThrow('mismatched candidate')
    expect((await stored(fixture)).grants).toHaveLength(0)
    expect(payloads(route.ws)).toHaveLength(0)
    route.ws.blocked = true
    const approval = fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(1) })
    const committed = await stored(fixture)
    expect(committed.grants).toHaveLength(1)
    expect(committed.grants[0]!.phoneIdentityKey).toBe(phone.attempt.hello.phoneIdentityKey)
    route.ws.blocked = false
    route.ws.flush()
    const grant = await approval
    await confirm(phone.attempt, route.ws, phone.deliver)
    const emitted = route.ws.packets.filter(packet => packet.type === 'relay-data')
    expect(emitted).toHaveLength(2)
    for (const packet of emitted) {
      expect(exactRecord(packet, ['v', 'type', 'channelId', 'socketGeneration', 'phoneSocketGeneration', 'payload']))
        .toMatchObject({ v: 1, type: 'relay-data', channelId: phone.channelId,
          socketGeneration: route.pcGeneration, phoneSocketGeneration: phone.phoneGeneration })
    }
    expect(fixture.ctx.companionHost.describe().paired).toEqual([grant])
    await expect(fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint))
      .rejects.toThrow('mismatched candidate')
  })

  it('rejects replayed encrypted confirmation and does not enroll a second grant', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    await fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const channel = phone.attempt.complete(payloads(route.ws)[0])
    cleanup.push(async () => { channel.close() })
    await channel.receive(payloads(route.ws)[1])
    let confirmation: object | undefined
    await channel.sendConfirmation(async (frame) => { confirmation = frame; phone.deliver(frame) })
    if (confirmation === undefined) throw new Error('Phone confirmation not emitted')
    phone.deliver(confirmation)
    await vi.waitFor(() => { expect(route.ws.packets.some(packet => packet.type === 'relay-close')).toBe(true) })
    expect(route.ws.packets.find(packet => packet.type === 'relay-close')).toEqual({
      v: 1, type: 'relay-close', channelId: phone.channelId, socketGeneration: route.pcGeneration,
      phoneSocketGeneration: phone.phoneGeneration,
    })
    expect(route.ws.readyState).toBe(SocketTransport.OPEN)
    expect((await stored(fixture)).grants).toHaveLength(1)
    expect(payloads(route.ws)).toHaveLength(2)
  })

  it('revokes the current grant and refuses subsequent encrypted application traffic', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    const grant = await fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const channel = await confirm(phone.attempt, route.ws, phone.deliver)
    await fixture.ctx.companionHost.revokeGrant(grant.grantId)
    expect((await stored(fixture)).grants).toEqual([])
    expect(fixture.ctx.companionHost.describe().paired).toEqual([])
    const before = payloads(route.ws).length
    await channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions',
      requestId: Buffer.alloc(16, 1).toString('base64url'), limit: 1 })), async (frame) => { phone.deliver(frame) })
    await vi.waitFor(() => { expect(route.ws.packets.some(packet => packet.type === 'relay-close')).toBe(true) })
    expect(payloads(route.ws)).toHaveLength(before)
    expect(route.ws.readyState).toBe(SocketTransport.OPEN)
    expect(fixture.ctx.companionHost.describe().connected).toBe(true)
  })

  it('withdraws synchronously on source failure despite cached grants and preserves only already-admitted work', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    const grant = await fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const channel = await confirm(phone.attempt, route.ws, phone.deliver)
    const { agent, model } = await sessionAgent(fixture)
    await submission(channel, phone, agent.id, 'admitted before fault', 1)
    await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(3) })
    const receipt = await channel.receive(payloads(route.ws)[2])
    if (receipt.kind !== 'application') throw new Error('Expected application receipt')
    expect(parseApplicationResult(receipt.plaintext.toString('utf8'), config.budgets.application))
      .toMatchObject({ type: 'submitted', admission: 'inMemoryInbox', sessionId: agent.id })
    await model.streamBarrier.arrived

    const lastGood = await stored(fixture)
    const path = credentialsPath(fixture)
    const durable = await readFile(path, 'utf8')
    const synchronous: { failed: boolean; available: boolean; connected: boolean }[] = []
    fixture.ctx.on('credentials/source-failed', () => {
      const status = fixture.ctx.companionHost.describe()
      synchronous.push({ failed: fixture.ctx.credentials.sourceFailureSignal.aborted,
        available: status.available, connected: status.connected })
    })
    await writeFile(path, 'version: 1\nrecords: []\n', { mode: 0o600 })
    await expect(fixture.ctx.credentials.modifyRecord(credentialKey('regression', 'trigger'),
      () => Promise.resolve({ kind: 'api-key' }))).rejects.toThrow('must be a mapping')
    expect(synchronous).toEqual([{ failed: true, available: false, connected: false }])
    expect((await stored(fixture)).grants).toEqual(lastGood.grants)
    expect(lastGood.grants.map(row => row.grantId)).toContain(grant.grantId)
    await expect(fixture.ctx.companionHost.createInvitation()).rejects.toThrow('unavailable')

    await submission(channel, phone, agent.id, 'must not be admitted after fault', 2)
    model.streamBarrier.release()
    await agent.whenIdle()
    await fixture.ctx.sessions.flush(agent.session)
    await using persisted = await fixture.ctx.sessionPersistence.open(agent.id, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message')).toMatchObject([
      { data: { content: [{ type: 'text', text: 'admitted before fault' }] } },
    ])
    expect(events.filter(event => event.type === 'assistant/message')).toMatchObject([
      { data: { message: { content: [{ type: 'text', text: 'completed admitted task' }] } } },
    ])
    expect(events.at(-1)?.type).toBe('turn/end')
    expect(payloads(route.ws)).toHaveLength(3)

    await writeFile(path, durable, { mode: 0o600 })
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, current => Promise.resolve(current))
    expect((await stored(fixture)).grants).toEqual(lastGood.grants)
    expect(fixture.ctx.credentials.sourceFailureSignal.aborted).toBe(true)
    expect(fixture.ctx.companionHost.describe().available).toBe(false)
    const sockets = SocketTransport.instances.length
    const entry = [...fixture.ctx.loader.entries()].find(row => row.options.id === 'companion')!
    await entry.update({ config: { ...config, budgets: { ...config.budgets, maxCandidates: 3 } } })
    await fixture.ctx.loader.await()
    expect(fixture.ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(sockets)
  })

  it('reports a failed revoke commit and keeps runtime authority withdrawn without inventing a durable tombstone', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    const grant = await fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const channel = await confirm(phone.attempt, route.ws, phone.deliver)
    const path = credentialsPath(fixture)
    const before = await readFile(path, 'utf8')
    const commit = new RegressionBarrier()
    disk.beforeRename = async (target) => {
      if (target !== path) return
      await commit.enter()
      throw Object.assign(new Error('revoke commit failed'), { code: 'EIO' })
    }
    const revoke = fixture.ctx.companionHost.revokeGrant(grant.grantId)
    const rejected = expect(revoke).rejects.toThrow('revoke commit failed')
    cleanup.push(async () => { disk.beforeRename = undefined; commit.release(); await Promise.allSettled([revoke, rejected]) })
    await commit.arrived
    const frames = payloads(route.ws).length
    await channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions',
      requestId: Buffer.alloc(16, 3).toString('base64url'), limit: 1 })), async (frame) => { phone.deliver(frame) })
    commit.release()
    await rejected
    expect(fixture.ctx.companionHost.describe()).toMatchObject({ available: false, connected: false })
    await expect(fixture.ctx.companionHost.createInvitation()).rejects.toThrow('unavailable')
    expect(payloads(route.ws)).toHaveLength(frames)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await stored(fixture)).grants.map(row => row.grantId)).toEqual([grant.grantId])
    expect(fixture.ctx.credentials.sourceFailureSignal.aborted).toBe(false)

    disk.beforeRename = undefined
    await disableHost(fixture)
    const restarted = await boot(config, fixture.home)
    expect(restarted.ctx.companionHost.describe().paired).toEqual([grant])
    expect((await stored(restarted)).grants.map(row => row.grantId)).toEqual([grant.grantId])
  })

  it.each([false, true])('cancels an approval during its actual store commit (compensation fails: %s)', async (failCompensation) => {
    const fixture = await boot()
    const route = connect(fixture)
    const existing = await candidate(fixture, route, 'existing-phone')
    const retained = await fixture.ctx.companionHost.approveCandidate(existing.current.candidateId, existing.current.fingerprint)
    await confirm(existing.attempt, route.ws, existing.deliver)
    const retainedRows = (await stored(fixture)).grants
    const phone = await candidate(fixture, route, 'cancelled-phone')
    const path = credentialsPath(fixture)
    const commit = new RegressionBarrier()
    let commits = 0
    disk.beforeRename = async (target) => {
      if (target !== path) return
      commits++
      if (commits === 1) await commit.enter()
      else if (failCompensation) throw Object.assign(new Error('compensation commit failed'), { code: 'EIO' })
    }
    const approval = fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const approvalRejected = expect(approval).rejects.toThrow(failCompensation
      ? 'compensation commit failed' : 'enrollment withdrawn before welcome')
    cleanup.push(async () => { disk.beforeRename = undefined; commit.release(); await Promise.allSettled([approval, approvalRejected]) })
    await commit.arrived
    expect((await stored(fixture)).grants.map(row => row.grantId)).toEqual([retained.grantId])
    const frames = payloads(route.ws).length
    const cancellation = fixture.ctx.companionHost.cancelInvitation()
    const cancelled = failCompensation
      ? expect(cancellation).rejects.toThrow('compensation commit failed')
      : expect(cancellation).resolves.toBeUndefined()
    cleanup.push(async () => { disk.beforeRename = undefined; commit.release(); await Promise.allSettled([cancellation, cancelled]) })
    expect(fixture.ctx.companionHost.describe().candidates).toEqual([])
    commit.release()
    await Promise.all([approvalRejected, cancelled])
    expect(payloads(route.ws)).toHaveLength(frames)
    const rows = (await stored(fixture)).grants
    expect(rows.filter(row => row.grantId === retained.grantId)).toEqual(retainedRows)
    expect(rows).toHaveLength(retainedRows.length + (failCompensation ? 1 : 0))
    expect(rows.filter(row => row.phoneIdentityKey === phone.attempt.hello.phoneIdentityKey))
      .toHaveLength(failCompensation ? 1 : 0)
    if (failCompensation) {
      expect(fixture.ctx.companionHost.describe()).toMatchObject({ available: false, connected: false })
      await expect(fixture.ctx.companionHost.createInvitation()).rejects.toThrow('unavailable')
    }
    disk.beforeRename = undefined
    await disableHost(fixture)
    const restarted = await boot(config, fixture.home)
    expect((await stored(restarted)).grants).toEqual(rows)
    expect(restarted.ctx.companionHost.describe().paired.map(row => row.grantId)).toEqual(rows.map(row => row.grantId))
  })

  it.each(['trailing PKCS8 bytes', 'wrong public/private binding'] as const)(
    'refuses a persisted identity with %s without regenerating it', async (corruption) => {
      const fixture = await boot()
      const valid = await stored(fixture)
      await disableHost(fixture)
      const identityPkcs8 = corruption === 'trailing PKCS8 bytes'
        ? Buffer.concat([Buffer.from(valid.identityPkcs8, 'base64url'), Buffer.from([0])]).toString('base64url')
        : generateP256KeyPair().privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
      const corrupt = { ...valid, identityPkcs8 }
      await fixture.ctx.credentials.modifyRecord(RECORD_KEY, () => Promise.resolve({ kind: 'grant', payload: corrupt }))
      const bytes = await readFile(credentialsPath(fixture), 'utf8')
      const sockets = SocketTransport.instances.length
      const restarted = await boot(config, fixture.home)
      expect(restarted.ctx.get('companionHost')).toBeUndefined()
      expect(SocketTransport.instances).toHaveLength(sockets)
      expect(await stored(restarted)).toEqual(corrupt)
      expect(await readFile(credentialsPath(fixture), 'utf8')).toBe(bytes)
      expect(restarted.ctx.credentials.sourceFailureSignal.aborted).toBe(false)
    },
  )

  it('rejects a second Desktop owner of the same home while the first remains connected', async () => {
    const first = await boot()
    const route = connect(first)
    const second = await boot(config, first.home)
    expect(second.ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(1)
    expect(first.ctx.companionHost.describe().connected).toBe(true)
    expect(route.ws.readyState).toBe(SocketTransport.OPEN)
  })

  it('reloads while welcome delivery never calls back and keeps its late callback on the retired socket', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const phone = await candidate(fixture, route)
    route.ws.blocked = true
    route.ws.flushOnTerminate = false
    const approval = fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
    const rejected = expect(approval).rejects.toThrow('delivery unknown')
    await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(1) })
    const callback = route.ws.takeCallback()
    const identity = (await stored(fixture)).identityPublicKey
    const entry = [...fixture.ctx.loader.entries()].find(row => row.options.id === 'companion')!
    await entry.update({ config: { ...config, budgets: { ...config.budgets, maxCandidates: 3 } } })
    await fixture.ctx.loader.await()
    await rejected
    await route.ws.closed
    const successor = connect(fixture)
    callback(new Error('retired welcome write'))
    callback()
    expect(payloads(successor.ws)).toHaveLength(0)
    expect(successor.ws.readyState).toBe(SocketTransport.OPEN)
    expect(fixture.ctx.companionHost.describe().connected).toBe(true)
    expect((await stored(fixture)).identityPublicKey).toBe(identity)
  })

  it('reloads through Loader after quiescent socket disposal and ignores stale callbacks', async () => {
    const fixture = await boot()
    const route = connect(fixture)
    const oldHost = fixture.ctx.companionHost
    const oldRecord = await stored(fixture)
    const entry = [...fixture.ctx.loader.entries()].find(row => row.options.id === 'companion')!
    await entry.update({ config: { ...config, budgets: { ...config.budgets, maxCandidates: 3 } } })
    await fixture.ctx.loader.await()
    await route.ws.closed
    expect(route.ws.listenerCount('message')).toBe(0)
    expect(route.ws.listenerCount('error')).toBe(0)
    expect(oldHost.describe().available).toBe(false)
    expect((await stored(fixture)).identityPublicKey).toBe(oldRecord.identityPublicKey)
    const replacement = connect(fixture)
    route.ws.receive({ v: 1, type: 'relay-ready', role: 'pc', targetPcId: route.pcId, socketGeneration: route.pcGeneration })
    route.ws.flush()
    expect(fixture.ctx.companionHost.describe().connected).toBe(true)
    await fixture.ctx.loader.update(entry.id, { disabled: true })
    await fixture.ctx.loader.await()
    await replacement.ws.closed
    expect(fixture.ctx.get('companionHost')).toBeUndefined()
    expect(replacement.ws.listenerCount('message')).toBe(0)
    expect(replacement.ws.listenerCount('error')).toBe(0)
  })
})
