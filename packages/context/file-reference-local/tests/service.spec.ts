import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileReferenceService, { WorkspaceFileSearch } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementation(async agent => ctx.workingDirectory.get(agent.session))
  return ctx
}

async function stubAgent(
  ctx: Context,
  id = 'file-reference-agent',
  includeCwd = true,
): Promise<{ agent: Agent; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-reference-service-'))
  roots.push(root)
  await writeFile(join(root, 'README.md'), 'readme')
  const session = ctx.sessions.create(SessionId(id), { meta: includeCwd ? { cwd: root } : {} })
  const agent = {
    id: session.id,
    options: {},
    session,
    status: 'idle',
    acceptsNextStep: false,
    ctx,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  return { agent, dispose: await ctx.agents.register(agent) }
}

describe('LocalFileReferenceService', () => {
  it('validates the live directory before listing through the per-agent search', async () => {
    const ctx = await harness()
    try {
      const { agent } = await stubAgent(ctx)
      await ctx.plugin(LocalFileReferenceService)
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const signal = new AbortController().signal
      await expect(ctx.fileReferences.list(agent, 'README', signal))
        .resolves.toEqual([{ path: 'README.md', kind: 'file' }])
      expect(ensure).toHaveBeenCalledWith(agent, signal)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not query a cached search when directory validation fails', async () => {
    const ctx = await harness()
    try {
      const { agent } = await stubAgent(ctx)
      await ctx.plugin(LocalFileReferenceService)
      const ensure = vi.spyOn(ctx.workingDirectory, 'ensure')
      const signal = new AbortController().signal
      await ctx.fileReferences.list(agent, 'README', signal)
      const list = vi.spyOn(WorkspaceFileSearch.prototype, 'list')
      ensure.mockRejectedValueOnce(new Error('directory validation cancelled'))

      await expect(ctx.fileReferences.list(agent, 'README', signal))
        .rejects.toThrow('directory validation cancelled')
      expect(list).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replaces the cached index after a committed directory change without changing the project', async () => {
    const ctx = await harness()
    try {
      const { agent } = await stubAgent(ctx, 'changing-directory')
      const original = agent.session.header.cwd
      const directory = await mkdtemp(join(tmpdir(), 'dsh-file-reference-current-'))
      roots.push(directory)
      await writeFile(join(directory, 'CURRENT.md'), 'current')
      await ctx.plugin(LocalFileReferenceService)
      const signal = new AbortController().signal
      expect(await ctx.fileReferences.list(agent, 'README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])
      agent.session.append('working-directory/change', { cwd: directory })
      expect(await ctx.fileReferences.list(agent, 'CURRENT', signal)).toEqual([{ path: 'CURRENT.md', kind: 'file' }])
      expect(await ctx.fileReferences.list(agent, 'README', signal)).toEqual([])
      expect(agent.session.header.cwd).toBe(original)
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('defers guidance until optional prompt and tool services become available', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileReferenceService)
    try {
      const { agent } = await stubAgent(ctx, 'deferred-prompt')
      expect(ctx.agents.get(agent.id)).toBe(agent)
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      await ctx.plugin(ToolRegistry)
      ctx.tools.register(defineContentToolFixture({
        name: 'read', description: 'read a file', parameters: {}, execute: () => Promise.resolve([]),
      }))
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(FILE_REFERENCE_PROMPT)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the addressed workspace and installs read-tool guidance for existing agents', async () => {
    const ctx = await harness()
    const { agent } = await stubAgent(ctx)
    const fiber = ctx.plugin(LocalFileReferenceService, {
      maxResults: 5,
      maxEntries: 100,
      excludedDirectories: ['.git'],
    })
    await fiber
    await expect(ctx.fileReferences.list(agent, 'README', new AbortController().signal))
      .resolves.toEqual([{ path: 'README.md', kind: 'file' }])
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(FILE_REFERENCE_PROMPT)

    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'read a file',
      parameters: {},
      execute: () => Promise.resolve([]),
    }))
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(FILE_REFERENCE_PROMPT)
    await fiber.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(FILE_REFERENCE_PROMPT)
  })

  it('invalidates cached searches after tool results and disposes them with the agent', async () => {
    const ctx = await harness()
    const { agent, dispose } = await stubAgent(ctx)
    const invalidate = vi.spyOn(WorkspaceFileSearch.prototype, 'invalidate')
    const close = vi.spyOn(WorkspaceFileSearch.prototype, 'dispose')
    await ctx.plugin(LocalFileReferenceService)
    await ctx.fileReferences.list(agent, 'README', new AbortController().signal)

    const event = agent.session.append('session/end-seed', {})
    ctx.emit('session/event', agent.session, { ...event, type: 'tool/result' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    ctx.emit('session/event', agent.session, { ...event, type: 'assistant/message' } as never)
    expect(invalidate).toHaveBeenCalledOnce()
    const orphan = ctx.sessions.create(SessionId('file-reference-orphan'))
    ctx.emit('session/event', orphan, { ...orphan.append('session/end-seed', {}), type: 'tool/result' } as never)
    expect(invalidate).toHaveBeenCalledOnce()

    await dispose()
    expect(close).toHaveBeenCalledOnce()
    ctx.emit('agent/disposed', { agent })
  })

  it('installs guidance for agents announced after the service and validates deployment tunables', async () => {
    const ctx = await harness()
    await ctx.plugin(LocalFileReferenceService)
    const { agent } = await stubAgent(ctx)
    await expect(ctx.fileReferences.list(agent, '', new AbortController().signal))
      .resolves.toEqual([{ path: 'README.md', kind: 'file' }])

    const badResults = await harness()
    expect(() => new LocalFileReferenceService(badResults, { maxResults: 0 })).toThrow('maxResults')
    const badEntries = await harness()
    expect(() => new LocalFileReferenceService(badEntries, { maxEntries: 1.5 })).toThrow('maxEntries')
    const badExclusion = await harness()
    expect(() => new LocalFileReferenceService(badExclusion, { excludedDirectories: ['nested/name'] }))
      .toThrow('excludedDirectories')
    const fractionalResults = await harness()
    expect(() => new LocalFileReferenceService(fractionalResults, { maxResults: 1.5 })).toThrow('maxResults')
    const zeroEntries = await harness()
    expect(() => new LocalFileReferenceService(zeroEntries, { maxEntries: 0 })).toThrow('maxEntries')
    const emptyExclusion = await harness()
    expect(() => new LocalFileReferenceService(emptyExclusion, { excludedDirectories: [''] }))
      .toThrow('excludedDirectories')
    const backslashExclusion = await harness()
    expect(() => new LocalFileReferenceService(backslashExclusion, { excludedDirectories: ['nested\\name'] }))
      .toThrow('excludedDirectories')
  })

  it('deduplicates lifecycle announcements and falls back to the process cwd', async () => {
    const ctx = await harness()
    const fiber = ctx.plugin(LocalFileReferenceService)
    await fiber
    const { agent } = await stubAgent(ctx, 'cwd-fallback', false)
    await ctx.serial('agent/created', { agent, source: 'startup' })
    const list = vi.spyOn(WorkspaceFileSearch.prototype, 'list').mockResolvedValue([])
    await expect(ctx.fileReferences.list(agent, '', new AbortController().signal)).resolves.toEqual([])
    await expect(ctx.fileReferences.list(agent, 'src', new AbortController().signal)).resolves.toEqual([])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('logs rejected prompt cleanup without failing service teardown', async () => {
    const ctx = await harness()
    const fiber = ctx.plugin(LocalFileReferenceService)
    await fiber
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const inject = vi.spyOn(ctx, 'inject')
      .mockReturnValueOnce({ dispose: () => Promise.reject(new Error('error cleanup')) } as never)
      // Deliberately proves cleanup tolerates JavaScript callers rejecting non-Error values.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      .mockReturnValueOnce({ dispose: () => Promise.reject('string cleanup') } as never)
    const first = await stubAgent(ctx, 'cleanup-one')
    const second = await stubAgent(ctx, 'cleanup-two')
    expect(inject).toHaveBeenCalledTimes(2)
    await first.dispose()
    await second.dispose()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('file-reference-local: prompt cleanup failed: error cleanup')
      expect(warn).toHaveBeenCalledWith('file-reference-local: prompt cleanup failed: string cleanup')
    })
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })
})
