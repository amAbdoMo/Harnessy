import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { Config as McpClientConfig, ConnectionHandle, ConnectionObserver } from '@deepseek-ai/dsh-mcp-client'
import McpManagerController from '../src/mcp-manager.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

interface StartedConnection {
  readonly config: McpClientConfig
  readonly observer: ConnectionObserver | undefined
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

async function boot() {
  const started: StartedConnection[] = []
  const startConnection = vi.fn((
    _ctx: Context,
    config: McpClientConfig,
    _policy: unknown,
    observer?: ConnectionObserver,
  ): ConnectionHandle => {
    const dispose = vi.fn(async () => {})
    started.push({ config, observer, dispose })
    queueMicrotask(() => { observer?.({ status: 'connected', tools: [`mcp__${config.serverName}__inspect`] }) })
    return { ready: Promise.resolve({}), dispose }
  })
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpManagerController, { startConnection })
  return { ctx, controller: ctx.mcpManagerController, started }
}

describe('the Harnessy MCP manager Remote namespace', () => {
  it('owns the expected methods and reports unavailable composition safely', async () => {
    const empty = new Context()
    await empty.plugin(McpManagerController)
    expect(await empty.mcpManagerController.describe()).toEqual({
      available: false, writable: false, servers: [],
    })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'save', 'setEnabled', 'reconnect', 'deleteServer',
    ])
  })

  it('stores remote authentication only in the protected vault and publishes redacted live state', async () => {
    const { ctx, controller, started } = await boot()
    const saved = await controller.save({
      name: 'WordPress',
      serverName: 'wordpress',
      transport: 'streamable-http',
      enabled: true,
      url: 'https://tools.example.com/mcp',
      headerName: 'Authorization',
      authorization: 'Bearer private-token',
    })
    await vi.waitFor(async () => {
      expect((await controller.describe()).servers[0]).toMatchObject({
        status: 'connected', tools: ['inspect'], authenticationConfigured: true,
      })
    })
    expect(started[0]?.config).toMatchObject({
      transport: 'streamable-http', headers: { Authorization: 'Bearer private-token' },
    })
    expect(JSON.stringify(saved)).not.toContain('private-token')
    started[0]?.observer?.({
      status: 'error', tools: [], error: 'request to https://tools.example.com/mcp failed: Bearer private-token',
    })
    const failed = await controller.describe()
    expect(failed.servers[0]?.error).toBe('Harnessy could not connect to this MCP server. Check its connection settings.')
    expect(JSON.stringify(failed)).not.toContain('private-token')
    const record = await ctx.credentials.readRecord(credentialKey('mcp-manager', 'servers'))
    expect(JSON.stringify(record)).toContain('private-token')
  })

  it('returns non-secret stdio fields for editing while keeping environment values protected', async () => {
    const { controller } = await boot()
    const state = await controller.save({
      name: 'Local tools', serverName: 'local', transport: 'stdio', enabled: false,
      command: 'node', args: ['server.mjs', '--quiet'], cwd: 'C:\\Tools',
      environment: { API_TOKEN: 'stdio-private-token' },
    })
    expect(state.servers[0]).toMatchObject({
      endpoint: 'node', args: ['server.mjs', '--quiet'], cwd: 'C:\\Tools',
      environmentKeys: ['API_TOKEN'], authenticationConfigured: true,
    })
    expect(JSON.stringify(state)).not.toContain('stdio-private-token')
  })

  it('retains a saved secret on blank edit, disables cleanly, and removes the profile', async () => {
    const { controller, started } = await boot()
    const initial = await controller.save({
      name: 'Site tools', serverName: 'site', transport: 'streamable-http', enabled: true,
      url: 'https://site.example/mcp', authorization: 'Bearer retained',
    })
    const id = initial.servers[0]!.id
    await controller.save({
      id, name: 'Site tools renamed', serverName: 'site', transport: 'streamable-http', enabled: true,
      url: 'https://site.example/mcp',
    })
    expect(started.at(-1)?.config).toMatchObject({ headers: { Authorization: 'Bearer retained' } })
    const disabled = await controller.setEnabled(id, false)
    expect(disabled.servers[0]?.status).toBe('disabled')
    expect(started.at(-1)?.dispose).toHaveBeenCalledOnce()
    expect((await controller.deleteServer(id)).servers).toEqual([])
  })

  it('rejects unsafe remote URLs and duplicate tool namespaces', async () => {
    const { controller } = await boot()
    const unsafe = await controller.save({
      name: 'Unsafe', serverName: 'unsafe', transport: 'streamable-http', enabled: false,
      url: 'http://example.com/mcp',
    }).catch((error: unknown) => error)
    expect(remoteErrorOf(unsafe)).toMatchObject({ code: 'mcp-manager/rejected' })
    await controller.save({
      name: 'First', serverName: 'shared', transport: 'streamable-http', enabled: false,
      url: 'https://first.example/mcp',
    })
    const duplicate = await controller.save({
      name: 'Second', serverName: 'shared', transport: 'stdio', enabled: false, command: 'npx',
    }).catch((error: unknown) => error)
    expect(remoteErrorOf(duplicate)).toMatchObject({ code: 'mcp-manager/rejected' })
  })
})
