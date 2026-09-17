import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PROCESS_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 15_000

const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'capabilities-driver.ts')
const configPath = join(fixtureDir, 'harnessy-capabilities.patch.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const shippedPatch = fileURLToPath(new URL('../../../bundle/custom-harness/cordis.patch.yml', import.meta.url))

/** One command's run, as the driver reported it. */
interface CommandRun {
  readonly options: { modelsSync?: string; modelsExplain?: string; modelsRefresh?: boolean }
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** One model's provenance as the Models page's Remote read answers it. */
interface DriverCapability {
  readonly route: string
  readonly model: string
  readonly enabled: boolean
  readonly match: string
  readonly origin?: string
  readonly levels?: readonly string[]
}

/** The driver's whole report. */
interface DriverReport {
  readonly registrations: string[]
  readonly typert: boolean
  readonly capabilities: DriverCapability[]
  readonly runs: CommandRun[]
  readonly exports: number[]
  readonly settings: string
}

/**
 * Boot the shipped Harnessy composition rows and run one driver scenario.
 * @param args - the driver's own scenario flags.
 * @returns the parsed report and the process streams.
 */
async function boot(args: readonly string[]): Promise<{ report: DriverReport; stderr: string }> {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'model-capabilities Loader composition',
    tempDirPrefix: 'dsh-model-capabilities-composition-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    binArgs: [configPath, ...args],
    tsconfigPath: repoTsconfig,
    processTimeoutMs: PROCESS_TIMEOUT_MS,
    env: {
      // No public endpoint may be reachable, and the free policy this run
      // configures is `manual`, so nothing in these scenarios may fetch.
      // A fetch that happened anyway would be a test failure, not a slow pass.
      PATH: '',
    },
  })
  return { report: JSON.parse(stdout) as DriverReport, stderr }
}

