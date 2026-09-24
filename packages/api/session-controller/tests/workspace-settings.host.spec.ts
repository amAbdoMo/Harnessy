import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionWorkspaceDirectory,
  validateSessionWorkspaceSettings,
} from '../src/workspace-settings.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Session workspace directory', () => {
  it('keeps the Host default until remote mode is configured', async () => {
    const directory = new SessionWorkspaceDirectory(
      () => ({ mode: 'harnessy-default', remoteRoot: '' }), '/host-default',
    )

    await expect(directory.resolve(SessionId('default'))).resolves.toBe('/host-default')
  })

  it('creates one isolated folder for each remote Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harnessy-session-workspace-'))
    temporaryRoots.push(root)
    const directory = new SessionWorkspaceDirectory(
      () => ({ mode: 'remote-website', remoteRoot: root }), '/host-default',
    )

    const first = await directory.resolve(SessionId('first'))
    const second = await directory.resolve(SessionId('second'))

    expect(dirname(first)).toBe(root)
    expect(basename(first)).toMatch(/^Harnessy Remote Work - [0-9a-f]{12}$/)
    expect((await stat(first)).isDirectory()).toBe(true)
    expect(second).not.toBe(first)
  })

  it('rejects remote mode without an absolute parent folder', () => {
    expect(() => {
      validateSessionWorkspaceSettings({ mode: 'remote-website', remoteRoot: 'Desktop' })
    }).toThrow(/absolute temporary work folder/)
  })
})
