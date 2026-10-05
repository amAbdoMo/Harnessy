/** Real Loader startup refuses MCP dispatch before the private website inventory is installed. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installWebsiteRequests, type WebsiteRequestsController } from '../src/website-requests.ts'

it('installs the deny guard before configured plugins can call an MCP, then disposes its registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-boot-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    '- name: cordis:fixture-probe', '',
  ].join('\n'))
  let controller: WebsiteRequestsController | undefined
  let duringBoot: ToolExecutionResult | undefined
  const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'ordinary result' }] }))
  const ctx = await boot('website-test', configPath, [], (owner) => {
    controller = installWebsiteRequests(owner, async () => ({ identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/' }),
      () => {}, async () => {})
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', Tools],
    ])
    owner.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error('Unexpected fixture module: ' + specifier)
        return modules.get(specifier)
      },
      register() { throw new Error('Unexpected fixture hook registration') },
      async getOrCreateModuleJob() { throw new Error('Unexpected fixture module job') },
      resolveSync() { throw new Error('Unexpected fixture module resolution') },
      async load() { throw new Error('Unexpected fixture module load') },
    }
    owner.loader.builtins['fixture-probe'] = {
      inject: ['tools'],
      async apply(inner: Context) {
        inner.effect(() => inner.tools.register(createMcpToolDefinition(inner, {
          name: 'mcp__ordinary__read', serverName: 'ordinary', rawName: 'read', description: 'Read an ordinary server.',
          inputSchema: { type: 'object' }, call: upstream,
        })))
        duringBoot = await inner.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('startup'),
          name: 'mcp__ordinary__read', arguments: {} })
      },
    }
  })
  onTestFinished(() => ctx.fiber.dispose())
  expect(duringBoot?.isError).toBe(true)
  expect(upstream).not.toHaveBeenCalled()
  if (controller === undefined) throw new Error('Website startup controller did not install')
  controller.syncProfiles([])
  expect(await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('ready'),
    name: 'mcp__ordinary__read', arguments: {} })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ordinary result' }] })
  expect(upstream).toHaveBeenCalledOnce()
  const tools = ctx.tools
  await ctx.fiber.dispose()
  expect(tools.get('mcp__ordinary__read')).toBeUndefined()
})
