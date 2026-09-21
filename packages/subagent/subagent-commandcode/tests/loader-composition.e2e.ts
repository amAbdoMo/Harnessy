import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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

/**
 * Write a real CLI the harness can resolve and start for this platform: an npm
 * `.cmd` shim on Windows, an executable launcher script elsewhere. The entry
 * records the environment and argv it was actually started with, then answers
 * the two probe helpers, so a test reads what the child process itself observed.
 * @param directory - directory placed on the booted composition's PATH.
 * @param evidencePath - absolute file the started CLI rewrites with its facts.
 */
function writeEvidenceCli(directory: string, evidencePath: string): void {
  const entry = join(directory, 'cli-entry.mjs')
  writeFileSync(entry, [
    "import { appendFileSync } from 'node:fs'",
    `const evidence = ${JSON.stringify(evidencePath)}`,
    'const args = process.argv.slice(2)',
    'appendFileSync(evidence, `${JSON.stringify({',
    '  skipUpdates: process.env.COMMANDCODE_SKIP_UPDATES ?? null,',
    '  args,',
    '})}\\n`)',
    "if (args.includes('--version')) process.stdout.write('1.54.0\\n')",
    "else if (args.includes('status')) process.stdout.write('Authenticated as loader-smoke\\n')",
    "else process.stdout.write('Available models\\n')",
  ].join('\n'), 'utf8')
  if (process.platform === 'win32') {
    // Mirror the shape `npm install -g` writes: the locator reads the quoted
    // JavaScript entry out of the shim and starts it with the current Node.
    writeFileSync(
      join(directory, 'cmdc.cmd'),
      [
        '@ECHO off',
        'SETLOCAL',
        'SET dp0=%~dp0',
        'IF EXIST "%dp0%\\node.exe" SET "_prog=%dp0%\\node.exe"',
        'IF NOT EXIST "%dp0%\\node.exe" SET "_prog=node"',
        '"%_prog%" "%dp0%\\cli-entry.mjs" %*',
        '',
      ].join('\r\n'),
      'utf8',
    )
    return
  }
  const launcher = join(directory, 'cmd')
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, 'utf8')
  chmodSync(launcher, 0o755)
}

/**
 * Put a directory first on the PATH entry the platform's environment already
 * uses: the locator reads `process.env.PATH`, and a second spelling of the same
 * name would leave the shim invisible to it.
 * @param directory - directory the started composition must resolve its CLI in.
 * @returns environment overrides preserving the parent PATH behind the shim.
 */
function pathFronting(directory: string): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const parent = process.env[key] ?? ''
  return { [key]: parent.length === 0 ? directory : `${directory}${delimiter}${parent}` }
}

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

  it('starts a real CLI process with the update kill switch on its environment', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'commandcode-live-cli-'))
    const evidence = join(binDir, 'evidence.json')
    writeEvidenceCli(binDir, evidence)
    try {
      const { stdout, stderr } = await runLoaderSmoke({
        label: 'subagent-commandcode live CLI environment',
        tempDirPrefix: 'dsh-subagent-commandcode-live-cli-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        binArgs: [configPath],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
        env: pathFronting(binDir),
      })

      expect(stderr).toBe('')
      const report = JSON.parse(stdout) as {
        spawnsAtLoad: number
        health: { command: string; installed: boolean; authenticated: boolean; version?: string }
      }
      // The probe resolved this shim through the real locator and started the
      // process underneath it rather than answering from a stub.
      expect(report.health).toMatchObject({ installed: true, authenticated: true, version: '1.54.0' })

      // What the started CLI itself observed. Its own background updater is what
      // produces the visible npm window: it spawns `npm i -g` detached, and
      // Windows gives a detached child its own console that `windowsHide` cannot
      // suppress. No harness-owned CLI process may reach that updater.
      const seen = readFileSync(evidence, 'utf8').trim().split('\n').map(line =>
        JSON.parse(line) as { skipUpdates: string | null; args: string[] })
      expect(seen.map(record => record.args[0])).toEqual(['--version', 'status'])
      expect(seen.every(record => record.skipUpdates === '1')).toBe(true)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
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
            route: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'high' },
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
          model: { mode: 'fixed', route: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } },
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
