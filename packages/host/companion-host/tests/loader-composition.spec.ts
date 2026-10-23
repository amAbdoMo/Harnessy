/** Real source Loader and persistence; external websocket, model and scoped filesystem failures are controlled. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createMessage, createToolResultMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import {
  createPhoneHandshake, createRelayChallenge, exactRecord, exportPublicKey, generateP256KeyPair,
  parseApplicationRequest, parseApplicationResult, parseHttpsOrigin, parseId, parsePairingInvitation, parsePublicKey, verifyRelayChallenge,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationRequest, ApplicationResult, ChannelId, PhoneHandshake, SocketGeneration } from '@deepseek-ai/dsh-companion-protocol'
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
  beforeReadDirectory: undefined as ((target: string) => Promise<void>) | undefined,
}))

// Only scoped filesystem I/O is intercepted; persistence, locking and the credential provider remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (typeof args[0] === 'string') await disk.beforeReadDirectory?.(args[0])
      return actual.readdir(...args)
    },
    rename: async (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
      if (typeof target === 'string') await disk.beforeRename?.(target)
      await actual.rename(source, target)
    },
  }
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const release of cleanup.splice(0).reverse()) await release() }
  finally {
    disk.beforeRename = undefined
    disk.beforeReadDirectory = undefined
    SocketTransport.instances.length = 0
  }
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
  return { current, attempt, deliver, invitation, privateInvitation, channelId, phoneGeneration, key }
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

async function confirm(attempt: PhoneHandshake, ws: SocketTransport, deliver: (payload: object) => void, offset = 0) {
  const frames = payloads(ws).slice(offset)
  const channel = attempt.complete(frames[0])
  cleanup.push(async () => { channel.close() })
  expect(await channel.receive(frames[1])).toEqual({ kind: 'confirmation' })
  await channel.sendConfirmation(async (frame) => { deliver(frame) })
  return channel
}

async function approvedChannel(fixture: Composition) {
  const route = connect(fixture)
  const phone = await candidate(fixture, route)
  const grant = await fixture.ctx.companionHost.approveCandidate(phone.current.candidateId, phone.current.fingerprint)
  const channel = await confirm(phone.attempt, route.ws, phone.deliver)
  return { route, phone, grant, channel }
}

async function resumeChannel(fixture: Composition, approved: Awaited<ReturnType<typeof approvedChannel>>) {
  const { route, phone } = approved
  const grant = fixture.ctx.companionHost.describe().paired.find(row => row.grantId === approved.grant.grantId)!
  const channelId = parseId<ChannelId>('resumed-phone-channel')
  const phoneGeneration = parseId<SocketGeneration>('resumed-phone-incarnation')
  const attempt = createPhoneHandshake({ channelBudget: config.budgets.channel, identityPrivateKey: phone.key,
    pcIdentityKey: phone.invitation.pcIdentityKey, httpsOrigin: phone.invitation.httpsOrigin, channelId,
    authorization: { kind: 'grant', grantId: grant.grantId, generation: grant.generation } })
  cleanup.push(async () => { attempt.close() })
  route.ws.receive({ v: 1, type: 'relay-channel-open', channelId, targetPcId: route.pcId,
    phoneIdentityKey: exportPublicKey(phone.key), phoneSocketGeneration: phoneGeneration, pcSocketGeneration: route.pcGeneration })
  const deliver = (payload: object): void => { route.ws.receive({ v: 1, type: 'relay-data', channelId,
    targetPcId: route.pcId, sourceRole: 'phone', sourceIdentityKey: exportPublicKey(phone.key),
    sourceSocketGeneration: phoneGeneration, targetSocketGeneration: route.pcGeneration, payload }) }
  const before = payloads(route.ws).length
  deliver(attempt.hello)
  await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(before + 2) })
  const channel = await confirm(attempt, route.ws, deliver, before)
  return { route, phone: { ...phone, channelId, phoneGeneration, attempt, deliver }, grant, channel }
}

async function listSessions(approved: Awaited<ReturnType<typeof approvedChannel>>, ordinal: number, view?: 'navigation') {
  const { route, phone, channel } = approved
  const requestId = Buffer.alloc(16, ordinal).toString('base64url')
  const before = payloads(route.ws).length
  await channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions', requestId, limit: 10,
    ...(view === undefined ? {} : { view }) })), async (frame) => { phone.deliver(frame) })
  await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(before + 1) })
  const received = await channel.receive(payloads(route.ws)[before])
  if (received.kind !== 'application') throw new Error('Expected encrypted Session listing')
  const plaintext = received.plaintext.toString('utf8')
  const result = parseApplicationResult(plaintext, config.budgets.application)
  if (result.type !== 'sessions') throw new Error(`Expected sessions, received ${result.type}`)
  expect(result.requestId).toBe(requestId)
  return { result, plaintext }
}

async function applicationExchange(approved: Awaited<ReturnType<typeof approvedChannel>>, request: ApplicationRequest) {
  const { route, phone, channel } = approved
  const before = payloads(route.ws).length
  await channel.sendApplication(Buffer.from(JSON.stringify(request)), async (frame) => { phone.deliver(frame) })
  await vi.waitFor(() => { expect(payloads(route.ws)).toHaveLength(before + 1) })
  const received = await channel.receive(payloads(route.ws)[before])
  if (received.kind !== 'application') throw new Error('Expected encrypted management result')
  const result = parseApplicationResult(received.plaintext.toString('utf8'), config.budgets.application)
  if (!('requestId' in result)) throw new Error('Expected request-scoped management result')
  expect(result.requestId).toBe(request.requestId)
  return result
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
  streamStarts = 0

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'fixture', name: 'Initial fixture model' },
      { provider, id: 'fixture-next', name: 'Other fixture model' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streamStarts++
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
  it('checks native consent again for encrypted workspace reads and pin writes without changing the pairing', async () => {
    const fixture = await boot()
    const workspace = await fixture.ctx.workspaceRegistry.create(fixture.home, 'Granted empty workspace')
    const session = fixture.ctx.sessions.prepare(SessionId('managed-visible'), { meta: { cwd: fixture.home } })
    const detach = fixture.ctx.sessions.enter(session)
    cleanup.push(async () => { detach() })
    fixture.ctx.sessions.announce(session)
    await workspace.attachSession(session.id)
    let approved = await approvedChannel(fixture)
    const original = approved.grant
    let ordinal = 100
    const request = (type: 'listManagementWorkspaces' | 'setSessionPinned', pinned = false) => {
      const requestId = Buffer.alloc(16, ordinal++).toString('base64url')
      return parseApplicationRequest(JSON.stringify(type === 'listManagementWorkspaces'
        ? { v: 1, type, requestId, limit: 10 }
        : { v: 1, type, requestId, operationId: requestId, sessionId: session.id, pinned }), config.budgets.application)
    }
    expect(await applicationExchange(approved, request('listManagementWorkspaces')))
      .toMatchObject({ type: 'managementWorkspaces', enabled: false, workspaces: [] })
    expect(await applicationExchange(approved, request('setSessionPinned', true)))
      .toMatchObject({ type: 'managed', outcome: 'rejected', code: 'denied' })
    expect(fixture.ctx.workspaceRegistry.pinnedSessionIds).not.toContain(session.id)
    await fixture.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', grantId: original.grantId,
      expectedGeneration: original.generation, fingerprint: original.fingerprint, enabled: true })
    approved = await resumeChannel(fixture, approved)
    expect(approved.grant).toMatchObject({ grantId: original.grantId, generation: original.generation,
      fingerprint: original.fingerprint, sessionManagement: true })
    expect(await applicationExchange(approved, request('listManagementWorkspaces'))).toMatchObject({
      type: 'managementWorkspaces', enabled: true, workspaces: [{ id: workspace.id, title: workspace.title }],
    })
    expect(await applicationExchange(approved, request('setSessionPinned', true))).toMatchObject({
      type: 'managed', action: 'pin', outcome: 'applied', session: { sessionId: session.id, navigation: { pinOrder: 0 } },
    })
    expect(fixture.ctx.workspaceRegistry.pinnedSessionIds).toContain(session.id)
    await fixture.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', grantId: original.grantId,
      expectedGeneration: original.generation, fingerprint: original.fingerprint, enabled: false })
    approved = await resumeChannel(fixture, approved)
    expect(await applicationExchange(approved, request('listManagementWorkspaces')))
      .toMatchObject({ type: 'managementWorkspaces', enabled: false, workspaces: [] })
    expect(await applicationExchange(approved, request('setSessionPinned', false)))
      .toMatchObject({ type: 'managed', outcome: 'rejected', code: 'denied' })
    expect(fixture.ctx.workspaceRegistry.pinnedSessionIds).toContain(session.id)
  })

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

  it('sends tool locations only under separate consent in encrypted history and live activity, then withdraws the channel', async () => {
    const fixture = await boot()
    const initial = await approvedChannel(fixture)
    const { agent } = await sessionAgent(fixture)
    const privateText = 'PRIVATE-ARGUMENT-CONTENT-DIFF-ERROR'
    const recordRead = (id: string) => {
      const callId = ToolCallId(id)
      const call = agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: privateText })
      return agent.session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: privateText }], isError: false }),
        meta: { path: join(fixture.home, 'src', 'visible.ts'), offset: 4, totalLines: 12,
          lines: [{ number: 4, text: privateText }, { number: 5, text: privateText }] },
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    recordRead('historical-read')
    await fixture.ctx.sessions.flush(agent.session)
    const historyRequest = (ordinal: number) => parseApplicationRequest(JSON.stringify({ v: 1, type: 'readHistory',
      requestId: Buffer.alloc(16, ordinal).toString('base64url'), sessionId: agent.id, limit: 10 }), config.budgets.application)
    expect(await applicationExchange(initial, historyRequest(1))).toMatchObject({ type: 'history', rows: [] })
    const consent = { kind: 'setToolDetails' as const, grantId: initial.grant.grantId,
      expectedGeneration: initial.grant.generation, fingerprint: initial.grant.fingerprint }
    await fixture.ctx.companionHost.setToolDetails({ ...consent, enabled: true })
    const approved = await resumeChannel(fixture, initial)
    expect(approved.grant).toMatchObject({ toolDetails: true, modelSelection: false, sessionManagement: false })
    const history = await applicationExchange(approved, historyRequest(2))
    if (history.type !== 'history') throw new Error('Expected bounded history')
    expect(history.rows.map(row => row.text)).toEqual(['read', 'read — completed\nsrc/visible.ts\nReturned 2 lines from 4; total 12'])
    expect(JSON.stringify(history)).not.toContain(privateText)

    const decodeFrom = async (offset: number, count: number): Promise<ApplicationResult[]> => {
      await vi.waitFor(() => { expect(payloads(approved.route.ws).length).toBeGreaterThanOrEqual(offset + count) })
      const decoded: ApplicationResult[] = []
      for (const frame of payloads(approved.route.ws).slice(offset)) {
        const received = await approved.channel.receive(frame)
        if (received.kind !== 'application') throw new Error('Expected encrypted progress or acknowledgement')
        decoded.push(parseApplicationResult(received.plaintext.toString('utf8'), config.budgets.application))
      }
      return decoded
    }
    const baseline = payloads(approved.route.ws).length
    await approved.channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'watchProgress', sessionId: agent.id,
      requestId: Buffer.alloc(16, 3).toString('base64url') })), async (frame) => { approved.phone.deliver(frame) })
    expect((await decodeFrom(baseline, 2)).some(result => result.type === 'watching')).toBe(true)
    const liveStart = payloads(approved.route.ws).length
    const liveResult = recordRead('live-read')
    const live = await decodeFrom(liveStart, 2)
    const rows = live.flatMap(result => result.type === 'progress' ? result.rows : [])
    expect(rows.find(row => row.id === `event-${liveResult.seq}`)?.text).toBe(history.rows[1]?.text)
    expect(JSON.stringify(live)).not.toContain(privateText)
    await fixture.ctx.companionHost.setToolDetails({ ...consent, enabled: false })
    const withdrawn = payloads(approved.route.ws).length
    recordRead('after-withdrawal')
    expect(payloads(approved.route.ws)).toHaveLength(withdrawn)
    const resumed = await resumeChannel(fixture, approved)
    expect(await applicationExchange(resumed, historyRequest(4))).toMatchObject({ type: 'history', rows: [] })
  })

  it('opens two cold chats and changes only one model through the encrypted phone channel without Desktop navigation', async () => {
    const fixture = await boot()
    const initial = await approvedChannel(fixture)
    const unrelated = await sessionAgent(fixture)
    const cold = async (id: string) => {
      const handle = await fixture.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: fixture.home },
        agentOptions: { provider: 'fixture', model: 'fixture' } })
      handle.agent.session.append('turn/start', { turn: 1 })
      handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Existing ${id}` }],
        source: { kind: 'user' } }), { surfaceOp: 'append' })
      handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await fixture.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
      return SessionId(id)
    }
    const a = await cold('phone-cold-a'), b = await cold('phone-cold-b')
    const defaults = fixture.ctx.agentDefaultModel.currentSelection()
    let ordinal = 1
    const request = (fields: object) => parseApplicationRequest(JSON.stringify({ v: 1,
      requestId: Buffer.alloc(16, ordinal++).toString('base64url'), ...fields }), config.budgets.application)
    const opening = (sessionId: string) => request({ type: 'openSession', sessionId,
      operationId: Buffer.alloc(16, ordinal + 32).toString('base64url') })
    expect(await applicationExchange(initial, request({ type: 'getSessionActivation' })))
      .toMatchObject({ type: 'sessionActivation', enabled: false })
    expect(await applicationExchange(initial, request({ type: 'readHistory', sessionId: a, limit: 10 })))
      .toMatchObject({ type: 'history', rows: [{ role: 'user', text: `Existing ${a}` }] })
    expect(fixture.ctx.agents.get(a)).toBeUndefined()
    expect(fixture.ctx.agents.get(b)).toBeUndefined()
    expect(await applicationExchange(initial, request({ type: 'submitText', sessionId: a,
      submissionId: Buffer.alloc(16, 91).toString('base64url'), text: 'Must not activate a cold Agent' })))
      .toMatchObject({ type: 'error', code: 'unavailable' })
    expect(fixture.ctx.agents.get(a)).toBeUndefined()
    expect(await applicationExchange(initial, opening(a))).toMatchObject({ type: 'sessionOpened', outcome: 'rejected', code: 'denied' })
    const identity = { grantId: initial.grant.grantId, expectedGeneration: initial.grant.generation,
      fingerprint: initial.grant.fingerprint }
    await fixture.ctx.companionHost.setSessionActivation({ kind: 'setSessionActivation', ...identity, enabled: true })
    const activated = await resumeChannel(fixture, initial)
    expect(activated.grant).toMatchObject({ sessionActivation: true, modelSelection: false, sessionManagement: false })
    expect(await applicationExchange(activated, opening(a)))
      .toMatchObject({ type: 'sessionOpened', outcome: 'applied', session: { sessionId: a, status: 'idle' } })
    const first = fixture.ctx.agents.get(a)
    expect(first).toBeDefined()
    expect(fixture.ctx.agents.get(b)).toBeUndefined()
    expect(await applicationExchange(activated, request({ type: 'listSessionModels', sessionId: a, limit: 10 })))
      .toMatchObject({ type: 'sessionModels', state: 'denied' })
    expect(await applicationExchange(activated, opening(b))).toMatchObject({ type: 'sessionOpened', outcome: 'applied' })
    const second = fixture.ctx.agents.get(b)
    expect(second).toBeDefined()
    await fixture.ctx.companionHost.setModelSelection({ kind: 'setModelSelection', ...identity, enabled: true })
    const modeled = await resumeChannel(fixture, activated)
    const catalog = await applicationExchange(modeled, request({ type: 'listSessionModels', sessionId: a, limit: 10 }))
    if (catalog.type !== 'sessionModels' || catalog.state !== 'ready') {
      throw new Error(`Expected an idle chat model catalog: ${JSON.stringify(catalog)}`)
    }
    const choice = catalog.models.find(model => model.title === 'Other fixture model')
    if (choice === undefined || first === undefined || second === undefined) throw new Error('Expected real PC model choices and Agents')
    expect(await applicationExchange(modeled, request({ type: 'selectSessionModel', sessionId: a,
      operationId: Buffer.alloc(16, 90).toString('base64url'), revision: catalog.revision, choiceId: choice.id })))
      .toMatchObject({ type: 'modelSelected', outcome: 'applied', selected: choice })
    expect(fixture.ctx.sessionController.currentModelSelection(first)).toMatchObject({ provider: 'fixture', model: 'fixture-next' })
    expect(fixture.ctx.sessionController.currentModelSelection(second)).toMatchObject({ provider: 'fixture', model: 'fixture' })
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual(defaults)
    expect(fixture.ctx.agents.get(unrelated.agent.id)).toBe(unrelated.agent)
    expect(unrelated.model.streamStarts).toBe(0)
    expect(first.inbox.nextStep).toHaveLength(0)
    expect(first.inbox.nextTurn).toHaveLength(0)
    await fixture.ctx.companionHost.setSessionActivation({ kind: 'setSessionActivation', ...identity, enabled: false })
    expect(fixture.ctx.agents.get(a)).toBe(first)
    expect(fixture.ctx.agents.get(b)).toBe(second)
    expect(fixture.ctx.companionHost.describe().paired).toEqual([{ ...initial.grant, modelSelection: true }])
  })

  it('keeps native model consent independent of management and preserves the paired identity across withdrawal', async () => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    const original = approved.grant
    const identity = { grantId: original.grantId, expectedGeneration: original.generation, fingerprint: original.fingerprint }
    expect(original).toMatchObject({ sessionManagement: false, modelSelection: false })
    await fixture.ctx.companionHost.setModelSelection({ kind: 'setModelSelection', ...identity, enabled: true })
    expect(fixture.ctx.companionHost.describe().paired).toEqual([{ ...original, modelSelection: true }])
    await fixture.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', ...identity, enabled: true })
    await fixture.ctx.companionHost.setModelSelection({ kind: 'setModelSelection', ...identity, enabled: false })
    expect(fixture.ctx.companionHost.describe().paired).toEqual([{ ...original, sessionManagement: true }])
    const record = await stored(fixture)
    expect(record.v).toBe(5)
    expect(record.grants).toHaveLength(1)
    expect(record.grants[0]).toMatchObject({ grantId: original.grantId, generation: original.generation, sessionManagementV1: true })
    expect(record.grants[0]).not.toHaveProperty('modelSelectionV1')
  })

  it('reads v2 management consent without rewriting or granting models, then preserves it on a v5 model-consent write', async () => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    const original = await stored(fixture)
    await disableHost(fixture)
    const legacy = { ...original, v: 2, grants: original.grants.map(grant => ({ ...grant, sessionManagementV1: true })) }
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: legacy }))
    const bytes = await readFile(credentialsPath(fixture), 'utf8')
    const restarted = await boot(config, fixture.home)
    expect(restarted.ctx.companionHost.describe().paired).toEqual([{ ...approved.grant, sessionManagement: true, modelSelection: false }])
    expect(await readFile(credentialsPath(restarted), 'utf8')).toBe(bytes)
    await restarted.ctx.companionHost.setModelSelection({ kind: 'setModelSelection', grantId: approved.grant.grantId,
      expectedGeneration: approved.grant.generation, fingerprint: approved.grant.fingerprint, enabled: true })
    expect(await stored(restarted)).toEqual({ ...original,
      grants: original.grants.map(grant => ({ ...grant, sessionManagementV1: true, modelSelectionV1: true })) })
  })

  it.each([2, 3])('preserves v%s pairing and other consents until an explicit independent tool-details decision', async (version) => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    const original = await stored(fixture)
    await disableHost(fixture)
    const legacy = { ...original, v: version, grants: original.grants.map(grant => ({ ...grant,
      sessionManagementV1: true, ...(version === 3 ? { modelSelectionV1: true } : {}) })) }
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: legacy }))
    const bytes = await readFile(credentialsPath(fixture), 'utf8')
    const restarted = await boot(config, fixture.home)
    const before = { ...approved.grant, sessionManagement: true, modelSelection: version === 3, toolDetails: false }
    expect(restarted.ctx.companionHost.describe().paired).toEqual([before])
    expect(await readFile(credentialsPath(restarted), 'utf8')).toBe(bytes)
    const identity = { grantId: before.grantId, expectedGeneration: before.generation, fingerprint: before.fingerprint }
    await restarted.ctx.companionHost.setToolDetails({ kind: 'setToolDetails', ...identity, enabled: true })
    expect(restarted.ctx.companionHost.describe().paired).toEqual([{ ...before, toolDetails: true }])
    expect(await stored(restarted)).toEqual({ ...legacy, v: 5,
      grants: legacy.grants.map(grant => ({ ...grant, toolDetailsV1: true })) })
    await restarted.ctx.companionHost.setToolDetails({ kind: 'setToolDetails', ...identity, enabled: false })
    expect(restarted.ctx.companionHost.describe().paired).toEqual([before])
    expect((await stored(restarted)).grants[0]).not.toHaveProperty('toolDetailsV1')
  })

  it.each([1, 2, 3, 4])('reads v%s without enabling activation or rewriting, then preserves prior grants on explicit v5 activation consent', async (version) => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    const original = await stored(fixture)
    await disableHost(fixture)
    const grants = original.grants.map(grant => ({ ...grant,
      ...(version >= 2 ? { sessionManagementV1: true } : {}),
      ...(version >= 3 ? { modelSelectionV1: true } : {}),
      ...(version >= 4 ? { toolDetailsV1: true } : {}),
    }))
    const legacy = { ...original, v: version, grants }
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: legacy }))
    const bytes = await readFile(credentialsPath(fixture), 'utf8')
    const restarted = await boot(config, fixture.home)
    const before = { ...approved.grant, sessionManagement: version >= 2, modelSelection: version >= 3,
      toolDetails: version >= 4, sessionActivation: false }
    expect(restarted.ctx.companionHost.describe().paired).toEqual([before])
    expect(await readFile(credentialsPath(restarted), 'utf8')).toBe(bytes)
    await restarted.ctx.companionHost.setSessionActivation({ kind: 'setSessionActivation', grantId: before.grantId,
      expectedGeneration: before.generation, fingerprint: before.fingerprint, enabled: true })
    expect(restarted.ctx.companionHost.describe().paired).toEqual([{ ...before, sessionActivation: true }])
    expect(await stored(restarted)).toEqual({ ...legacy, v: 5,
      grants: grants.map(grant => ({ ...grant, sessionActivationV1: true })) })
  })

  it('reads a legacy grant as denied without rewriting and upgrades only explicit consent while preserving all identities', async () => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    expect(approved.grant.sessionManagement).toBe(false)
    const second = await candidate(fixture, approved.route, 'retained-phone')
    const offset = payloads(approved.route.ws).length
    const retained = await fixture.ctx.companionHost.approveCandidate(second.current.candidateId, second.current.fingerprint)
    await confirm(second.attempt, approved.route.ws, second.deliver, offset)
    const original = await stored(fixture)
    expect(original.v).toBe(5)
    expect(original.grants[0]).not.toHaveProperty('sessionManagementV1')
    await disableHost(fixture)
    const legacy = { ...original, v: 1 }
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: legacy }))
    const bytes = await readFile(credentialsPath(fixture), 'utf8')
    const restarted = await boot(config, fixture.home)
    expect(restarted.ctx.companionHost.describe().paired).toEqual([approved.grant, retained])
    expect(await readFile(credentialsPath(restarted), 'utf8')).toBe(bytes)
    expect(await stored(restarted)).toEqual(legacy)
    await restarted.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', grantId: approved.grant.grantId,
      expectedGeneration: approved.grant.generation, fingerprint: approved.grant.fingerprint, enabled: true })
    expect(await stored(restarted)).toEqual({ ...original,
      grants: original.grants.map(grant => grant.grantId === approved.grant.grantId ? { ...grant, sessionManagementV1: true } : grant) })
    expect(restarted.ctx.companionHost.describe().paired).toEqual([{ ...approved.grant, sessionManagement: true }, retained])
  })

  it.each(['grantId', 'generation', 'fingerprint'] as const)('denies a stale native %s without changing any durable grant', async (mismatch) => {
    const fixture = await boot()
    const approved = await approvedChannel(fixture)
    const original = await stored(fixture)
    const changed = { ...original, grants: original.grants.map(grant => ({ ...grant,
      ...(mismatch === 'grantId' ? { grantId: parseId('replaced-grant') } : {}),
      ...(mismatch === 'generation' ? { generation: grant.generation + 1 } : {}),
      ...(mismatch === 'fingerprint' ? { phoneIdentityKey: exportPublicKey(generateP256KeyPair().publicKey) } : {}) })) }
    // The unobserved external write is reconciled only after the permission operation enters the provider lock.
    const before = JSON.stringify({ version: 1, records: { [RECORD_KEY]: { kind: 'grant', payload: changed } } })
    await writeFile(credentialsPath(fixture), before, { mode: 0o600 })
    expect(fixture.ctx.companionHost.describe().paired).toEqual([approved.grant])
    await expect(fixture.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', grantId: approved.grant.grantId,
      expectedGeneration: approved.grant.generation, fingerprint: approved.grant.fingerprint, enabled: true }))
      .rejects.toThrow('stale or mismatched')
    expect(await readFile(credentialsPath(fixture), 'utf8')).toBe(before)
    expect(fixture.ctx.companionHost.describe()).toMatchObject({ available: false, connected: false })
    expect(await stored(fixture)).toEqual(changed)
  })

  it.each([false, true])('withdraws an enabled phone before a disable commit settles (failed commit: %s)', async (failCommit) => {
    const fixture = await boot()
    const initial = await approvedChannel(fixture)
    const command = { kind: 'setSessionManagement' as const, grantId: initial.grant.grantId,
      expectedGeneration: initial.grant.generation, fingerprint: initial.grant.fingerprint, enabled: true }
    await fixture.ctx.companionHost.setSessionManagement(command)
    const approved = await resumeChannel(fixture, initial)
    expect(approved.grant.sessionManagement).toBe(true)
    expect((await listSessions(approved, 1)).result.sessions).toEqual([])
    const path = credentialsPath(fixture)
    const before = await readFile(path, 'utf8')
    const enabledRecord = await stored(fixture)
    const commit = new RegressionBarrier()
    disk.beforeRename = async (target) => {
      if (target !== path) return
      await commit.enter()
      if (failCommit) throw Object.assign(new Error('permission commit failed'), { code: 'EIO' })
    }
    const disabling = fixture.ctx.companionHost.setSessionManagement({ ...command, enabled: false })
    const outcome = failCommit ? expect(disabling).rejects.toThrow('permission commit failed') : expect(disabling).resolves.toBeUndefined()
    cleanup.push(async () => { disk.beforeRename = undefined; commit.release(); await Promise.allSettled([disabling, outcome]) })
    // The close packet is emitted during the call, before its first queued store operation.
    expect(approved.route.ws.packets.at(-1)).toMatchObject({ type: 'relay-close', channelId: approved.phone.channelId })
    await commit.arrived
    const frames = payloads(approved.route.ws).length
    await approved.channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions', limit: 1,
      requestId: Buffer.alloc(16, 2).toString('base64url') })), async (frame) => { approved.phone.deliver(frame) })
    commit.release()
    await outcome
    expect(payloads(approved.route.ws)).toHaveLength(frames)
    if (failCommit) {
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(await stored(fixture)).toEqual(enabledRecord)
      expect(fixture.ctx.companionHost.describe()).toMatchObject({ available: false, connected: false,
        paired: [{ ...approved.grant, sessionManagement: true }] })
      await expect(fixture.ctx.companionHost.setSessionManagement(command)).rejects.toThrow('unavailable')
      disk.beforeRename = undefined
      await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async current => current)
      expect(fixture.ctx.companionHost.describe().available).toBe(false)
    } else {
      expect(await stored(fixture)).toEqual({ ...enabledRecord,
        grants: enabledRecord.grants.map(({ sessionManagementV1: _permission, ...grant }) => grant) })
      expect(fixture.ctx.companionHost.describe().paired).toEqual([{ ...approved.grant, sessionManagement: false }])
      const resumed = await resumeChannel(fixture, approved)
      expect((await listSessions(resumed, 3)).result.sessions).toEqual([])
    }
  })

  it('does not restore enabled chat authority from cached grants after source failure or source restoration', async () => {
    const fixture = await boot()
    const initial = await approvedChannel(fixture)
    await fixture.ctx.companionHost.setSessionManagement({ kind: 'setSessionManagement', grantId: initial.grant.grantId,
      expectedGeneration: initial.grant.generation, fingerprint: initial.grant.fingerprint, enabled: true })
    const approved = await resumeChannel(fixture, initial)
    const path = credentialsPath(fixture)
    const durable = await readFile(path, 'utf8')
    const lastGood = await stored(fixture)
    await writeFile(path, 'version: 1\nrecords: []\n', { mode: 0o600 })
    await expect(fixture.ctx.credentials.modifyRecord(credentialKey('regression', 'trigger'), async () => ({ kind: 'api-key' })))
      .rejects.toThrow('must be a mapping')
    expect(fixture.ctx.companionHost.describe()).toMatchObject({ available: false, connected: false,
      paired: [{ ...approved.grant, sessionManagement: true }] })
    const frames = payloads(approved.route.ws).length
    await approved.channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions', limit: 1,
      requestId: Buffer.alloc(16, 1).toString('base64url') })), async (frame) => { approved.phone.deliver(frame) })
    await writeFile(path, durable, { mode: 0o600 })
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async current => current)
    expect(fixture.ctx.companionHost.describe().available).toBe(false)
    expect(payloads(approved.route.ws)).toHaveLength(frames)
    expect(await stored(fixture)).toEqual(lastGood)
  })

  it.each([
    ['future version', { v: 6 }],
    ['unknown version', { v: 0 }],
    ['legacy authority field', { v: 1, permission: true }],
    ['explicit false', { v: 2, permission: false }],
    ['null permission', { v: 2, permission: null }],
    ['string permission', { v: 2, permission: 'true' }],
    ['unknown grant field', { v: 2, extra: true }],
    ['model permission on v1', { v: 1, modelPermission: true }],
    ['model permission on v2', { v: 2, modelPermission: true }],
    ['false model permission', { v: 3, modelPermission: false }],
    ['null model permission', { v: 3, modelPermission: null }],
    ['string model permission', { v: 3, modelPermission: 'true' }],
    ['tool details on v1', { v: 1, toolPermission: true }],
    ['tool details on v2', { v: 2, toolPermission: true }],
    ['tool details on v3', { v: 3, toolPermission: true }],
    ['false tool details', { v: 4, toolPermission: false }],
    ['null tool details', { v: 4, toolPermission: null }],
    ['string tool details', { v: 4, toolPermission: 'true' }],
    ['activation on v4', { v: 4, activationPermission: true }],
    ['false activation', { v: 5, activationPermission: false }],
    ['null activation', { v: 5, activationPermission: null }],
    ['string activation', { v: 5, activationPermission: 'true' }],
  ] as const)('refuses %s durable authority without resetting or rewriting', async (_name, corruption) => {
    const fixture = await boot()
    await approvedChannel(fixture)
    const original = await stored(fixture)
    await disableHost(fixture)
    const corrupt = { ...original, v: corruption.v, grants: original.grants.map(grant => ({ ...grant,
      ...('permission' in corruption ? { sessionManagementV1: corruption.permission } : {}),
      ...('modelPermission' in corruption ? { modelSelectionV1: corruption.modelPermission } : {}),
      ...('toolPermission' in corruption ? { toolDetailsV1: corruption.toolPermission } : {}),
      ...('activationPermission' in corruption ? { sessionActivationV1: corruption.activationPermission } : {}),
      ...('extra' in corruption ? { unknownAuthority: corruption.extra } : {}) })) }
    await fixture.ctx.credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: corrupt }))
    const before = await readFile(credentialsPath(fixture), 'utf8')
    const sockets = SocketTransport.instances.length
    const restarted = await boot(config, fixture.home)
    expect(restarted.ctx.get('companionHost')).toBeUndefined()
    expect(SocketTransport.instances).toHaveLength(sockets)
    expect(await readFile(credentialsPath(restarted), 'utf8')).toBe(before)
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

  it('sends navigation metadata only on opt-in requests over one confirmed encrypted grant', async () => {
    const fixture = await boot()
    for (const [name, plugin, options] of [
      ['navigation-title', SessionTitle, { fallbackMaxWords: 10, fallbackMaxBytes: 256, maxTitleBytes: 1024 }],
      ['navigation-cache', SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 }],
    ] as const) {
      fixture.ctx.loader.builtins[name] = plugin
      await fixture.ctx.loader.create({ name: `cordis:${name}`, config: options })
    }
    await fixture.ctx.loader.await()
    expect(fixture.ctx.get('sessionTitle')).toBeDefined()
    expect(fixture.ctx.get('sessionProjectionCache')).toBeDefined()
    const project = join(fixture.home, 'private-project')
    const emptyPath = join(fixture.home, 'empty-project')
    await Promise.all([project, emptyPath].map(path => mkdir(path, { recursive: true })))
    const registry = fixture.ctx.workspaceRegistry
    const workspace = await registry.create(project, 'مشروع 项目 😀')
    const empty = await registry.create(emptyPath, 'Private empty workspace')
    const addSession = (id: string, createdAt: number,
      extra: { origin?: 'subagent'; delegationDepth?: number } = {}) => {
      const session = fixture.ctx.sessions.prepare(SessionId(id), { meta: { cwd: project, createdAt, ...extra } })
      const detach = fixture.ctx.sessions.enter(session)
      cleanup.push(async () => { detach() })
      fixture.ctx.sessions.announce(session)
      session.append('session/title', { title: `Chat ${id}`, messageSeqs: [], source: { kind: 'user' } })
      return { session, detach }
    }
    const visible = addSession('visible', 1000)
    const loose = addSession('same-cwd-unassigned', 900).session
    const archived = addSession('archived-private', 6000).session
    const child = addSession('hidden-child', 7000, { origin: 'subagent' }).session
    const delegated = addSession('hidden-delegated', 8000, { delegationDepth: 1 }).session
    const noCwd = fixture.ctx.sessions.prepare(SessionId('hidden-no-cwd'), { meta: { createdAt: 9000 } })
    const detachNoCwd = fixture.ctx.sessions.enter(noCwd)
    cleanup.push(async () => { detachNoCwd() })
    await workspace.attachSession(visible.session.id)
    await workspace.attachSession(archived.id)
    await registry.archiveSession(archived.id)
    await registry.pinSession(visible.session.id)
    await registry.pinSession(child.id)
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(2000)
      visible.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'human prompt' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      clock.mockReturnValue(3000)
      visible.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'injected notice' }], source: { kind: 'watcher' },
      }), { surfaceOp: 'append' })
      clock.mockReturnValue(4000)
      visible.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }) }, { surfaceOp: 'append' })
      clock.mockReturnValue(5000)
      visible.session.append('session/title', { title: 'Renamed later', messageSeqs: [], source: { kind: 'user' } })
    } finally { clock.mockRestore() }
    {
      await using storedSession = await fixture.ctx.sessionPersistence.create(visible.session.header)
      await storedSession.append(visible.session.snapshotEvents())
      await storedSession.flush()
    }
    await fixture.ctx.sessionProjectionCache.write(visible.session)
    visible.detach()
    expect(fixture.ctx.sessions.get(visible.session.id)).toBeUndefined()
    expect(registry.list().map(row => row.id)).toEqual([empty.id, workspace.id])
    expect(registry.pinnedSessionIds).toEqual([child.id, visible.session.id])
    const approved = await approvedChannel(fixture)
    const legacyRows = [
      { sessionId: visible.session.id, title: 'Renamed later', status: 'closed' },
      { sessionId: loose.id, title: `Chat ${loose.id}`, status: 'closed' },
    ]
    const navigationRows = [
      { ...legacyRows[0], navigation: { updatedAt: 2000, pinOrder: 1,
        workspace: { id: workspace.id, title: workspace.title, order: 1 } } },
      { ...legacyRows[1], navigation: { updatedAt: 900, pinOrder: null, workspace: null } },
    ]
    for (const [index, view] of (['navigation', undefined, 'navigation'] as const).entries()) {
      const { result, plaintext } = await listSessions(approved, index + 1, view)
      expect(result.sessions).toEqual(view === undefined ? legacyRows : navigationRows)
      if (view === undefined) {
        expect(plaintext).toBe(JSON.stringify({ v: 1, type: 'sessions', requestId: result.requestId, sessions: legacyRows }))
        for (const row of result.sessions) expect(Object.keys(row).sort()).toEqual(['sessionId', 'status', 'title'])
      }
      for (const hidden of [fixture.home, project, empty.id, empty.title, archived.id, child.id, delegated.id, noCwd.id]) {
        expect(plaintext).not.toContain(JSON.stringify(hidden).slice(1, -1))
      }
      for (const key of ['cwd', 'path', 'sessionIds']) expect(plaintext).not.toContain(`"${key}":`)
    }
    expect(fixture.ctx.companionHost.describe().paired).toEqual([approved.grant])
    expect(approved.route.ws.packets.filter(packet => packet.type === 'relay-close')).toEqual([])
    expect(fixture.ctx.sessions.get(visible.session.id)).toBeUndefined()
  })

  it('closes a revoked encrypted channel without publishing a navigation read blocked on filesystem I/O', async () => {
    const fixture = await boot()
    const session = fixture.ctx.sessions.prepare(SessionId('withheld-navigation'), {
      meta: { cwd: fixture.home, createdAt: 1000 },
    })
    {
      await using storedSession = await fixture.ctx.sessionPersistence.create(session.header)
      await storedSession.flush()
    }
    const approved = await approvedChannel(fixture)
    const baseline = await listSessions(approved, 1, 'navigation')
    expect(baseline.result.sessions).toEqual([{ sessionId: session.id, title: '', status: 'closed',
      navigation: { updatedAt: 1000, pinOrder: null, workspace: null } }])
    const read = new RegressionBarrier()
    const root = join(dirname(fixture.home), 'sessions')
    disk.beforeReadDirectory = async (target) => { if (target === root) await read.enter() }
    const before = payloads(approved.route.ws).length
    await approved.channel.sendApplication(Buffer.from(JSON.stringify({ v: 1, type: 'listSessions', view: 'navigation',
      requestId: Buffer.alloc(16, 2).toString('base64url'), limit: 10 })), async (frame) => { approved.phone.deliver(frame) })
    await read.arrived
    const revocation = fixture.ctx.companionHost.revokeGrant(approved.grant.grantId)
    const revoked = expect(revocation).resolves.toBeUndefined()
    cleanup.push(async () => { read.release(); await Promise.allSettled([revocation, revoked]) })
    await vi.waitFor(() => { expect(approved.route.ws.packets.filter(packet => packet.type === 'relay-close')).toEqual([{
      v: 1, type: 'relay-close', channelId: approved.phone.channelId, socketGeneration: approved.route.pcGeneration,
      phoneSocketGeneration: approved.phone.phoneGeneration,
    }]) })
    expect(payloads(approved.route.ws)).toHaveLength(before)
    read.release()
    await revoked
    expect(payloads(approved.route.ws)).toHaveLength(before)
    expect((await stored(fixture)).grants).toEqual([])
    expect(fixture.ctx.companionHost.describe().paired).toEqual([])
    expect(approved.route.ws.readyState).toBe(SocketTransport.OPEN)
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
    await expect(entry.fiber!.restart())
      .rejects.toBe(fixture.ctx.credentials.sourceFailureSignal.reason)
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
