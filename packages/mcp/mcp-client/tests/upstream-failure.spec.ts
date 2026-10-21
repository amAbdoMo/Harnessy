/** Proxy-reported upstream failure through real SDK negotiation and Loader composition. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { McpServer, type ServerCapabilities } from '@modelcontextprotocol/server'
import { z } from 'zod'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '../src/index.ts'
import { resolveReconnectPolicy, type ConnectionSnapshot } from '../src/connection.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

const proxyInstructions = 'MCP WordPress Remote Proxy Server (Connection Failed)'
const diagnostic = 'MCP proxy reported an upstream connection failure — check the upstream server connection and retry'
const signal = new AbortController().signal

function proxyServer(capabilities: ServerCapabilities, instructions = proxyInstructions) {
  // Use the proxy's legacy initialize path, not modern discovery-only negotiation.
  return new McpServer({ name: 'WordPress MCP Remote Proxy', version: '0.5.1' }, {
    supportedProtocolVersions: ['2025-11-25'], capabilities, instructions,
  })
}

async function fixture(createServer: () => McpServer) {
  const endpoint = await startHttpMcpFixture({ createServer })
  onTestFinished(() => endpoint.close())
  return endpoint
}

async function supervise(url: string, reconnect: McpClient.Config['reconnect'] = { enabled: false }) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpResources)
  const snapshots: ConnectionSnapshot[] = []
  const logs: string[] = []
  ctx.logger.warn = (message: unknown) => { logs.push(String(message)) }
  ctx.logger.error = (message: unknown) => { logs.push(String(message)) }
  const config: McpClient.Config = {
    transport: 'streamable-http', serverName: 'fixture', url, headers: {},
    toolCallTimeoutMs: 1000, failOnStartupError: false, reconnect,
  }
  const handle = McpClient.startManagedConnection(ctx, config, resolveReconnectPolicy(reconnect, 'fixture'), snapshot => snapshots.push(snapshot))
  onTestFinished(() => handle.dispose())
  const resource = () => ctx.tools.execute({
    name: 'list_mcp_resources', arguments: { server: 'fixture' },
    callId: ToolCallId('fixture-resources'), signal,
  })
  return { ctx, handle, snapshots, logs, resource }
}

async function load(url: string, strict: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-upstream-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-mcp-resources', McpResources],
    ['@deepseek-ai/dsh-mcp-client', McpClient],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register() { throw new Error('Unexpected module hook registration') },
    async getOrCreateModuleJob() { throw new Error('Unexpected module job request') },
    resolveSync() { throw new Error('Unexpected module resolution') },
    async load() { throw new Error('Unexpected module load') },
  }
  const configPath = join(root, 'cordis.yml')
  const yaml = await readFile(new URL('./fixtures/upstream-failure-composition.yml', import.meta.url), 'utf8')
  await writeFile(configPath, yaml.replace('__FIXTURE_URL__', url).replace('__STRICT__', String(strict)))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('proxy-reported upstream failure', () => {
  it.each([
    { marker: {}, instructions: proxyInstructions },
    { marker: { code: 'UPSTREAM_UNAVAILABLE' }, instructions: 'Ordinary proxy instructions.' },
    { marker: { code: 'fixture-untrusted-code\nBearer fixture-secret' }, instructions: proxyInstructions },
  ])('rejects a successful initialize carrying connectionFailed $marker before publishing tools or instructions', async ({ marker, instructions }) => {
    const endpoint = await fixture(() => proxyServer({ experimental: { connectionFailed: marker } }, instructions))
    const { ctx, handle, snapshots, logs, resource } = await supervise(endpoint.url)
    expect((await handle.ready).error).toBeInstanceOf(Error)
    expect(snapshots.some(snapshot => snapshot.status === 'connected')).toBe(false)
    expect(snapshots.at(-1)?.status).toBe('error')
    expect(snapshots.at(-1)?.tools).toEqual([])
    expect(snapshots.at(-1)?.error).toContain(diagnostic)
    expect(handle.instructions()).toBe('')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain(proxyInstructions)
    const denied = await resource()
    expect(denied.isError).toBe(true)
    if (denied.isError) expect(denied.error.message).toContain('server is disconnected')
    expect(JSON.stringify({ snapshots, logs })).not.toContain('fixture-secret')
  })

  it('keeps the failure cause during bounded retries and final exhaustion', async () => {
    const endpoint = await fixture(() => proxyServer({ experimental: { connectionFailed: {} } }))
    const { handle, snapshots } = await supervise(endpoint.url, { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 })
    await handle.ready
    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.status).toBe('error')
      expect(snapshots.at(-1)?.error).toContain('gave up after 2')
    })
    expect(snapshots.filter(snapshot => snapshot.status === 'reconnecting')).toEqual([
      { status: 'reconnecting', tools: [], error: diagnostic },
      { status: 'reconnecting', tools: [], error: diagnostic },
    ])
    expect(snapshots.at(-1)?.error).toContain(diagnostic)
    expect(snapshots.some(snapshot => snapshot.status === 'connected')).toBe(false)
  })

  it('clears the failure on successful retry and publishes callable real tools', async () => {
    let healthy = false
    const endpoint = await fixture(() => {
      if (!healthy) return proxyServer({ experimental: { connectionFailed: {} } })
      const server = proxyServer({}, 'Recovered fixture instructions.')
      server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
      return server
    })
    const { ctx, handle, snapshots } = await supervise(endpoint.url, { initialDelayMs: 50, maxDelayMs: 50, maxAttempts: 2 })
    await handle.ready
    expect(snapshots.at(-1)).toEqual({ status: 'reconnecting', tools: [], error: diagnostic })
    healthy = true
    await vi.waitFor(() => { expect(snapshots.at(-1)).toEqual({ status: 'connected', tools: ['mcp__fixture__ping'] }) })
    const reply = await ctx.tools.execute({ name: 'mcp__fixture__ping', arguments: {}, callId: ToolCallId('recovered-ping'), signal })
    expect(reply).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
    expect(handle.instructions()).toContain('Recovered fixture instructions.')
    await handle.dispose()
    expect(ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
    expect(handle.instructions()).toBe('')
    const settled = [...snapshots]
    await handle.dispose()
    expect(snapshots).toEqual(settled)
  })

  it.each(['empty tools', 'resource-only'] as const)('accepts a legitimate %s server with unrelated experimental extensions and failure-like instructions', async (kind) => {
    let listings = 0
    const endpoint = await fixture(() => {
      const server = proxyServer({ experimental: { unrelated: { connectionFailed: {} } }, ...kind === 'empty tools' ? { tools: {} } : {} })
      if (kind === 'empty tools') server.server.setRequestHandler('tools/list', async () => { listings++; return { tools: [] } })
      else server.registerResource('memo', 'memo://fixture', {}, async () => ({ contents: [{ uri: 'memo://fixture', text: 'memo' }] }))
      return server
    })
    const { handle, snapshots, resource } = await supervise(endpoint.url)
    expect(await handle.ready).toEqual({})
    expect(snapshots.at(-1)).toEqual({ status: 'connected', tools: [] })
    expect(handle.instructions()).toContain(proxyInstructions)
    expect(listings).toBe(kind === 'empty tools' ? 1 : 0)
    if (kind === 'resource-only') expect(await resource()).toMatchObject({ isError: false, value: { resources: [{ uri: 'memo://fixture' }] } })
  })

  it.each([false, true])('loads the real MCP plugin with strict startup %s and snapshots guarded model output', async (strict) => {
    const endpoint = await fixture(() => proxyServer({ experimental: { connectionFailed: {} } }))
    const ctx = await load(endpoint.url, strict)
    const mcp = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client')
    expect(mcp).toBeDefined()
    expect(mcp?.fiber?.state).toBe(strict ? FiberState.FAILED : FiberState.ACTIVE)
    const resource = await ctx.tools.execute({
      name: 'list_mcp_resources', arguments: { server: 'fixture' }, callId: ToolCallId('loader-resources'), signal,
    })
    expect(resource.isError).toBe(true)
    const output = {
      startup: mcp?.fiber?.state === FiberState.FAILED ? 'failed' : 'active',
      remoteTools: ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('mcp__')),
      prompt: renderPrompt(await ctx.systemPrompt.assemble()),
      resourceError: resource.isError ? resource.error.message : null,
    }
    await expect(JSON.stringify(output, null, 2) + '\n').toMatchFileSnapshot(`./expected/upstream-failure-${strict ? 'strict' : 'nonfatal'}.json`)
  })
})
