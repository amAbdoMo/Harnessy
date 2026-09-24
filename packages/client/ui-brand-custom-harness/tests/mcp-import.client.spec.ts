import { describe, expect, it } from 'vitest'
import { parseMcpJson } from '../src/client/mcp-import.ts'

describe('MCP JSON import', () => {
  it('imports OpenCode argv commands, protected environment, enabled state, and unique namespaces', () => {
    const result = parseMcpJson(JSON.stringify({
      mcp: {
        'WordPress tools': {
          type: 'local',
          command: ['npx', '-y', '@automattic/mcp-wordpress-remote@latest'],
          environment: { WP_API_URL: 'https://example.com/mcp', OAUTH_ENABLED: false, IGNORED: { nested: true } },
          enabled: false,
          timeout: 30_000,
        },
      },
    }), ['wordpress_tools'])

    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]?.input).toEqual({
      name: 'WordPress tools',
      serverName: 'wordpress_tools_2',
      transport: 'stdio',
      enabled: false,
      command: 'npx',
      args: ['-y', '@automattic/mcp-wordpress-remote@latest'],
      cwd: '',
      environment: { WP_API_URL: 'https://example.com/mcp', OAUTH_ENABLED: 'false' },
    })
    expect(result.servers[0]?.protectedValueCount).toBe(2)
    expect(result.ignoredTimeoutCount).toBe(1)
  })

  it('imports Claude-style local servers and VS Code-style remote servers', () => {
    const local = parseMcpJson(JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { ROOT: 'C:\\Work' } },
      },
    }))
    expect(local.servers[0]?.input).toMatchObject({
      serverName: 'filesystem', transport: 'stdio', command: 'npx',
    })

    const remote = parseMcpJson(JSON.stringify({
      servers: {
        hosted: {
          type: 'http',
          url: 'https://tools.example/mcp',
          headers: { Authorization: 'Bearer secret', 'X-Extra': 'not-imported' },
        },
      },
    }))
    expect(remote.servers[0]?.input).toEqual({
      name: 'hosted',
      serverName: 'hosted',
      transport: 'streamable-http',
      enabled: true,
      url: 'https://tools.example/mcp',
      headerName: 'Authorization',
      authorization: 'Bearer secret',
    })
    expect(remote.ignoredHeaderCount).toBe(1)
  })

  it('skips unsupported entries and respects remaining protected-storage capacity', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        legacy: { type: 'sse', url: 'https://tools.example/sse' },
        valid: { command: 'node', args: ['server.js'] },
        overflow: { command: 'node', args: ['other.js'] },
      },
    }), [], 1)

    expect(result.servers.map(server => server.sourceName)).toEqual(['valid'])
    expect(result.skippedNames).toEqual(['legacy'])
    expect(result.capacitySkippedCount).toBe(1)
  })

  it('rejects files without an object server map', () => {
    expect(() => parseMcpJson('[]')).toThrow('invalid-root')
    expect(() => parseMcpJson('{"mcpServers": null}')).toThrow('missing-server-map')
  })
})
