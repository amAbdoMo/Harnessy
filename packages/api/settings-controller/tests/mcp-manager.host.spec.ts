import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
  temporaryDirectories.push(directory)
  const configurationPath = join(directory, 'mcp-servers.json')
  const openTextFile = vi.fn(async () => {})
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(McpManagerController, { startConnection, configurationPath, openTextFile })
  return { ctx, controller: ctx.mcpManagerController, started, configurationPath, openTextFile }
}

describe('the Harnessy MCP manager Remote namespace', () => {
  it('owns the expected methods and reports unavailable composition safely', async () => {
    const empty = new Context()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-empty-'))
    temporaryDirectories.push(directory)
    await empty.plugin(McpManagerController, { configurationPath: join(directory, 'mcp-servers.json') })
    expect(await empty.mcpManagerController.describe()).toEqual({
      available: false, writable: false, servers: [],
    })
    const { controller } = await boot()
    expect(remoteMethods(controller).map(method => method.method)).toEqual([
      'describe', 'openConfigurationFile', 'save', 'setEnabled', 'reconnect', 'deleteServer',
    ])
  })

  it('opens one dedicated MCP document and applies later file edits', async () => {
    const { controller, configurationPath, openTextFile } = await boot()
    const initial = await controller.save({
      name: 'Local tools', serverName: 'local', transport: 'stdio', enabled: false,
      command: 'node', args: ['server.mjs'], cwd: '', environment: { API_TOKEN: 'private' },
    })
    const signal = new AbortController().signal
    await expect(controller.openConfigurationFile(signal)).resolves.toEqual({ opened: true })
    expect(openTextFile).toHaveBeenCalledWith(configurationPath, signal)
    const document = JSON.parse(await readFile(configurationPath, 'utf8')) as {
      servers: Array<{ name: string }>
    }
    document.servers[0]!.name = 'Edited tools'
    await writeFile(configurationPath, `${JSON.stringify(document, null, 2)}\n`)
    await expect(controller.describe()).resolves.toMatchObject({
      servers: [{ id: initial.servers[0]!.id, name: 'Edited tools' }],
    })
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
