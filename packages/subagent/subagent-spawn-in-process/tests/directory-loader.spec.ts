/** First-request directory binding through Loader and the shipped spawn provider. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Spawn from '../src/index.ts'

/** Owns the private filesystem and drains the complete plugin tree before removal. */
class TestScope {
  readonly ctx = new Context()

  constructor(readonly root: string) {}

  async close(): Promise<void> {
    try {
      await this.ctx.fiber.dispose()
    } finally {
      await rm(this.root, { recursive: true, force: true })
    }
  }
}

async function directoryComposition() {
  const scope = new TestScope(await realpath(await mkdtemp(join(tmpdir(), 'dsh-child-directory-loader-'))))
  onTestFinished(() => scope.close())
  const { ctx, root } = scope
  const original = join(root, 'original')
  const selected = join(root, 'selected')
  await Promise.all([original, selected].map(directory => mkdir(directory)))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', Spawn],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job request') },
    resolveSync(): never { throw new Error('Unexpected module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  const rows = [...modules.keys()].map(name => ({
    name,
    ...name === '@deepseek-ai/dsh-agent-loop' ? { config: { agents: [] } } : {},
    ...name === '@deepseek-ai/dsh-session-persistence-jsonl'
      ? { config: { root: join(root, 'sessions'), compression: 'none' } } : {},
  }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(rows) + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const inactive = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(inactive.map(entry => entry.options.name)).toEqual([])
  const adapter = new MockAdapter([textResponse('child done')])
  ctx.effect(() => ctx.llm.registerAdapter(['child-fixture'], adapter))
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('parent observed completion')])))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: original })
  const captured = await ctx.workingDirectory.set(parent, selected)
  return { ctx, parent, adapter, original, captured }
}

describe('Loader child first-request directory', () => {
  it.each(['one-shot', 'continuable'] as const)('binds the captured directory before the %s child first request and persists it', async (mode) => {
    const { ctx, parent, adapter, original, captured } = await directoryComposition()
    const header = parent.session.header
    const parentEvents = parent.session.snapshotEvents()
    const request = {
      parent, prompt: [{ type: 'text' as const, text: 'Report your directory.' }],
      agentOptions: { provider: 'child-fixture', model: 'mock' },
    }
    const signal = new AbortController().signal
    let childId: SessionId
    if (mode === 'one-shot') {
      const run = await ctx.subagents.start('spawn', { ...request, signal })
      childId = run.id
      try {
        await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
      } finally {
        await run.dispose()
      }
    } else {
      const started = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'directory child', request, signal })
      childId = started.childId
      await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() })
    }
    expect(adapter.requests).toHaveLength(1)
    const first = adapter.requests[0]
    if (first === undefined) throw new Error('Child made no model request')
    const contextText = first.messages
      .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    expect(contextText).toContain(`Current working directory: ${JSON.stringify(captured)}.`)
    expect(contextText).not.toContain(`Current working directory: ${JSON.stringify(original)}.`)
    expect(parent.session.header).toBe(header)
    expect(parent.session.header.cwd).toBe(original)
    expect(parent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
      .toEqual(parentEvents.filter(event => event.type === 'working-directory/change'))
    expect(ctx.workingDirectory.get(parent.session)).toBe(captured)

    await ctx.sessionPersistence.flush()
    const stored = await ctx.sessionPersistence.open(childId, 'read')
    try {
      expect(stored.header.cwd).toBe(original)
      expect(stored.header.parentSession).toBe(parent.id)
      const { events } = await stored.read()
      const change = events.find(event => event.type === 'working-directory/change')
      const runtime = events.find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
      expect(change).toMatchObject({ data: { cwd: captured } })
      if (change === undefined || runtime === undefined || runtime.type !== 'user/message') {
        throw new Error('Stored child lacks directory installation or runtime context')
      }
      expect(change.seq).toBeLessThan(runtime.seq)
      expect(runtime.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toBe(contextText)
      expect(ctx.workingDirectory.get(Session.create(childId, events, stored.header))).toBe(captured)
      expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    } finally {
      await stored.close()
    }
  })
})
