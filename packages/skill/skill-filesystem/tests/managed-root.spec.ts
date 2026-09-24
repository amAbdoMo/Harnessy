import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

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

  it('loads and disables the selected root across live plugin configurations', async () => {
    const first = await tempDirectory('first')
    const second = await tempDirectory('second')
    await writeSkill(first, 'first-skill')
    await writeSkill(second, 'second-skill')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry).await()
    const firstFiber = ctx.plugin(SkillFileSystem, {
      providerName: 'managed-test',
      includeDefaultRoots: false,
      watch: false,
      directory: first,
      enabled: true,
    })
    await firstFiber.await()

    await waitForNames(ctx, ['first-skill'])
    await firstFiber.dispose()
    const secondFiber = ctx.plugin(SkillFileSystem, {
      providerName: 'managed-test',
      includeDefaultRoots: false,
      watch: false,
      directory: second,
      enabled: true,
    })
    await secondFiber.await()
    await waitForNames(ctx, ['second-skill'])
    await secondFiber.dispose()
    const disabledFiber = ctx.plugin(SkillFileSystem, {
      providerName: 'managed-test',
      includeDefaultRoots: false,
      watch: false,
      directory: second,
      enabled: false,
    })
    await disabledFiber.await()
    await waitForNames(ctx, [])

    await disabledFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('requires an absolute default directory for a managed root', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry).await()
    await expect(ctx.plugin(SkillFileSystem, {
      providerName: 'invalid-managed-test',
      includeDefaultRoots: false,
      directory: 'relative/skills',
    })).rejects.toThrow('must be absolute')
    await ctx.fiber.dispose()
  })
})
