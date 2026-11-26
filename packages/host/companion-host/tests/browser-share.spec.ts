/** Paired-phone native browser-share dispatch; the Desktop provider is the only mocked boundary. */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  parseAndroidUpdateOffer, parseApplicationRequest, parseApplicationResult, parseId,
} from '@deepseek-ai/dsh-companion-protocol'
import type { ApplicationResult, BrowserShareId, GrantId } from '@deepseek-ai/dsh-companion-protocol'
import { expect, it, onTestFinished, describe, vi } from 'vitest'
import { createApplicationDispatcher } from '../src/application-dispatch.ts'
import type { AndroidUpdateProvider, BrowserShareHandler } from '../src/types.ts'
import { composition, config } from './composition.ts'

const budget = config.budgets.application
const requestId = Buffer.alloc(16, 1).toString('base64url')
const shareId = brandString<BrowserShareId>('e7ceaa5b-761d-4e48-9abc-9fa732df8617')
const grantId = parseId<GrantId>('browser-share-grant')

class Barrier {
  private readonly arrival = Promise.withResolvers<undefined>()
  private readonly releasePromise = Promise.withResolvers<undefined>()
  readonly arrived = this.arrival.promise
  enter(): Promise<void> { this.arrival.resolve(undefined); return this.releasePromise.promise }
  release(): void { this.releasePromise.resolve(undefined) }
}

async function fixture(browserShare?: BrowserShareHandler, androidUpdates?: AndroidUpdateProvider) {
  const current = { value: true }
  const pushed: ApplicationResult[] = []
  const owner = await composition({ ...config, budgets: { ...config.budgets, application: { ...budget, maxResultBytes: 32_768 } } })
  const dispatcher = createApplicationDispatcher(owner.ctx, {
    signal: owner.owner.signal, requireCurrent: () => { if (!current.value) throw new Error('grant retired') },
    managementAccess: () => false, modelAccess: () => false, toolDetailsAccess: () => false,
    activationAccess: () => false, ...(browserShare === undefined ? {} : { browserShare }), grantId, generation: 1,
    ...(androidUpdates === undefined ? {} : { androidUpdates }),
    budget: { ...budget, maxResultBytes: 32_768 }, maxWatches: 1, maxPendingRequests: 4, maxProgressBuffer: 2,
    sendProgress: async (result) => { pushed.push(result) },
  })
  onTestFinished(async () => { current.value = false; owner.owner.abort(); await dispatcher.close(); await owner.close() })
  const dispatch = (type: string, fields?: object) => dispatcher.dispatch(parseApplicationRequest(JSON.stringify({
    v: 1, type, requestId, ...fields,
  }), { ...budget, maxResultBytes: 32_768 }))
  return { current, dispatcher, pushed, dispatch }
}

function request(type: 'watchBrowserShare' | 'stopBrowserShare', id?: BrowserShareId) {
  const raw = { v: 1, type, requestId, ...(id === undefined ? {} : { shareId: id }) }
  return parseApplicationRequest(JSON.stringify(raw), { ...budget, maxResultBytes: 32_768 })
}

function browserResult(result: ApplicationResult) {
  return parseApplicationResult(JSON.stringify(result), { ...budget, maxResultBytes: 32_768 })
}

