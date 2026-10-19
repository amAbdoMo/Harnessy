/** Workspace membership survives unavailable project directories without rewriting Session logs. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { expect, it, vi } from 'vitest'
import * as Workspace from '../src/index.ts'

async function load(configPath: string, contexts: Context[]): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    async import(specifier: string) {
      switch (specifier) {
        case '@deepseek-ai/dsh-session': return SessionStore
        case '@deepseek-ai/dsh-session-persistence-jsonl': return JsonlSessionPersistence
        case '@deepseek-ai/dsh-storage': return Storage
        case '@deepseek-ai/dsh-storage-json': return StorageJson
        case '@deepseek-ai/dsh-storage-domain': return StorageDomain
        case '@deepseek-ai/dsh-workspace': return Workspace
        default: throw new Error(`Unexpected Loader module: ${specifier}`)
      }
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.get('workspaceRegistry')).toBeDefined()
  return ctx
}

async function sessionFiles(root: string): Promise<Record<string, string>> {
  const paths = await readdir(root, { recursive: true, withFileTypes: true })
  const files: Record<string, string> = {}
  for (const entry of paths) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      files[path] = await readFile(path, 'utf8')
    }
  }
  return files
}

it('keeps title, archive and membership across Loader restarts, then recovers the original directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-membership-loader-')))
  const contexts: Context[] = []
  try {
    const project = join(root, 'project')
    const moved = join(root, 'moved-project')
    const logs = join(root, 'sessions')
    await mkdir(project)
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:', `    root: ${JSON.stringify(logs)}`, '    compression: none',
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:', `    root: ${JSON.stringify(join(root, 'storage'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'", '  config:', '    backend: json',
      "- name: '@deepseek-ai/dsh-workspace'", '',
    ].join('\n'))
    const first = await load(config, contexts)
    const workspace = await first.workspaceRegistry.create(project)
    for (const id of ['owned', 'unowned']) {
      const session = first.sessions.create(SessionId(id), { meta: { cwd: project } })
      const handle = await first.sessionPersistence.create(session.header)
      try {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await first.sessions.flush(session)
      } finally {
        await handle.close()
      }
    }
    await workspace.attachSession(SessionId('owned'))
    const historical = SessionId('historical')
    const historicalPath = generationLogPath(logs, project, historical, 3, 'none')
    await mkdir(dirname(historicalPath), { recursive: true })
    await writeFile(historicalPath, [
      JSON.stringify({ type: 'session', version: 3, id: historical, createdAt: 1,
        isSeeded: false, delegationDepth: 0, cwd: project }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
      '',
    ].join('\n'))
    await workspace.attachSession(historical)
    await first.fiber.dispose()
    const before = await sessionFiles(logs)
    expect(Object.keys(before)).toHaveLength(3)
    await rename(project, moved)

    const cold = await load(config, contexts)
    const open = vi.spyOn(cold.sessionPersistence, 'open')
    const restored = cold.workspaceRegistry.get(workspace.id)!
    expect(restored.sessionIds).toEqual(['historical', 'owned'])
    expect(restored.path).toBe(project)
    expect(await restored.status()).toBe('missing-dir')
    await restored.setTitle('Project unavailable')
    await cold.workspaceRegistry.archiveSession(SessionId('owned'))
    await expect(restored.attachSession(SessionId('unowned'))).rejects.toThrow(/does not resolve/)
    expect(open).not.toHaveBeenCalled()
    await cold.fiber.dispose()

    const again = await load(config, contexts)
    const recovered = again.workspaceRegistry.get(workspace.id)!
    expect(recovered.title).toBe('Project unavailable')
    expect(recovered.sessionIds).toEqual(['historical', 'owned'])
    expect(again.workspaceRegistry.archivedSessionIds).toEqual(['owned'])
    await again.workspaceRegistry.unarchiveSession(SessionId('owned'))
    await rename(moved, project)
    await recovered.attachSession(SessionId('unowned'))
    expect(recovered.path).toBe(project)
    expect(recovered.sessionIds).toEqual(['unowned', 'historical', 'owned'])
    expect(await recovered.status()).toBe('ok')
    expect((await again.sessionPersistence.list()).map(item => item.header.cwd)).toEqual([project, project, project])
    await again.fiber.dispose()
    expect(await sessionFiles(logs)).toEqual(before)
  } finally {
    try {
      await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
