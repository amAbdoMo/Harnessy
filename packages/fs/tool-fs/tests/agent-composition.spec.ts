/** Filesystem and discovery tools called by a real Agent in a Loader composition. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as DirectoryTool from '@deepseek-ai/dsh-tool-working-directory'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as Search from '@deepseek-ai/dsh-tool-fs-search'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'

it('executes file operations, discovery, and delivery without Agent service injections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-filesystem-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-fs-observation-policy', FsPolicy],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
      ['@deepseek-ai/dsh-tool-working-directory', DirectoryTool],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-tool-fs', ToolFs],
      ['@deepseek-ai/dsh-tool-fs-search', Search],
      ['@deepseek-ai/dsh-tool-present', Present],
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
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: new URL('./fixtures/agent-filesystem.yml', import.meta.url).href },
    })
    await ctx.loader.await()
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('filesystem-loader'), {}, { cwd: root })
    agent.session.append('turn/start', { turn: 1 })
    await writeFile(join(root, 'unread.txt'), 'protected')
    const denied = await ctx.tools.execute({
      name: 'edit', arguments: { file_path: 'unread.txt', old_string: 'protected', new_string: 'changed' },
      agent, signal: new AbortController().signal, callId: ToolCallId('unread-edit'),
    })
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'FS_NOT_OBSERVED' } } })
    expect(await readFile(join(root, 'unread.txt'), 'utf8')).toBe('protected')
    let sequence = 0
    const execute = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({
        name, arguments: args, agent, signal: new AbortController().signal,
        callId: ToolCallId(`filesystem-loader-${++sequence}`),
      })
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(text).not.toContain('without inject')
      expect(result.isError, text).toBe(false)
      return text
    }
    await mkdir(join(root, 'selected'))
    await execute('working_directory', { cd: 'selected' })
    await execute('write', { file_path: 'sample.txt', content: 'original' })
    expect(await execute('read', { file_path: 'sample.txt' })).toContain('original')
    await execute('edit', { file_path: 'sample.txt', old_string: 'original', new_string: 'updated' })
    expect(await execute('read', { file_path: 'sample.txt' })).toContain('updated')
    expect(await execute('glob', { pattern: '*.txt' })).toContain('sample.txt')
    expect(await execute('grep', { pattern: 'updated' })).toContain('sample.txt')
    await execute('present', { files: [{ path: 'sample.txt' }] })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
    expect(await readFile(join(root, 'selected', 'sample.txt'), 'utf8')).toBe('updated')
    expect(agent.session.header.cwd).toBe(root)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
