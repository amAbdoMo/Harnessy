/** Local MCP document contents through a real profile, Loader and credential provider. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import McpManagerController from '../src/mcp-manager.ts'

it('opens actual MCP values and imports local edits through the configured profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-document-loader-'))
  const ctx = new Context()
  const configurationPath = join(root, 'mcp-servers.json')
  let openedText = ''
  class FixtureMcpManager extends McpManagerController {
    constructor(context: Context) {
      super(context, { configurationPath, openTextFile: async (path) => { openedText = await readFile(path, 'utf8') } })
    }
  }
  try {
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['test-mcp-manager', FixtureMcpManager],
    ])
    const rows = [...modules.keys()].map(name => ({ name,
      ...name === '@deepseek-ai/dsh-credentials-local' ? { config: { path: join(root, '.credentials.yaml'), watch: false } } : {},
    }))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify(rows))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const internal: ModuleLoaderV2 = {
      version: 'v2', loadCache: new Map(),
      import: async (specifier) => {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    ctx.loader.internal = internal
    await profileComposition(ctx, root, configPath)
    await ctx.mcpManagerController.save({ name: 'Local fixture', serverName: 'local_fixture', transport: 'stdio',
      enabled: false, command: 'node', environment: { API_TOKEN: 'fixture-readable-value' } })
    await ctx.mcpManagerController.openConfigurationFile(new AbortController().signal)
    const document = JSON.parse(openedText) as { servers: Array<{ environment: Record<string, string> }> }
    expect(document.servers[0]?.environment.API_TOKEN).toBe('fixture-readable-value')
    document.servers[0]!.environment.API_TOKEN = 'fixture-edited-value'
    await writeFile(configurationPath, JSON.stringify(document))
    const state = await ctx.mcpManagerController.describe()
    expect(state.servers[0]?.environmentKeys).toEqual(['API_TOKEN'])
    expect(JSON.stringify(state)).not.toContain('fixture-edited-value')
    await ctx.mcpManagerController.openConfigurationFile(new AbortController().signal)
    expect((JSON.parse(openedText) as typeof document).servers[0]?.environment.API_TOKEN).toBe('fixture-edited-value')
  } finally {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})
