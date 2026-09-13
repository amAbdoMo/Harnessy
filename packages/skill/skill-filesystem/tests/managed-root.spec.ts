import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as SkillFileSystem from '../src/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

async function tempDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-managed-${label}-`))
  tempDirs.push(directory)
  return directory
}

async function writeSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nUse it.\n`)
}

async function waitForNames(ctx: Context, expected: readonly string[]): Promise<void> {
  const deadline = Date.now() + 3_000
  while (true) {
    const names = (await ctx.skills.list()).map(skill => skill.name)
    if (JSON.stringify(names) === JSON.stringify(expected)) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${expected.join(', ')}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('skill-filesystem managed root', () => {
  it('publishes the settings schema contract', () => {
    expect(SkillFileSystem.ManagedSkillRootSettingsSchema({ enabled: true, directory: 'C:\\Users\\me\\.agents\\skills' }))
      .toEqual({ enabled: true, directory: 'C:\\Users\\me\\.agents\\skills' })
    expect(() => SkillFileSystem.ManagedSkillRootSettingsSchema({ enabled: true, directory: '' })).toThrow()
  })

  it('switches and disables the selected root without restarting the host', async () => {
    const first = await tempDirectory('first')
    const second = await tempDirectory('second')
    await writeSkill(first, 'first-skill')
    await writeSkill(second, 'second-skill')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry).await()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin(SkillFileSystem, {
      providerName: 'managed-test',
      includeDefaultRoots: false,
      watch: false,
      managedRootSettingsNamespace: 'managed-test-skills',
      managedRootDirectory: first,
      managedRootEnabled: true,
    })
    await fiber.await()

    await waitForNames(ctx, ['first-skill'])
    await ctx.settings.update('managed-test-skills', { directory: second })
    await waitForNames(ctx, ['second-skill'])
    await ctx.settings.update('managed-test-skills', { enabled: false })
    await waitForNames(ctx, [])

    await fiber.dispose()
    expect(ctx.settings.describe().map(section => section.ns)).not.toContain('managed-test-skills')
  })

  it('requires an absolute default directory for a managed root', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry).await()
    await expect(ctx.plugin(SkillFileSystem, {
      providerName: 'invalid-managed-test',
      includeDefaultRoots: false,
      managedRootSettingsNamespace: 'invalid-managed-test',
      managedRootDirectory: 'relative/skills',
    })).rejects.toThrow('must be absolute')
  })
})
