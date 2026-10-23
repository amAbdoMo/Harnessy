/** Companion history assertions over the real Session harvested by the recorded headless scenario. */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import {
  encodeApplicationResult, parseApplicationBudget, parseApplicationRequest, parseApplicationResult, parseId,
} from '@deepseek-ai/dsh-companion-protocol'
import type {
  ApplicationResult, GrantId, MobileOperationId, MobileRequestId, MobileSessionId,
} from '@deepseek-ai/dsh-companion-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionActivationComposition } from '../../../api/session-controller/tests/session-activation-host-fixture.ts'
import { createApplicationDispatcher } from '../src/application-dispatch.ts'
import { mobileHistoryPage } from '../src/session-view.ts'

/**
 * Compare recorded read activity with its phone rendering and message-only rendering.
 * @param events - Current events decoded from the replay process's persisted Session.
 * @param cwd - Replay workspace used to resolve safe relative target labels.
 * @param expectationPath - Scenario-owned ordered phone-row expectation.
 * @returns Resolves after complete row, correlation and privacy assertions.
 */
export async function verifyCompanionReadHistory(events: readonly SessionEvent[], cwd: string, expectationPath: string): Promise<void> {
  const budget = parseApplicationBudget({ maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024,
    maxTitleBytes: 128, maxRows: 10, maxSessions: 10, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
    readTimeoutMs: 10000, subscriptionLifetimeMs: 60000 })
  const requireCurrent = (): void => {}
  const options = { offset: 0, through: events.length, limit: budget.maxRows, budget, requireCurrent }
  const messagePage = mobileHistoryPage(events, options)
  const detailPage = mobileHistoryPage(events, { ...options, toolDetails: { cwd, requireCurrent } })
  const observed = {
    withoutDetails: messagePage.rows.map(({ role, text }) => ({ role, text })),
    withDetails: detailPage.rows.map(({ role, text }) => ({ role, text })),
  }
  const readMetadata = events.filter(event => event.type === 'tool/result').map(event => event.data.meta)
  expect(observed, JSON.stringify({ cwd, readMetadata })).toEqual(JSON.parse(await readFile(expectationPath, 'utf8')))
  const call = events.find(event => event.type === 'tool/call')
  const completion = events.find(event => event.type === 'tool/result')
  if (call === undefined || completion === undefined) throw new Error('fs-read emitted no correlated read activity')
  expect(detailPage.rows.map(entry => entry.id)).toEqual([
    messagePage.rows[0]?.id, `event-${call.seq}`, `event-${completion.seq}`, messagePage.rows[1]?.id,
  ])
  const rendered = JSON.stringify(observed)
  for (const privateText of ['hello', '<content>', '"file_path"', cwd]) expect(rendered).not.toContain(privateText)
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'reasoning') expect(rendered).not.toContain(block.text)
    }
  }
}

/**
 * Exercise phone activation and per-chat model choice against the harvested Session.
 * @param persistedSession - Exact JSONL bytes from the completed headless replay.
 * @param sessionId - Header identity for those bytes.
 * @param cwd - Existing project directory recorded by that Session.
 * @param expectedEvents - Events decoded from the same persisted log.
 * @returns Resolves after activation, model-choice, and no-generation assertions.
 */
