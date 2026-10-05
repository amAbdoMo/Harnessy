/** Resolves saved website pairings against the current Host's protected MCP registry. */
import { createHash } from 'node:crypto'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-settings-controller'

/** Non-secret endpoint information and an opaque configuration identity for Electron main. */
export interface WebsiteMcpBinding {
  readonly identity: string
  readonly endpoint: string
}

/**
 * @param ctx - current Host application context.
 * @param projectDir - project identity; saved authentication cannot silently cross projects.
 * @returns an inspector that rejects unavailable connections, inactive Hosts, and registry changes during inspection.
 */
export function installWebsiteMcpInspector(ctx: Context, projectDir: string): (serverName: string) => Promise<WebsiteMcpBinding> {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  function requireHost(): void {
    if (stopped || ctx.fiber.state !== FiberState.ACTIVE) throw new Error('Website MCP Host is stopping')
  }
  return async (serverName) => {
    requireHost()
    const manager = ctx.get('mcpManagerController')
    if (manager === undefined) throw new Error('Website pairing requires the MCP registry')
    // Cordis creates a fresh tracing proxy on each lookup; compare the providing instance.
    const provider: unknown = Reflect.get(manager, symbols.original) ?? manager
    const state = await manager.describe()
    requireHost()
    const current = ctx.get('mcpManagerController')
    if (current === undefined || (Reflect.get(current, symbols.original) ?? current) !== provider) {
      throw new Error('Website MCP registry changed during inspection')
    }
    const server = state.servers.find(candidate => candidate.serverName === serverName)
    if (server === undefined || !server.enabled || server.status !== 'connected') {
      throw new Error('Website pairing requires an enabled, connected MCP server')
    }
    let endpoint = server.endpoint
    if (server.transport === 'streamable-http') {
      const address = new URL(endpoint)
      address.username = ''
      address.password = ''
      address.search = ''
      address.hash = ''
      endpoint = address.href
    }
    return {
      identity: createHash('sha256').update(JSON.stringify({ projectDir, id: server.id,
        serverName: server.serverName, transport: server.transport, endpoint: server.endpoint,
        args: server.args, cwd: server.cwd, updatedAt: server.updatedAt })).digest('hex'),
      endpoint,
    }
  }
}
