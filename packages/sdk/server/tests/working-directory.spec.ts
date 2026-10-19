import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

class DirectoryOnlyAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('directory operations must not dispatch a model request')
  }
}

async function fixture(withDirectory = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-working-directory-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    if (withDirectory) await ctx.plugin(WorkingDirectory, {})
    ctx.llm.registerAdapter(['directory-test'], new DirectoryOnlyAdapter())
    const transport: JsonRpcTransportPeer = {
      async request() { throw new Error('unexpected outbound request') },
      notify() {},
    }
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    return {
      root, ctx, server,
      async initialize() {
        await server.handleRequest('initialize', { cwd: root, provider: 'directory-test', model: 'model' })
      },
      async [Symbol.asyncDispose]() {
        try { await server.shutdown() }
        finally {
          await ctx.fiber.dispose()
          await rm(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe('SDK working-directory operations', () => {
  it('keeps original project identity and independent Sessions while logging changes before reply', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'selected'))
    await f.initialize()
    expect(await f.server.handleRequest('session/working-directory/get', { sessionId: 'first' })).toEqual({ cwd: f.root })
    const first = f.ctx.sessions.get(SessionId('first'))!
    expect(first.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
    expect(await f.server.handleRequest('session/working-directory/set', { sessionId: 'first', path: 'selected' }))
      .toEqual({ cwd: join(f.root, 'selected') })
    expect(first.header.cwd).toBe(f.root)
    expect(first.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual([expect.objectContaining({ data: { cwd: join(f.root, 'selected') } })])
    expect(await f.server.handleRequest('session/working-directory/get', { sessionId: 'second' })).toEqual({ cwd: f.root })
    expect(await f.server.handleRequest('session/working-directory/set', { sessionId: 'first', path: '..' })).toEqual({ cwd: f.root })
    expect(first.header.cwd).toBe(f.root)
  })

  it.each([
    ['session/working-directory/get', {}],
    ['session/working-directory/get', { sessionId: '' }],
    ['session/working-directory/set', { sessionId: 'invalid' }],
    ['session/working-directory/set', { sessionId: 'invalid', path: '' }],
  ])('rejects malformed %s parameters before creating a Session', async (method, params) => {
    await using f = await fixture()
    await f.initialize()
    await expect(f.server.handleRequest(method, params)).rejects.toBeInstanceOf(TypeError)
    expect(f.ctx.sessions.list()).toEqual([])
  })

  it('refuses an uninitialized or unavailable directory operation without allocating an Agent', async () => {
    await using f = await fixture(false)
    await expect(f.server.getWorkingDirectory({ sessionId: 'uninitialized' })).rejects.toThrow('not initialized')
    await f.initialize()
    await expect(f.server.getWorkingDirectory({ sessionId: 'unsupported' })).rejects.toThrow('require the directory service')
    expect(f.ctx.sessions.list()).toEqual([])
  })

  it('rejects and drains a directory request whose fresh Agent is still being published at shutdown', async () => {
    await using f = await fixture()
    await f.initialize()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stopObserving = f.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== SessionId('creating-at-shutdown')) return
      entered.resolve(undefined)
      await release.promise
    })
    const pending = f.server.getWorkingDirectory({ sessionId: 'creating-at-shutdown' })
    const rejection = expect(pending).rejects.toThrow('SDK server is shutting down')
    let closing: Promise<unknown> | undefined
    try {
      await entered.promise
      closing = f.server.shutdown()
      await expect(f.server.getWorkingDirectory({ sessionId: 'after-shutdown-start' }))
        .rejects.toThrow('SDK server is shutting down')
      release.resolve(undefined)
      await rejection
      await closing
      expect(f.ctx.agents.list()).toEqual([])
      expect(f.ctx.sessions.list()).toEqual([])
    } finally {
      release.resolve(undefined)
      stopObserving()
      await Promise.allSettled([pending, rejection, closing])
    }
  })

  it('cancels and drains a directory inspection before SDK shutdown releases its Agents', async () => {
    await using f = await fixture()
    await f.initialize()
    await f.server.getWorkingDirectory({ sessionId: 'closing' })
    const session = f.ctx.sessions.get(SessionId('closing'))!
    await mkdir(join(f.root, 'selected'))
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    let lookupPending = true
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target, signal) => {
      const info = await stat(target)
      if (signal === undefined) throw new Error('expected directory operation cancellation')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      await release.promise
      lookupPending = false
      return info
    })
    const pending = f.server.setWorkingDirectory({ sessionId: 'closing', path: 'selected' })
    const rejection = expect(pending).rejects.toThrow('SDK server is shutting down')
    let closing: Promise<unknown> | undefined
    try {
      await entered.promise
      closing = f.server.shutdown().then(() => { expect(lookupPending).toBe(false) })
      await aborted.promise
      release.resolve(undefined)
      await rejection
      await closing
      expect(session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      expect(f.ctx.agents.list()).toEqual([])
      expect(f.ctx.sessions.list()).toEqual([])
      await expect(f.server.getWorkingDirectory({ sessionId: 'late' })).rejects.toThrow('SDK server is shutting down')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, rejection, closing])
      probe.mockRestore()
    }
  })
})