export async function verifyCompanionColdSessionControl(
  persistedSession: string,
  sessionId: string,
  cwd: string,
  expectedEvents: readonly SessionEvent[],
): Promise<void> {
  const budget = parseApplicationBudget({ maxRequestBytes: 4096, maxResultBytes: 4096, maxTextBytes: 1024,
    maxTitleBytes: 128, maxRows: 10, maxSessions: 10, maxSubscriptionsPerGrant: 2, maxPendingSubmissionsPerGrant: 2,
    readTimeoutMs: 10000, subscriptionLifetimeMs: 60000 })
  const fixture = await sessionActivationComposition()
  const id = SessionId(sessionId)
  const coldPath = await fixture.seedColdSession(id, cwd, persistedSession)
  const coldEvents = await fixture.events(id)
  expect(coldEvents, 'JSONL source reads the harvested Session before activation').toEqual(expectedEvents)
  expect(await readFile(coldPath, 'utf8')).toBe(persistedSession)
  await fixture.controller.inspect(id)
  expect(fixture.ctx.agents.get(id), 'inspection leaves the Session cold').toBeUndefined()

  const otherId = await fixture.persist(SessionId('recorded-companion-other-chat'))
  const otherBefore = await fixture.events(otherId)
  expect(fixture.ctx.agents.get(otherId), 'persisted comparison chat is cold').toBeUndefined()
  const lifetime = new AbortController()
  const dispatcher = createApplicationDispatcher(fixture.ctx, {
    signal: lifetime.signal,
    requireCurrent: () => {},
    managementAccess: () => false,
    modelAccess: () => true,
    toolDetailsAccess: () => false,
    activationAccess: () => true,
    grantId: parseId<GrantId>('recorded-session-grant'),
    generation: 1,
    budget,
    maxWatches: 1,
    maxPendingRequests: 4,
    maxProgressBuffer: 2,
    sendProgress: async () => {},
  })
  const send = async (message: object): Promise<ApplicationResult> => {
    const request = parseApplicationRequest(JSON.stringify(message), budget)
    return parseApplicationResult(encodeApplicationResult(await dispatcher.dispatch(request), budget), budget)
  }
  try {
    const mobileId = parseId<MobileSessionId>(sessionId)
    const otherMobileId = parseId<MobileSessionId>(String(otherId))
    const opened = await send({ v: 1, type: 'openSession', requestId: parseId<MobileRequestId>(randomBytes(16).toString('base64url')),
      operationId: parseId<MobileOperationId>(randomBytes(16).toString('base64url')), sessionId: mobileId })
    expect(opened).toMatchObject({ type: 'sessionOpened', outcome: 'applied', session: { sessionId: mobileId, status: 'idle' } })
    const otherOpened = await send({ v: 1, type: 'openSession', requestId: parseId<MobileRequestId>(randomBytes(16).toString('base64url')),
      operationId: parseId<MobileOperationId>(randomBytes(16).toString('base64url')), sessionId: otherMobileId })
    expect(otherOpened).toMatchObject({ type: 'sessionOpened', outcome: 'applied', session: { sessionId: otherMobileId } })

    const targetAgent = fixture.ctx.agents.get(id)
    const otherAgent = fixture.ctx.agents.get(otherId)
    if (targetAgent === undefined || otherAgent === undefined) throw new Error('phone activation did not retain both Agents')
    const targetBefore = await fixture.events(id)
    expect(targetBefore.slice(0, expectedEvents.length)).toEqual(expectedEvents)
    expect(targetBefore.slice(expectedEvents.length).map(event => event.type)).toEqual(['session/end-seed'])
    const otherAfterActivation = await fixture.events(otherId)
    expect(otherAfterActivation.slice(0, otherBefore.length)).toEqual(otherBefore)
    expect(otherAfterActivation.slice(otherBefore.length).map(event => event.type)).toEqual(['session/end-seed'])
    expect((await readFile(coldPath, 'utf8')).startsWith(persistedSession)).toBe(true)
    const defaults = fixture.ctx.agentDefaultModel.currentSelection()
    const otherSelection = fixture.controller.currentModelSelection(otherAgent)
    expect(otherSelection).toEqual(defaults)
    expect(targetAgent.inbox.nextStep).toHaveLength(0)
    expect(targetAgent.inbox.nextTurn).toHaveLength(0)
    expect(otherAgent.inbox.nextStep).toHaveLength(0)
    expect(otherAgent.inbox.nextTurn).toHaveLength(0)

    const offered = await send({ v: 1, type: 'listSessionModels', requestId: parseId<MobileRequestId>(randomBytes(16).toString('base64url')),
      sessionId: mobileId, limit: 10 })
    if (offered.type !== 'sessionModels' || offered.state !== 'ready') throw new Error('phone model catalog was not ready')
    const choice = offered.models.find(model => model.title === 'Other model')
    if (choice === undefined) throw new Error('phone model catalog omitted the alternate model')
    const selected = await send({ v: 1, type: 'selectSessionModel', requestId: parseId<MobileRequestId>(randomBytes(16).toString('base64url')),
      operationId: parseId<MobileOperationId>(randomBytes(16).toString('base64url')), sessionId: mobileId,
      revision: offered.revision, choiceId: choice.id })
    expect(selected).toMatchObject({ type: 'modelSelected', outcome: 'applied', sessionId: mobileId,
      selected: { title: 'Other model' } })

    expect(fixture.controller.currentModelSelection(targetAgent)).toEqual({ provider: 'fixture', model: 'other-model' })
    expect(fixture.controller.currentModelSelection(otherAgent)).toEqual(otherSelection)
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual(defaults)
    const targetAfter = await fixture.events(id)
    expect(targetAfter.slice(0, targetBefore.length)).toEqual(targetBefore)
    const added = targetAfter.slice(targetBefore.length)
    expect(added).toMatchObject([{ type: 'model/selection', data: { provider: 'fixture', model: 'other-model' } }])
    expect(added).toHaveLength(1)
    expect(await fixture.events(otherId)).toEqual(otherAfterActivation)
    expect(targetAgent.inbox.nextStep).toHaveLength(0)
    expect(targetAgent.inbox.nextTurn).toHaveLength(0)
    expect(otherAgent.inbox.nextStep).toHaveLength(0)
    expect(otherAgent.inbox.nextTurn).toHaveLength(0)
    expect((await readFile(coldPath, 'utf8')).startsWith(persistedSession)).toBe(true)
  } finally {
    lifetime.abort()
    await dispatcher.close()
  }
}
