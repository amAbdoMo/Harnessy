import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { ModsEngine } from '../src/engine.ts'
import { createHostOps, type AgentBinding } from '../src/host-ops.ts'
import { createToolNameAliases } from '../src/tool-names.ts'

async function fixture(withDirectory = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mods-directory-')))
  const ctx = new Context()
  try {
    const plugins = [
      'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop',
      'fs-local', 'subprocess-local', ...withDirectory ? ['working-directory'] : [],
    ]
    const config = join(root, 'cordis.yml')
    await writeFile(config, plugins.map(name => `- name: '@deepseek-ai/dsh-${name}'\n`).join(''))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = undefined
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const ops = createHostOps({
      ctx, aliases: createToolNameAliases(), processTimeoutMs: 5000, registrations: new Map(),
      callOrigins: new Map(), modCommands: new Set(), modTools: new Set(),
    })
    const engine = new ModsEngine<AgentBinding>({
      ops: op => ops[op], stateKey: binding => binding.agent?.session.id ?? '',
      budgetMs: 1000, catchBudgetMs: 100, report: (line) => { throw new Error(line) },
    })
    ctx.effect(() => () => engine.dispose())
    const mod = { name: 'directory-test', version: undefined, root, options: {}, order: 0 }
    return {
      root, ctx,
      call: (op: string, input: unknown, agent?: Agent, signal = new AbortController().signal) =>
        Promise.resolve().then(() => ops[op]?.(input, { mod, binding: { agent }, signal, engine })),
      async mountBridge() {
        await ctx.loader.create({ name: '@deepseek-ai/dsh-experimental-claude-code-mods' })
        await ctx.loader.await()
        for (const entry of ctx.loader.entries()) await entry.fiber?.await()
      },
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

it('executes relative files and default processes in the selected directory while retaining the original root', async () => {
  await using f = await fixture()
  const hostCwd = process.cwd()
  const selected = join(f.root, 'selected')
  await mkdir(selected)
  await writeFile(join(f.root, 'origin.txt'), 'origin')
  await writeFile(join(selected, 'notes.txt'), 'selected')
  const handle = await f.ctx.agents.create({ sessionId: SessionId('execution'), meta: { cwd: f.root } })
  const { agent } = handle
  const header = agent.session.header
  await f.ctx.workingDirectory.set(agent, selected)
  expect(await f.call('session.cwd', {}, agent)).toBe(selected)
  expect(await f.call('session.root', {}, agent)).toBe(f.root)
  expect(await f.call('fs.read', { path: 'notes.txt' }, agent)).toBe('selected')
  expect(await f.call('fs.exists', { path: 'origin.txt' }, agent)).toBe(false)
  expect(await f.call('fs.stat', { path: 'notes.txt' }, agent)).toEqual({ kind: 'file', size: 8, mtimeMs: 0, isLink: false })
  expect(await f.call('fs.list', { path: '.' }, agent)).toEqual([{ name: 'notes.txt', kind: 'file', size: 8, isLink: false }])
  await f.call('fs.write', { path: 'written.txt', text: 'written' }, agent)
  expect(await readFile(join(selected, 'written.txt'), 'utf8')).toBe('written')
  await expect(readFile(join(f.root, 'written.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  const argv = [process.execPath, '-e', 'process.stdout.write(process.cwd())']
  expect(await f.call('process.run', { argv }, agent)).toEqual({ exitCode: 0, stdout: selected, stderr: '' })
  expect(await f.call('process.run', { argv, init: { cwd: f.root } }, agent)).toEqual({ exitCode: 0, stdout: f.root, stderr: '' })
  expect(process.cwd()).toBe(hostCwd)
  expect(agent.session.header).toBe(header)
  expect(agent.session.header.cwd).toBe(f.root)
  expect(agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({ type: 'working-directory/change', data: { cwd: selected } }))
  const signal = AbortSignal.abort(new Error('directory execution cancelled'))
  await expect(f.call('fs.read', { path: 'notes.txt' }, agent, signal)).rejects.toThrow('directory execution cancelled')
  await handle.dispose()
  expect(await f.call('session.cwd', {}, agent)).toBe(selected)
})

it('projects the selected session.start cwd and reads committed cwd in session.end after real Agent disposal', async () => {
  await using f = await fixture()
  await f.mountBridge()
  const selected = join(f.root, 'selected')
  await mkdir(selected)
  const started: unknown[] = []
  const ended = Promise.withResolvers<{ cwd: string; root: string; disposed: boolean }>()
  await f.ctx.claudeCodeMods.add({
    name: 'directory-lifecycle', root: f.root,
    register(on) {
      on('session.start', async ($, event, next) => {
        started.push({ cwd: event.cwd, current: await $.session.cwd(), root: await $.session.root() })
        return next(event)
      })
      on('session.end', async ($, event, next) => {
        try {
          ended.resolve({
            cwd: await $.session.cwd(), root: await $.session.root(),
            disposed: f.ctx.agents.get(SessionId(event.sessionId)) === undefined,
          })
        } catch (error) {
          ended.reject(error)
        }
        return next(event)
      })
    },
  })
  const handle = await f.ctx.agents.create({
    sessionId: SessionId('lifecycle'), meta: { cwd: f.root },
    setup: async (_ctx, agent) => { await f.ctx.workingDirectory.set(agent, selected) },
  })
  expect(started).toEqual([{ cwd: selected, current: selected, root: f.root }])
  await handle.dispose()
  expect(() => { handle.agent.ctx.fiber.assertActive() }).toThrow()
  await expect(ended.promise).resolves.toEqual({ cwd: selected, root: f.root, disposed: true })
  expect(handle.agent.session.header.cwd).toBe(f.root)
})

it('names a missing directory service for Agent-backed defaults without changing agentless or explicit-cwd behavior', async () => {
  await using f = await fixture(false)
  const handle = await f.ctx.agents.create({ sessionId: SessionId('missing-directory'), meta: { cwd: f.root } })
  for (const [op, input] of [
    ['session.cwd', {}], ['fs.read', { path: 'x' }], ['fs.stat', { path: 'x' }],
    ['process.run', { argv: [process.execPath, '-e', ''] }],
  ] as const) {
    await expect(f.call(op, input, handle.agent)).rejects.toThrow('dsh-working-directory')
  }
  expect(await f.call('session.root', {}, handle.agent)).toBe(f.root)
  const argv = [process.execPath, '-e', 'process.stdout.write(process.cwd())']
  expect(await f.call('process.run', { argv, init: { cwd: f.root } }, handle.agent)).toEqual({ exitCode: 0, stdout: f.root, stderr: '' })
  expect(await f.call('process.run', { argv })).toEqual({ exitCode: 0, stdout: process.cwd(), stderr: '' })
  await writeFile(join(f.root, 'agentless.txt'), 'agentless')
  expect(await f.call('fs.read', { path: join(f.root, 'agentless.txt') })).toBe('agentless')
  await f.mountBridge()
  await expect(f.ctx.agents.create({ sessionId: SessionId('missing-start'), meta: { cwd: f.root } }))
    .rejects.toThrow('session.start needs dsh-working-directory')
})
