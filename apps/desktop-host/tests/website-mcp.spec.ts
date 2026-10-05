/** Host-owned pairing identities reject unavailable registries and never disclose URL credentials. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { McpManagerState, McpServerView } from '@deepseek-ai/dsh-api-settings-controller/types'
import { afterEach, describe, expect, it } from 'vitest'
import { installWebsiteMcpInspector } from '../src/website-mcp.ts'

const contexts: Context[] = []
const SERVER: McpServerView = {
  id: 'portal-id', name: 'Portal', serverName: 'portal', transport: 'streamable-http', enabled: true,
  endpoint: 'https://operator:private@example.test/wp-json/mcp?token=hidden#secret', args: [], status: 'connected',
  tools: ['read'], authenticationConfigured: true, environmentKeys: [], updatedAt: 1,
}

class RegistryResponse extends Service {
  constructor(ctx: Context, private readonly response: () => Promise<McpManagerState>) {
    super(ctx, 'mcpManagerController')
  }

  describe(): Promise<McpManagerState> { return this.response() }
}

function fixture(describe: () => Promise<McpManagerState>) {
  const ctx = new Context()
  contexts.push(ctx)
  // Keep Cordis service tracing; supply only the registry response used by the inspector.
  new RegistryResponse(ctx, describe)
  return { ctx, inspect: installWebsiteMcpInspector(ctx, 'project-a') }
}

function state(server: McpServerView = SERVER): McpManagerState {
  return { available: true, writable: true, servers: [server] }
}

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('Desktop Host website MCP pairing', () => {
  it('returns a deterministic project-bound identity with a credential-free endpoint', async () => {
    const { ctx, inspect } = fixture(async () => state())
    const binding = await inspect('portal')
    expect(binding.endpoint).toBe('https://example.test/wp-json/mcp')
    expect(binding.identity).toMatch(/^[a-f0-9]{64}$/)
    expect(await inspect('portal')).toEqual(binding)
    expect((await installWebsiteMcpInspector(ctx, 'project-b')('portal')).identity).not.toBe(binding.identity)
    await ctx.fiber.dispose()
    await expect(inspect('portal')).rejects.toThrow('Host is stopping')
  })

  it.each(['disabled', 'connecting', 'reconnecting', 'error'] as const)('refuses %s connections', async (status) => {
    const { inspect } = fixture(async () => state({ ...SERVER, status, enabled: status !== 'disabled' }))
    await expect(inspect('portal')).rejects.toThrow('enabled, connected MCP server')
  })

  it('requires an exact namespace and an available registry', async () => {
    const { inspect } = fixture(async () => state())
    await expect(inspect('other')).rejects.toThrow('enabled, connected MCP server')
    const ctx = new Context()
    contexts.push(ctx)
    await expect(installWebsiteMcpInspector(ctx, 'project-a')('portal')).rejects.toThrow('requires the MCP registry')
  })

  it('invalidates the identity when server configuration changes', async () => {
    let server = SERVER
    const { inspect } = fixture(async () => state(server))
    const before = await inspect('portal')
    server = { ...SERVER, endpoint: 'https://other.example.test/mcp', updatedAt: 2 }
    expect((await inspect('portal')).identity).not.toBe(before.identity)
  })

  it('refuses a response from a registry replaced during inspection', async () => {
    let finish!: (value: McpManagerState) => void
    const { ctx, inspect } = fixture(() => new Promise((resolve) => { finish = resolve }))
    const pending = inspect('portal')
    const rejected = expect(pending).rejects.toThrow('registry changed during inspection')
    ctx.reflect.set('mcpManagerController', { describe: async () => state() })
    finish(state())
    await rejected
  })

  it('refuses a response from a registry removed during inspection', async () => {
    let finish!: (value: McpManagerState) => void
    const { ctx, inspect } = fixture(() => new Promise((resolve) => { finish = resolve }))
    const pending = inspect('portal')
    const rejected = expect(pending).rejects.toThrow('registry changed during inspection')
    ctx.reflect.set('mcpManagerController', undefined)
    finish(state())
    await rejected
  })

  it('refuses a completed registry response when Host disposal has begun', async () => {
    let finish!: (value: McpManagerState) => void
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin((scope) => { new RegistryResponse(scope, () => new Promise((resolve) => { finish = resolve })) })
    const pending = installWebsiteMcpInspector(ctx, 'project-a')('portal')
    const rejected = expect(pending).rejects.toThrow('Host is stopping')
    finish(state())
    const disposal = ctx.fiber.dispose()
    await rejected
    await disposal
  })

  it('refuses an inspection that finishes after disposal', async () => {
    let finish!: (value: McpManagerState) => void
    const { ctx, inspect } = fixture(() => new Promise((resolve) => { finish = resolve }))
    const pending = inspect('portal')
    const rejected = expect(pending).rejects.toThrow('Host is stopping')
    await ctx.fiber.dispose()
    finish(state())
    await rejected
  })
})
