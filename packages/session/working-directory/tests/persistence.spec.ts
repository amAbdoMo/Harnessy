/** Directory replay validates stored selections without modifying the source artifact. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { describe, expect, it } from 'vitest'

async function fixture(selection: (root: string) => unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'directory-persistence-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, {})
    const storage = join(root, 'logs')
    await ctx.plugin(JsonlSessionPersistence, { root: storage, compression: 'none' })
    const header: SessionHeader = {
      id: SessionId('directory-replay'), version: SESSION_FORMAT_VERSION,
      createdAt: 1, delegationDepth: 0, isSeeded: false, cwd: root,
    }
    const bytes = `${JSON.stringify({ type: 'session', ...header })}\n${JSON.stringify({
      type: 'working-directory/change', seq: 0, time: 1, data: { cwd: selection(root) },
    })}\n`
    const path = generationLogPath(storage, root, header.id, SESSION_FORMAT_VERSION, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return {
      ctx, root, header, path, bytes,
      async restore() {
        const handle = await ctx.sessionPersistence.open(header.id, 'read')
        try {
          const read = await handle.read()
          return ctx.sessions.create(header.id, { meta: handle.header, seed: read.events })
        } finally { await handle.close() }
      },
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe('stored directory transitions', () => {
  it('reads the required directory event and leaves the original artifact unchanged', async () => {
    await using f = await fixture(root => join(root, 'recorded-selection'))
    const restored = await f.restore()
    expect(f.ctx.workingDirectory.get(restored)).toBe(join(f.root, 'recorded-selection'))
    expect(restored.header.cwd).toBe(f.root)
    expect(restored.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([
      expect.objectContaining({ type: 'working-directory/change', data: { cwd: join(f.root, 'recorded-selection') } }),
    ])
    expect(restored.snapshotEvents()[0]!.ignorable).not.toBe(true)
    expect(await readFile(f.path, 'utf8')).toBe(f.bytes)
  })

  it.each(['relative-selection', null, 5])('rejects an invalid stored directory %j without rewriting the log', async (selection) => {
    await using f = await fixture(() => selection)
    const restored = await f.restore()
    expect(() => f.ctx.workingDirectory.get(restored)).toThrow()
    expect(await readFile(f.path, 'utf8')).toBe(f.bytes)
  })
})
