/** Execution-directory consumers with a real Agent and Loader-owned service injections. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Lsp, { LspProviderId } from '@deepseek-ai/dsh-lsp'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'
import LocalFileReferences from '@deepseek-ai/dsh-file-reference-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'

it('uses committed directories for LSP, relative mentions, and skill loading without Agent injections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-current-consumers-'))
  const current = join(root, 'current')
  const ctx = new Context()
  try {
    await mkdir(join(current, '.dsh', 'skills', 'current-skill'), { recursive: true })
    await mkdir(join(current, '.git'))
    await writeFile(join(current, 'CURRENT.ts'), 'const current = true')
    await writeFile(join(current, '.dsh', 'skills', 'current-skill', 'SKILL.md'),
      '---\nname: current-skill\ndescription: Current project skill\n---\n\nCurrent instructions.\n')
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
      ['@deepseek-ai/dsh-lsp', Lsp],
      ['@deepseek-ai/dsh-tool-lsp', ToolLsp],
      ['@deepseek-ai/dsh-file-reference-local', LocalFileReferences],
      ['@deepseek-ai/dsh-skill', SkillRegistry],
      ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem],
      ['@deepseek-ai/dsh-tool-skill', ToolSkill],
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
    await ctx.loader.create({ name: 'cordis:include',
      config: { path: new URL('./fixtures/current-directory.yml', import.meta.url).href } })
    await ctx.loader.await()
    const queries: string[] = []
    ctx.lsp.registerProvider({
      id: LspProviderId('current-directory-fixture'), extensionToLanguage: { '.ts': 'typescript' },
      query(request) {
        queries.push(request.workspaceRoot)
        return Promise.resolve({ kind: 'hover', hover: { contents: 'Current hover.' } })
      },
    })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('current-consumer-loader'), {}, { cwd: root })
    expect(await ctx.fileReferences.list(agent, 'CURRENT', new AbortController().signal))
      .toEqual([{ path: 'current', kind: 'directory' }, { path: 'current/CURRENT.ts', kind: 'file' }])
    await ctx.workingDirectory.set(agent, current)
    const committed = ctx.workingDirectory.get(agent.session)
    await expect(ctx.systemPrompt.assemble({ agent })).resolves.toBeDefined()
    expect(await ctx.fileReferences.list(agent, 'CURRENT', new AbortController().signal))
      .toEqual([{ path: 'CURRENT.ts', kind: 'file' }])
    const execute = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ name, arguments: args, agent,
        signal: new AbortController().signal, callId: ToolCallId(`current-loader-${name}`) })
      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      return result
    }
    expect(await execute('lsp', { operation: 'hover', file_path: 'CURRENT.ts', line: 1, character: 7 }))
      .toMatchObject({ value: { kind: 'hover', hover: { contents: 'Current hover.' } } })
    expect(queries).toEqual([committed])
    expect(await execute('skill', { name: 'current-skill' }))
      .toMatchObject({ value: { name: 'current-skill', content: 'Current instructions.' } })
    expect(agent.session.header.cwd).toBe(root)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
