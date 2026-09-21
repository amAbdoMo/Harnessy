import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SettingsProvider,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_WORKSPACE_SETTINGS_NAMESPACE } from '../src/types.ts'
import {
  SessionWorkspaceDirectory,
  validateSessionWorkspaceSettings,
} from '../src/workspace-settings.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(_namespace: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Session workspace directory', () => {
  it('keeps the Host default until remote mode is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const directory = new SessionWorkspaceDirectory(ctx, '/host-default')

    await expect(directory.resolve(SessionId('default'))).resolves.toBe('/host-default')
    await ctx.fiber.dispose()
  })

  it('creates one isolated folder for each remote Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harnessy-session-workspace-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const directory = new SessionWorkspaceDirectory(ctx, '/host-default')
    await vi.waitFor(() => {
      expect(ctx.settings.describe().some(entry => entry.ns === SESSION_WORKSPACE_SETTINGS_NAMESPACE)).toBe(true)
    })
    await ctx.settings.update(SESSION_WORKSPACE_SETTINGS_NAMESPACE, {
      mode: 'remote-website', remoteRoot: root,
    })

    const first = await directory.resolve(SessionId('first'))
    const second = await directory.resolve(SessionId('second'))

    expect(dirname(first)).toBe(root)
    expect(basename(first)).toMatch(/^Harnessy Remote Work - [0-9a-f]{12}$/)
    expect((await stat(first)).isDirectory()).toBe(true)
    expect(second).not.toBe(first)
    await ctx.fiber.dispose()
  })

  it('rejects remote mode without an absolute parent folder', () => {
    expect(() => {
      validateSessionWorkspaceSettings({ mode: 'remote-website', remoteRoot: 'Desktop' })
    }).toThrow(/absolute temporary work folder/)
  })
})
