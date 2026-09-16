import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultWhenToUse } from '@deepseek-ai/dsh-subagent-roster'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { COMMAND_CODE_DELEGATION_NAMESPACE } from '../src/settings.ts'

const PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS = 60_000
const PRODUCTION_PROFILE_TEST_TIMEOUT_MS = PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS + 15_000

/** Settings namespace the unified roster owns, as a browser surface addresses it. */
const ROSTER_NAMESPACE = 'subagent-roster'

const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'commandcode.patch.yml')
const harnessyDriver = join(fixtureDir, 'harnessy-driver.ts')
const harnessyConfigPath = join(fixtureDir, 'harnessy-delegation.patch.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const customHarnessPatch = fileURLToPath(new URL(
  '../../../bundle/custom-harness/cordis.patch.yml',
  import.meta.url,
))

describe('Command Code delegation public Loader composition', () => {
  it('loads the plugin, registers both tools, and starts no Command Code process', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subagent-commandcode Loader composition',
      tempDirPrefix: 'dsh-subagent-commandcode-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
      env: {
        // No installed CLI is reachable, so a load-time probe could not
        // succeed silently — and no spawn may happen at all.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as {
      spawnsAtLoad: number
      spawnsAfterProbe: number
      health: { command: string; installed: boolean; authenticated: boolean }
      settings: {
        maxConcurrentRuns: number
        timeoutMs: number
        maxTurns: number
        lanes: Array<{ id: string; model: string; access: string }>
      }
      tools: Array<{ name: string; parameters: { properties: Record<string, unknown>; required?: string[] } }>
    }

    // Loading the plugin starts nothing; the probe is what a caller asks for.
    expect(report.spawnsAtLoad).toBe(0)

    // With no CLI on PATH the plugin reports that plainly and keeps no state.
    expect(report.health.installed).toBe(false)
    expect(report.health.authenticated).toBe(false)

    expect(report.settings.maxConcurrentRuns).toBe(2)
    expect(report.settings.timeoutMs).toBe(3_600_000)
    expect(report.settings.maxTurns).toBe(60)
    expect(report.settings.lanes.map(lane => lane.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])
    expect(report.settings.lanes.every(lane => lane.model === 'deepseek/deepseek-v4.1-flash')).toBe(true)

    expect(report.tools.map(tool => tool.name).sort())
      .toEqual(['commandcode_delegate', 'list_commandcode_lanes'])
    const delegate = report.tools.find(tool => tool.name === 'commandcode_delegate')
    expect(Object.keys(delegate?.parameters.properties ?? {}).sort())
      .toEqual(['lane', 'run_in_background', 'task'])
    expect(delegate?.parameters.required?.sort()).toEqual(['lane', 'task'])
    const lanes = report.tools.find(tool => tool.name === 'list_commandcode_lanes')
    expect(Object.keys(lanes?.parameters.properties ?? {})).toEqual([])
  }, PRODUCTION_PROFILE_TEST_TIMEOUT_MS)

  it('mounts both delegation rows and carries the stored lanes into the roster', async () => {
    // The section the retired Delegation page stored before the roster
    // existed, written under the namespace owner's own constant.
    const storedLanes = {
      maxConcurrentRuns: 3,
      lanes: [
        {
          id: 'code',
          name: 'Code',
          purpose: 'Implement a change.',
          model: 'deepseek/deepseek-v4.1-flash',
          effort: 'high',
          access: 'full-access',
        },
        {
          id: 'review',
          name: 'Review',
          purpose: 'Review a change.',
          model: 'deepseek/deepseek-v4.1-flash',
          effort: 'default',
          access: 'read-only',
          enabled: false,
        },
      ],
      projects: { '/work': { lanes: { code: { name: 'Code (work)' } } } },
    }
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'Harnessy delegation Loader composition',
      tempDirPrefix: 'dsh-harnessy-delegation-loader-',
      binScript: harnessyDriver,
      libBinScript: harnessyDriver,
      configPath: harnessyConfigPath,
      binArgs: [harnessyConfigPath],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
      env: {
        // No installed CLI is reachable, so no spawn may happen at all.
        PATH: '',
      },
      prepare: async (cwd) => {
        await mkdir(join(cwd, '.dsh'), { recursive: true })
        await writeFile(
          join(cwd, '.dsh', 'settings.yaml'),
          JSON.stringify({ [COMMAND_CODE_DELEGATION_NAMESPACE]: storedLanes }),
          'utf8',
        )
      },
      inspect: async (cwd) => {
        // The migration's write reached storage beside the section it read.
        const persisted = await readFile(join(cwd, '.dsh', 'settings.yaml'), 'utf8')
        expect(persisted).toContain(ROSTER_NAMESPACE)
        expect(persisted).toContain(COMMAND_CODE_DELEGATION_NAMESPACE)
        expect(persisted).toContain('Code (work)')
      },
    })

    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as {
      spawnsAtLoad: number
      tools: string[]
      providers: string[]
      roster: unknown
      legacy: unknown
    }

    // Both rows load without starting any Command Code process.
    expect(report.spawnsAtLoad).toBe(0)
    expect(report.tools).toEqual([
      'commandcode_delegate',
      'delegate',
      'list_commandcode_lanes',
      'list_subagents',
    ])

    // The row registers its backend beside the profile's own, so a migrated
    // role's `backend: 'commandcode'` resolves in the shipped composition.
    expect(report.providers).toContain('commandcode')

    // The roster carries the stored lanes, their bounds, and their overrides.
    expect(report.roster).toEqual({
      subagents: [
        {
          id: 'code',
          name: 'Code',
          enabled: true,
          purpose: 'Implement a change.',
          whenToUse: defaultWhenToUse('code'),
          invocation: 'automatic',
          model: {
            mode: 'fixed',
            route: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
          },
          access: 'danger-full-access',
          instructions: '',
          execution: { backend: 'commandcode', background: 'auto' },
        },
        {
          id: 'review',
          name: 'Review',
          enabled: false,
          purpose: 'Review a change.',
          whenToUse: defaultWhenToUse('review'),
          invocation: 'automatic',
          model: { mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
          access: 'read-only',
          instructions: '',
          execution: { backend: 'commandcode', background: 'auto' },
        },
      ],
      overrides: { '/work': { subagents: { code: { name: 'Code (work)' } } } },
      // No selection namespace is mounted here, so the shipped authority stands.
      automaticRouting: { enabled: false, allowedModels: [] },
      limits: { maxConcurrentRuns: 3, defaultTimeoutMs: 3_600_000 },
    })

    // The section the migration read is exactly the one it was handed.
    expect(report.legacy).toEqual(storedLanes)
  }, PRODUCTION_PROFILE_TEST_TIMEOUT_MS)

  it('is mounted by the Harnessy product patch layer and by nothing else', () => {
    const patch = readFileSync(customHarnessPatch, 'utf8')
    expect(patch).toContain("name: '@deepseek-ai/dsh-subagent-commandcode'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-subagent-roster'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-client-ui-settings-subagents'")

    const bundles = [
      'acp-app',
      'base',
      'headless',
      'sdk-app',
      'sdk-minimal',
      'web-app',
    ]
    for (const bundle of bundles) {
      const other = fileURLToPath(new URL(
        `../../../bundle/${bundle}/cordis.patch.yml`,
        import.meta.url,
      ))
      expect(readFileSync(other, 'utf8')).not.toContain('dsh-subagent-commandcode')
    }
  })
})