describe('native browser-share dispatch', () => {
  it('pushes distinct frames under a single subscription and stops delivery after exact cancellation', async () => {
    let jpeg = 'anBlZw=='
    const f = await fixture(async () => ({ status: 'frame', shareId, jpeg }))
    await expect(f.dispatch('subscribeBrowserShare')).resolves.toMatchObject({ status: 'idle' })
    await vi.waitFor(() => { expect(f.pushed).toEqual([{ v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg }]) })
    jpeg = 'bmV3'
    await vi.waitFor(() => { expect(f.pushed.at(-1)).toMatchObject({ requestId, status: 'frame', jpeg }) })
    await expect(f.dispatch('unsubscribeBrowserShare', { watchId: requestId })).resolves.toMatchObject({ status: 'ended' })
    await f.dispatcher.close()
    expect(f.pushed).toHaveLength(2)
  })

  it('only serves update chunks after matching the installed hash and a newer version', async () => {
    const artifactId = 'a'.repeat(64)
    const baseSha256 = 'b'.repeat(64)
    const offer = parseAndroidUpdateOffer({
      artifactId, baseSha256, targetSha256: 'c'.repeat(64), versionCode: 4, targetBytes: 1024, patchBytes: 8,
    })
    const f = await fixture(undefined, { offer: async () => offer, chunk: async () => 'SFlEMQAAAAA=' })
    const read = () => f.dispatch('readAndroidUpdate', { artifactId, offset: 0 })
    await expect(read()).resolves.toMatchObject({ type: 'error', code: 'notFound' })
    await expect(f.dispatch('checkAndroidUpdate', { installedSha256: baseSha256, versionCode: 4 })).resolves.toMatchObject({ offer: null })
    await expect(f.dispatch('checkAndroidUpdate', { installedSha256: baseSha256, versionCode: 3 })).resolves.toMatchObject({ offer })
    await expect(read()).resolves.toMatchObject({ type: 'androidUpdateChunk', artifactId, offset: 0, data: 'SFlEMQAAAAA=' })
  })
  it('reports idle without an optional native provider and ended for an exact stop', async () => {
    const f = await fixture()
    expect(await f.dispatcher.dispatch(request('watchBrowserShare'))).toEqual({
      v: 1, type: 'browserShare', requestId, status: 'idle',
    })
    expect(await f.dispatcher.dispatch(request('stopBrowserShare', shareId))).toEqual({
      v: 1, type: 'browserShare', requestId, status: 'ended',
    })
  })

  it('forwards discovery, exact watch and exact stop only to the paired native provider', async () => {
    const calls: { readonly kind: string; readonly shareId?: BrowserShareId }[] = []
    const provider: BrowserShareHandler = async (operation, signal) => {
      expect(signal.aborted).toBe(false)
      calls.push(operation)
      if (operation.kind === 'stop') return { status: 'ended' }
      return { status: 'frame', shareId, jpeg: 'anBlZw==' }
    }
    const f = await fixture(provider)
    expect(browserResult(await f.dispatcher.dispatch(request('watchBrowserShare')))).toEqual({
      v: 1, type: 'browserShare', requestId, status: 'frame', shareId, jpeg: 'anBlZw==',
    })
    expect(browserResult(await f.dispatcher.dispatch(request('watchBrowserShare', shareId)))).toMatchObject({ status: 'frame', shareId })
    expect(await f.dispatcher.dispatch(request('stopBrowserShare', shareId))).toMatchObject({ type: 'browserShare', status: 'ended' })
    expect(calls).toEqual([{ kind: 'watch' }, { kind: 'watch', shareId }, { kind: 'stop', shareId }])
  })

  it('does not return a frame for a different exact share or for a stop callback', async () => {
    const provider: BrowserShareHandler = async () => ({ status: 'frame', shareId, jpeg: 'anBlZw==' })
    const f = await fixture(provider)
    const other = brandString<BrowserShareId>('e7ceaa5b-761d-4e48-9abc-9fa732df8618')
    expect(await f.dispatcher.dispatch(request('watchBrowserShare', other))).toMatchObject({ status: 'ended' })
    expect(await f.dispatcher.dispatch(request('stopBrowserShare', shareId))).toMatchObject({ status: 'ended' })
  })

  it('withdraws a provider result when the grant retires while capture is awaited', async () => {
    const barrier = new Barrier()
    const provider: BrowserShareHandler = async () => {
      await barrier.enter()
      return { status: 'frame', shareId, jpeg: 'anBlZw==' }
    }
    const f = await fixture(provider)
    const pending = f.dispatcher.dispatch(request('watchBrowserShare'))
    await barrier.arrived
    f.current.value = false
    barrier.release()
    expect(await pending).toEqual({ v: 1, type: 'error', requestId, code: 'denied' })
  })
})
