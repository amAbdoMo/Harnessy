#!/usr/bin/env node
/**
 * Boot the shipped Harnessy composition row set and exercise the real
 * `--models-sync` / `--models-explain` operations against it.
 *
 * The driver owns no matching logic: it calls
 * {@link evaluateCommand} and reports what the shipped tree
 * resolved. Everything it prints is the command's own output.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-settings'
import { evaluateCommand } from '../../../src/cli.ts'
import type { ModelCapabilitiesOptions } from '../../../src/cli.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import './registration-recorder.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('capabilities composition driver requires the overlay path')

/** The routes and models this deployment is configured with, written before boot. */
const SETTINGS = `llm-pi-ai:
  providers:
    commandcode:
      displayName: Command Code
      apiKeyEnv: COMMANDCODE_API_KEY
      api: openai-completions
      baseURL: https://api.commandcode.ai/provider/v1
      models:
        - id: z-ai/glm-5.3-flash
          name: GLM-5.3 Flash
          reasoningEfforts:
            low: low
            high: high
            max: max
    cortex:
      displayName: Cortex
      api: openai-completions
      baseURL: https://api.cortecs.ai/v1
      models:
        - id: gpt-5.6-sol
          name: GPT-5.6 Sol
    openai-codex:
      displayName: OpenAI Codex
      models:
        - id: gpt-6-astra
          name: GPT-6 Astra
    openrouter-live:
      displayName: OpenRouter
      api: openai-completions
      baseURL: https://openrouter.ai/api/v1
      models:
        - id: stealth/union-alpha
          name: Union Alpha
model-capabilities:
  publicMetadata:
    enabled: true
    refresh: manual
    cacheTtl: 7d
`

/** One command's run, with both streams captured. */
interface CommandRun {
  /** The flags the command was invoked with. */
  readonly options: ModelCapabilitiesOptions
  /** The process exit code the command answered. */
  readonly code: number
  /** Everything the command wrote to stdout. */
  readonly stdout: string
  /** Everything the command wrote to stderr. */
  readonly stderr: string
}

const home = join(process.cwd(), 'dsh-home')
const settingsPath = join(home, 'settings.yaml')
await mkdir(home, { recursive: true })

/** Write the deployment's settings document with one substitution applied. */
async function writeSettings(substitutions: readonly (readonly [string, string])[] = []): Promise<void> {
  let text = SETTINGS
  for (const [from, to] of substitutions) text = text.replace(from, to)
  await writeFile(settingsPath, text, 'utf8')
}

await writeSettings()

/** The context the booted tree provides to the captured commands. */
type BootedContext = Parameters<typeof evaluateCommand>[0]

/**
 * Run one command through the real operation with both streams captured.
 * @param ctx - the booted tree.
 * @param options - the flags to run with.
 * @returns what the command did.
 */
async function capture(ctx: BootedContext, options: ModelCapabilitiesOptions): Promise<CommandRun> {
  let stdout = ''
  let stderr = ''
  const code = await evaluateCommand(ctx, options, (text) => { stdout += text }, (text) => { stderr += text })
  return { options, code, stdout, stderr }
}

const runs: CommandRun[] = []
const exports: number[] = []

/**
 * Wait for a settings edit to reach the seam's resolved value.
 *
 * The settings document is hot-reloaded, so a read taken the moment the file is
 * written can precede the commit. The subject of every such scenario is the
 * command's behavior under the edited policy, not the watcher's latency.
 * @param ctx - the booted tree.
 * @param expected - which edit to wait for.
 */
async function settledPolicy(ctx: BootedContext, expected: 'never' | 'disabled'): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const section = ctx.get('settings')?.get('model-capabilities') as
      | { publicMetadata?: { enabled?: boolean; refresh?: string } }
      | undefined
    const metadata = section?.publicMetadata
    const settled = expected === 'never' ? metadata?.refresh === 'never' : metadata?.enabled === false
    if (settled) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error(`model-capabilities driver: the settings edit to ${expected} never committed`)
}

const ctx = await bootProductionProfile({
  binName: 'model-capabilities-composition',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
  prepare: (hostCtx) => {
    process.env.DSH_HOME = home
    provideCmdline(hostCtx, { args: [], exit: (code) => { exports.push(code) } })
  },
})

try {
  // What the Models page's own Remote read answers in the shipped composition:
  // the same service the browser asks through, called here without a carrier.
  const capabilities = (await ctx.modelCapabilitiesInspector.remoteExportInspect(new AbortController().signal))
    .map(entry => ({
      route: entry.route,
      model: entry.model,
      enabled: entry.enabled,
      ...entry.resolved === undefined
        ? { match: entry.suggestions.length > 1 ? 'model-id-ambiguous' : entry.suggestions.length === 1 ? 'model-id-only' : 'unresolved' }
        : { match: entry.resolved.match, origin: entry.resolved.origin, levels: entry.resolved.levels },
    }))
  // The seam's chain, as the shipped rows composed it.
  const registrations = [...(globalThis.__modelCapabilityRegistrations ?? [])]
  const sync = process.argv.find(argument => argument.startsWith('--models-sync='))?.slice('--models-sync='.length)
  if (sync === 'check' || sync === 'write') {
    runs.push(await capture(ctx, { modelsSync: 'check' }))
    runs.push(await capture(ctx, { modelsSync: 'write' }))
    // A second write must find nothing left to do.
    runs.push(await capture(ctx, { modelsSync: 'write' }))
    runs.push(await capture(ctx, { modelsSync: 'check' }))
  }
  const explain = process.argv.find(argument => argument.startsWith('--models-explain='))?.slice('--models-explain='.length)
  if (explain !== undefined) runs.push(await capture(ctx, { modelsExplain: explain }))
  if (process.argv.includes('--models-refresh')) {
    runs.push(await capture(ctx, { modelsSync: 'check', modelsRefresh: true }))
  }
  if (process.argv.includes('--models-never-refresh')) {
    await writeSettings([['refresh: manual', 'refresh: never']])
    await settledPolicy(ctx, 'never')
    runs.push(await capture(ctx, { modelsSync: 'check', modelsRefresh: true }))
  }
  if (process.argv.includes('--models-disabled')) {
    await writeSettings([['enabled: true', 'enabled: false']])
    await settledPolicy(ctx, 'disabled')
    runs.push(await capture(ctx, { modelsSync: 'check' }))
  }
  // The Host descriptor the Models page's call dispatches through, registered
  // by the Typert loader from this package's named `./typert` entry.
  const typert = ctx.typert.getPackage('@deepseek-ai/dsh-model-capabilities') !== undefined
  process.stdout.write(`${JSON.stringify({
    registrations,
    typert,
    capabilities,
    runs,
    exports,
    settings: await readFile(settingsPath, 'utf8'),
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