describe('the shipped Harnessy composition', () => {
  it('mounts public metadata after the local capability integration, and nowhere else', () => {
    const patch = readFileSync(shippedPatch, 'utf8')
    const commandCode = patch.indexOf("name: '@deepseek-ai/dsh-subagent-commandcode'")
    const plugin = patch.indexOf("name: '@deepseek-ai/dsh-model-capabilities/plugin'")
    const cli = patch.indexOf("name: '@deepseek-ai/dsh-model-capabilities/cli'")
    expect(commandCode).toBeGreaterThan(-1)
    expect(plugin).toBeGreaterThan(commandCode)
    expect(cli).toBeGreaterThan(plugin)
    // The Loader mounts sibling rows in parallel, so position alone orders
    // nothing: the row declares the local integration as an injected service,
    // and that dependency is what makes Command Code's source register first.
    expect(patch).toMatch(/dsh-model-capabilities\/plugin'\n\s+inject: \[commandCodeController\]/)

    // The boot fixture mirrors the shipped rows; it drifts only if this fails.
    const fixture = readFileSync(configPath, 'utf8')
    for (const rows of [patch, fixture]) {
      expect(rows).toContain("name: '@deepseek-ai/dsh-subagent-commandcode'")
      expect(rows).toMatch(/dsh-model-capabilities\/plugin'\n\s+inject: \[commandCodeController\]/)
      expect(rows).toMatch(/dsh-model-capabilities\/cli'\n\s+inject: \[modelCapabilities\]/)
      // The row mounts behind a subpath entry, so the Typert loader needs the
      // package named explicitly to find its `./typert` manifest.
      expect(rows).toContain("config:\n    packages:\n      - '@deepseek-ai/dsh-model-capabilities'")
    }

    const packages = JSON.parse(readFileSync(fileURLToPath(new URL(
      '../../../bundle/custom-harness/package.json',
      import.meta.url,
    )), 'utf8')) as { dependencies: Record<string, string> }
    expect(packages.dependencies['@deepseek-ai/dsh-model-capabilities']).toBeDefined()

    for (const bundle of ['acp-app', 'base', 'headless', 'sdk-app', 'sdk-minimal', 'web-app']) {
      const other = fileURLToPath(new URL(`../../../bundle/${bundle}/cordis.patch.yml`, import.meta.url))
      expect(readFileSync(other, 'utf8')).not.toContain('dsh-model-capabilities')
    }
  })

  it('registers the public source after Command Code and reports every configured model', async () => {
    const { report, stderr } = await boot(['--models-sync=check'])
    expect(stderr).toBe('')

    // The local integration's source is in the chain ahead of public metadata,
    // which is what keeps its declarations authoritative.
    expect(report.registrations).toEqual(['commandcode', 'public-metadata'])

    const [check, write, secondWrite, after] = report.runs as [CommandRun, CommandRun, CommandRun, CommandRun]
    expect(check.code).toBe(0)
    expect(check.stderr).toBe('')

    // A local declaration is kept, a provider-host match is written, an
    // id-only id is reported as an ambiguous suggestion, and a model no public
    // database states stays unresolved.
    expect(check.stdout).toContain('commandcode / z-ai/glm-5.3-flash')
    expect(check.stdout).toContain('current:       low, high, max')
    expect(check.stdout).toContain('action:        kept (already declared)')
    expect(check.stdout).toContain('cortex / gpt-5.6-sol')
    expect(check.stdout).toMatch(/cortex \/ gpt-5\.6-sol[\s\S]*match:\s+provider-host/)
    expect(check.stdout).toContain('origin:        bundled')
    expect(check.stdout).toContain('authoritative: yes')
    expect(check.stdout).toContain('action:        would write')
    expect(check.stdout).toMatch(/openai-codex \/ gpt-6-astra[\s\S]*match:\s+model-id-ambiguous/)
    expect(check.stdout).toContain('authoritative: no')
    expect(check.stdout).toContain('action:        not written (suggestion only)')
    expect(check.stdout).toMatch(/openrouter-live \/ stealth\/union-alpha[\s\S]*action:\s+unresolved/)

    // `write` persisted only the provider-aware row and left every other
    // declaration exactly as it stood.
    expect(write.code).toBe(0)
    expect(write.stdout).toContain('action:        written')
    expect(write.stdout).toContain('1 declaration(s) written')
    expect(report.settings).toContain('gpt-5.6-sol')
    expect(report.settings).toContain('low: low')
    expect(report.settings).toContain('medium: medium')
    expect(report.settings).toContain('high: high')
    expect(report.settings).toContain('max: max')
    expect(report.settings).toContain('GPT-6 Astra')
    expect(report.settings).toContain('Union Alpha')

    // A second write is a no-op, and the check that follows agrees.
    expect(secondWrite.stdout).toContain('0 declaration(s) written')
    expect(after.stdout).toContain('cortex / gpt-5.6-sol')
    expect(after.stdout).toContain('current:       low, medium, high')
    expect(after.stdout).toContain('action:        kept (already declared)')
    expect(after.stdout).toMatch(/openai-codex \/ gpt-6-astra[\s\S]*action:\s+not written \(suggestion only\)/)
  }, TEST_TIMEOUT_MS)

  it('answers the Models page read from the resolution chain the runtime serves', async () => {
    const { report, stderr } = await boot(['--models-explain=cortex/gpt-5.6-sol'])
    expect(stderr).toBe('')
    // The Host descriptor exists, so the Client's `modelCapabilities/inspect`
    // call has something to dispatch through.
    expect(report.typert).toBe(true)
    // Every configured model is reported in configuration order with the state
    // its row renders: a provider-host match, an ambiguity, and a model no
    // catalog states at all. This is the payload the Models page reads.
    expect(report.capabilities).toEqual([
      { route: 'commandcode', model: 'z-ai/glm-5.3-flash', enabled: true, match: 'model-id-ambiguous' },
      { route: 'cortex', model: 'gpt-5.6-sol', enabled: true, match: 'provider-host', origin: 'bundled', levels: ['low', 'medium', 'high'] },
      { route: 'openai-codex', model: 'gpt-6-astra', enabled: true, match: 'model-id-ambiguous' },
      { route: 'openrouter-live', model: 'stealth/union-alpha', enabled: true, match: 'unresolved' },
    ])
  }, TEST_TIMEOUT_MS)

  it('explains a route-qualified model through the real resolution chain', async () => {
    const { report, stderr } = await boot(['--models-explain=cortex/gpt-5.6-sol'])
    expect(stderr).toBe('')
    const [run] = report.runs as [CommandRun]
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Model:')
    expect(run.stdout).toContain('route: cortex')
    expect(run.stdout).toContain('id: gpt-5.6-sol')
    expect(run.stdout).toContain('Resolution:')
    expect(run.stdout).toContain('live:')
    expect(run.stdout).toContain('no catalog loaded')
    expect(run.stdout).toContain('cache:')
    expect(run.stdout).toContain('bundled:')
    expect(run.stdout).toContain('cortecs')
    expect(run.stdout).toContain('match: provider-host')
    expect(run.stdout).toContain('efforts: low, medium, high')
    expect(run.stdout).toContain('Final:')
    expect(run.stdout).toContain('low, medium, high')
  }, TEST_TIMEOUT_MS)

  it('explains an id-only ambiguity without declaring it', async () => {
    const { report, stderr } = await boot(['--models-explain=openai-codex/gpt-6-astra'])
    expect(stderr).toBe('')
    const [run] = report.runs as [CommandRun]
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Final:')
    expect(run.stdout).toContain('undeclared')
    expect(run.stdout).toContain('Suggestions:')
    expect(run.stdout).toContain('models.dev /')
    expect(run.stdout).toContain('Reason:')
  }, TEST_TIMEOUT_MS)

  it('refuses an explicit refresh under "never" and reports a disabled layer', async () => {
    const never = await boot(['--models-never-refresh'])
    expect(never.stderr).toBe('')
    const [refused] = never.report.runs as [CommandRun]
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('refresh is "never"')
    expect(refused.stdout).toBe('')

    const disabled = await boot(['--models-disabled'])
    expect(disabled.stderr).toBe('')
    const [off] = disabled.report.runs as [CommandRun]
    expect(off.code).toBe(0)
    expect(off.stdout).toContain('public metadata is disabled')
    expect(off.stdout).not.toContain('action:')
  }, TEST_TIMEOUT_MS)
})
