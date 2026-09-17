/**
 * The `--models-sync` and `--models-explain` commands.
 *
 * Both are thin surfaces over the mounted catalog store: they read the runtime's
 * own selections, ask `inspect.ts` what each configured model resolves to, and
 * either print that or persist the rows a sync is allowed to write. Neither
 * parses a public database — the store and the resolver already did that.
 *
 * `--models-sync` never writes unless asked, and never overwrites a declaration.
 * `--models-refresh` is the explicit, user-triggered fetch that `refresh: manual`
 * permits and `refresh: never` forbids, so a check stays network-free unless the
 * invocation asks for the network.
 *
 * @module @deepseek-ai/dsh-model-capabilities/cli
 */

import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { MODEL_CAPABILITIES_NAMESPACE, parseCacheTtl } from './config.ts'
import { explainModelCapability, inspectConfiguredModels, readConfiguredRoutes } from './inspect.ts'
import { declaredCapabilityFields } from './inspect.ts'
import type {
  ConfiguredRoute, ModelCapabilityExplanation, ModelCapabilityInspection, ModelCapabilityTarget,
} from './inspect.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { MODEL_CAPABILITY_STORE_SERVICE } from './plugin.ts'
import type { PublicCatalogStore, PublicMetadataRefreshMode } from './store.ts'

/** Stable Cordis plugin name. */
export const name = 'model-capabilities-cli'

/** Services this command needs: the command line, its exit, and the mounted store. */
export const inject = ['cmdlineArgs', MODEL_CAPABILITY_STORE_SERVICE]

/** Settings namespace the configured routes live in. */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * How long one explicit refresh may take before it is abandoned, in
 * milliseconds. A command the user waits on gets a shorter bound than the
 * runtime's background refresh.
 */
const CLI_REFRESH_TIMEOUT_MS = 20_000

/** Successful run: the command did what it was asked. */
const EXIT_OK = 0
/** The command could not do what it was asked. */
const EXIT_FAILURE = 1

/** One route's effective policy, resolved from configuration. */
export interface CliPolicy {
  /** Whether the public metadata layer runs at all. */
  readonly enabled: boolean
  /** When this deployment fetches. */
  readonly refresh: PublicMetadataRefreshMode
  /** How long a fetched catalog stays fresh, in milliseconds. */
  readonly cacheTtlMs: number
}

/**
 * Resolve the effective public metadata policy from a settings section.
 *
 * A section this build cannot read is no policy at all: the command then acts on
 * nothing rather than guessing which fields were meant.
 * @param section - the resolved `model-capabilities` section.
 * @returns the policy this invocation acts under, or undefined when unreadable.
 */
export function readCliPolicy(section: unknown): CliPolicy | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const publicMetadata = (section as Record<string, unknown>).publicMetadata
  if (typeof publicMetadata !== 'object' || publicMetadata === null || Array.isArray(publicMetadata)) return undefined
  const fields = publicMetadata as Record<string, unknown>
  if (typeof fields.enabled !== 'boolean') return undefined
  if (fields.refresh !== 'auto' && fields.refresh !== 'manual' && fields.refresh !== 'never') return undefined
  if (typeof fields.cacheTtl !== 'string') return undefined
  try {
    return { enabled: fields.enabled, refresh: fields.refresh, cacheTtlMs: parseCacheTtl(fields.cacheTtl) }
  } catch (_unreadableCacheTtl) {
    // The settings seam refuses an unreadable duration at the write, so this
    // only shields a hand-edited document; the command then acts on nothing.
    return undefined
  }
}

/**
 * Parse a route-qualified model argument.
 * @param value - the argument, shaped `<route>/<model>`.
 * @returns the target, or undefined when the argument is not route-qualified.
 */
export function parseTarget(value: string): ModelCapabilityTarget | undefined {
  const separator = value.indexOf('/')
  // The route is required: a bare model id does not identify a gateway, which is
  // exactly the ambiguity this layer refuses to guess through.
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { route: value.slice(0, separator), model: value.slice(separator + 1) }
}

/**
 * Render one model's current declaration for a report line.
 * @param declared - the row's declaration.
 * @returns the text a report prints beside `current:`.
 */
function declarationLabel(declared: ModelCapabilityInspection['declared']): string {
  if (declared.declaresNoReasoning) return 'does not reason (declared)'
  if (declared.efforts === undefined) return 'undeclared'
  return declared.efforts.join(', ')
}

/**
 * Render one model's resolution for a report line.
 * @param inspection - the inspected model.
 * @returns the text a report prints beside `discovered:`.
 */
function discoveryLabel(inspection: ModelCapabilityInspection): string {
  const resolved = inspection.chain.resolved
  if (resolved !== undefined) return resolved.levels.join(', ')
  return inspection.chain.suggestions.length > 0 ? 'suggestion only' : 'nothing'
}

/**
 * Render the action a sync takes for one inspected model.
 * @param inspection - the inspected model.
 * @param writing - whether this invocation persists authoritative results.
 * @returns the text a report prints beside `action:`.
 */
function actionLabel(inspection: ModelCapabilityInspection, writing: boolean): string {
  switch (inspection.decision) {
    case 'write':
      return writing ? 'written' : 'would write'
    case 'declared':
      return 'kept (already declared)'
    case 'suggestion':
      return 'not written (suggestion only)'
    case 'unresolved':
      return 'unresolved'
    /* v8 ignore next 2 -- every decision the union declares is a case above. */
    default:
      return assertNever(inspection.decision, 'model-capabilities command')
  }
}

/**
 * Render one inspected model as the report's block.
 * @param inspection - the inspected model.
 * @param writing - whether this invocation persists authoritative results.
 * @param write - the report sink.
 */
function reportInspection(
  inspection: ModelCapabilityInspection,
  writing: boolean,
  write: (line: string) => void,
): void {
  write(`${inspection.route} / ${inspection.model}`)
  write(`  current:       ${declarationLabel(inspection.declared)}`)
  write(`  discovered:    ${discoveryLabel(inspection)}`)
  const resolved = inspection.chain.resolved
  if (resolved !== undefined) {
    // A resolved claim is reported even when the row already declares one: the
    // reader needs what the catalogs state to judge the declaration it kept.
    write(`  source:        ${resolved.source}`)
    write(`  provider:      ${resolved.provider}`)
    write(`  match:         ${resolved.match}`)
    write(`  origin:        ${resolved.origin}`)
    if (resolved.fetchedAt !== undefined) write(`  fetchedAt:     ${resolved.fetchedAt}`)
    write('  authoritative: yes')
  } else if (inspection.chain.suggestions.length > 0) {
    write(`  match:         ${inspection.chain.suggestions.length > 1 ? 'model-id-ambiguous' : 'model-id-only'}`)
    write('  authoritative: no')
    write('  suggestions:')
    for (const suggestion of inspection.chain.suggestions) {
      write(`    - ${suggestion.source} / ${suggestion.provider}: ${suggestion.levels.join(', ')}`)
    }
  }
  write(`  action:        ${actionLabel(inspection, writing)}`)
}

/**
 * Render one model's whole resolution chain, for `--models-explain`.
 * @param explanation - the resolution chain for the model.
 * @param write - the report sink.
 */
function reportExplanation(explanation: ModelCapabilityExplanation, write: (line: string) => void): void {
  write('Resolution:')
  for (const tier of explanation.tiers) {
    write(`${tier.tier}:`)
    switch (tier.state) {
      case 'no-catalog':
        write('  no catalog loaded')
        break
      case 'not-matched':
        write('  no authoritative provider match')
        break
      case 'answered':
        write(`  ${tier.provider as string}`)
        write(`  match: ${tier.match as string}`)
        write(`  efforts: ${(tier.levels as readonly string[]).join(', ')}`)
        if (tier.fetchedAt !== undefined) write(`  fetchedAt: ${tier.fetchedAt}`)
        break
      /* v8 ignore next 2 -- every tier state the union declares is a case above. */
      default:
        assertNever(tier.state, 'model-capabilities command')
    }
  }
  write('Final:')
  write(`  ${explanation.resolved === undefined ? 'undeclared' : explanation.resolved.levels.join(', ')}`)
  if (explanation.suggestions.length === 0) return
  write('')
  write('Suggestions:')
  for (const suggestion of explanation.suggestions) {
    write(`  ${suggestion.source} / ${suggestion.provider}`)
    write(`    ${suggestion.levels.join(', ')}`)
  }
  write('')
  write('Reason:')
  write('  model-id-only claims disagree and no provider-aware route match exists')
}

/**
 * The next `llm-pi-ai` user section carrying every writable declaration.
 *
 * The seam merges a patch over the user's section and replaces arrays wholesale,
 * so each touched route contributes its complete models list with only the
 * matching rows changed. Every other field of every row is restated as it stands,
 * which is what keeps the write from dropping configuration it did not mean to
 * touch.
 * @param routes - the configured routes.
 * @param inspections - the inspected models.
 * @returns the patch to write, empty when nothing is writable.
 */
export function writableSection(
  routes: readonly ConfiguredRoute[],
  inspections: readonly ModelCapabilityInspection[],
): Record<string, unknown> {
  const writable = new Map<string, Map<string, Record<string, unknown>>>()
  for (const inspection of inspections) {
    if (inspection.decision !== 'write' || inspection.write === undefined) continue
    const fields = declaredCapabilityFields(inspection.write.levels, inspection.write.defaultEffort)
    if (Object.keys(fields).length === 0) continue
    const byModel = writable.get(inspection.route) ?? new Map<string, Record<string, unknown>>()
    byModel.set(inspection.model, fields)
    writable.set(inspection.route, byModel)
  }
  if (writable.size === 0) return {}
  const providers: Record<string, unknown> = {}
  for (const route of routes) {
    const byModel = writable.get(route.route)
    if (byModel === undefined) continue
    providers[route.route] = {
      ...route.profile,
      models: route.models.map(model => (byModel.has(model.id)
        ? { ...model.profile, ...byModel.get(model.id) as Record<string, unknown> }
        : model.profile)),
    }
  }
  return { providers }
}

/**
 * Persist every writable inspection through the settings seam.
 *
 * A patch the seam refuses leaves the document exactly as it was: the write is
 * one validated `llm-pi-ai` merge, not a sequence of partial edits.
 * @param routes - the configured routes.
 * @param inspections - the inspected models.
 * @param settings - the settings provider to write through.
 * @returns the number of rows written.
 * @throws When the seam refuses the write.
 */
export async function writeInspections(
  routes: readonly ConfiguredRoute[],
  inspections: readonly ModelCapabilityInspection[],
  settings: { update(ns: string, patch: object): Promise<void> },
): Promise<number> {
  const writable = inspections.filter(inspection => inspection.decision === 'write')
  if (writable.length === 0) return 0
  await settings.update(LLM_PI_AI_NAMESPACE, writableSection(routes, writable))
  return writable.length
}

/**
 * Report the configured models in configuration order.
 * @param inspections - the inspected models.
 * @param writing - whether this invocation persists authoritative results.
 * @param write - the report sink.
 */
function reportAll(
  inspections: readonly ModelCapabilityInspection[],
  writing: boolean,
  write: (line: string) => void,
): void {
  if (inspections.length === 0) {
    write('no models are configured under llm-pi-ai')
    return
  }
  for (const inspection of inspections) {
    reportInspection(inspection, writing, write)
    write('')
  }
}

/**
 * Fetch whatever the policy makes eligible, for an explicit refresh request.
 * @param store - the mounted catalog store.
 */
async function refreshForCommand(store: PublicCatalogStore): Promise<void> {
  const guard = deadline(new AbortController().signal, CLI_REFRESH_TIMEOUT_MS, 'MODEL_CAPABILITY_REFRESH')
  try {
    await store.refresh(guard.signal)
  } finally {
    guard[Symbol.dispose]()
  }
}

/**
 * The app's command: the two model-capability flags and their help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function modelCapabilitiesCommand(): Command {
  return new Command()
    .name('dsh --profile custom-harness')
    .description('Inspect and sync the reasoning-effort capabilities public metadata states for the configured routes.')
    .helpOption('-h, --help', 'show this help')
    // A repeated option accumulates through its parser, which is what makes one
    // command line able to write a sync and then check what it left behind.
    .option('--models-sync <mode>', 'check the configured models, or write the authoritative provider-aware results; repeatable (check|write)', collect)
    .option('--models-explain <route/model>', 'print the resolution chain for one configured model; repeatable', collect)
    .option('--models-refresh', 'fetch public metadata first; refused while refresh is "never"')
    .addHelpText('after', `
Examples:
  dsh --profile custom-harness --models-sync=check
                                             report what the configured models resolve to
  dsh --profile custom-harness --models-sync=write
                                             persist authoritative provider-aware results
  dsh --profile custom-harness --models-explain=openai-codex/gpt-5.6-sol
                                             print one model's whole resolution chain
  dsh --profile custom-harness --models-sync=check --models-refresh
                                             fetch first when the refresh policy is manual
`)
}

/** The parsed flags one invocation carries. */
/** The parsed flags one invocation carries. */
export interface ModelCapabilitiesOptions {
  /** `check` or `write` values, one run each, in argv order. */
  readonly modelsSync?: string | readonly string[]
  /** Route-qualified models, one explanation each, in argv order. */
  readonly modelsExplain?: string | readonly string[]
  /** Whether this invocation explicitly asks for a fetch. */
  readonly modelsRefresh?: boolean
}

/** One command to run, which is one flag occurrence. */
export type ModelCapabilityRun = Omit<ModelCapabilitiesOptions, 'modelsSync' | 'modelsExplain'> & {
  /** `check` or `write`, when this run is a sync. */
  readonly modelsSync?: string
  /** Route-qualified model, when this run is an explanation. */
  readonly modelsExplain?: string
}

/**
 * Run one parsed invocation against the mounted tree.
 *
 * A refresh happens only when the invocation asked for one and the policy allows
 * it: `manual` is the mode that permits an explicit user-triggered fetch, and
 * `never` refuses one loudly rather than silently reporting stale data.
 * @param ctx - the plugin context.
 * @param options - one run's flags.
 * @param out - stdout sink.
 * @param err - stderr sink.
 * @returns the process exit code.
 */
async function runOnce(
  ctx: Context,
  options: ModelCapabilityRun,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const write = (line: string): void => { out(`${line}\n`) }
  const policy = readCliPolicy(ctx.get('settings')?.get(MODEL_CAPABILITIES_NAMESPACE))
  if (policy === undefined || !policy.enabled) {
    // A layer that is off has no catalogs at all, so every branch below would
    // report the same emptiness; the policy is the answer instead.
    write('public metadata is disabled (model-capabilities.publicMetadata.enabled is false)')
    write('enable it in settings.yaml or the composition entry to use these commands')
    return EXIT_OK
  }
  const store = ctx.get(MODEL_CAPABILITY_STORE_SERVICE)
  if (store === undefined) {
    err('model-capabilities: the public metadata plugin is not mounted in this composition\n')
    return EXIT_FAILURE
  }
  const target = options.modelsExplain === undefined ? undefined : parseTarget(options.modelsExplain)
  if (options.modelsExplain !== undefined && target === undefined) {
    err(`model-capabilities: --models-explain needs a <route>/<model> argument, received ${JSON.stringify(options.modelsExplain)}\n`)
    return EXIT_FAILURE
  }
  const sync = options.modelsSync
  if (sync !== undefined && sync !== 'check' && sync !== 'write') {
    err(`model-capabilities: --models-sync needs "check" or "write", received ${JSON.stringify(sync)}\n`)
    return EXIT_FAILURE
  }
  if (options.modelsRefresh === true && policy.refresh === 'never') {
    err('model-capabilities: refresh is "never" for this deployment, so public metadata may not be fetched\n')
    return EXIT_FAILURE
  }
  if (options.modelsRefresh === true) await refreshForCommand(store)
  else await store.load()

  const routes = readConfiguredRoutes(ctx.get('settings')?.get(LLM_PI_AI_NAMESPACE))
  if (target !== undefined) {
    // An unconfigured pair is still explained: the question is what the public
    // catalogs state about it, and "nothing" is a useful answer.
    const configured = routes.find(route => route.route === target.route)
    const explanation = explainModelCapability(
      store.selections(),
      target,
      typeof configured?.profile.baseURL === 'string' ? { baseURL: configured.profile.baseURL } : {},
    )
    write('Model:')
    write(`  route: ${target.route}`)
    write(`  id: ${target.model}`)
    write('')
    reportExplanation(explanation, write)
    return EXIT_OK
  }
  // One run is one command: a run always carries either a mode or a target, so
  // reaching neither means the caller asked for nothing.
  /* v8 ignore next -- the requested-run list never yields an entry with neither flag. */
  if (sync === undefined) return EXIT_OK
  const inspections = inspectConfiguredModels(routes, store)

  let written = 0
  if (sync === 'write') {
    const settings = ctx.get('settings')
    /* v8 ignore next 4 -- the policy above is read from this same service, so an absent one already reported the layer disabled. */
    if (settings === undefined) {
      err('model-capabilities: --models-sync=write needs the settings service, which this composition does not mount\n')
      return EXIT_FAILURE
    }
    try {
      written = await writeInspections(routes, inspections, settings)
    } catch (error) {
      err(`model-capabilities: writing the settings document failed: ${String(error)}\n`)
      return EXIT_FAILURE
    }
  }
  reportAll(inspections, sync === 'write', write)
  if (sync === 'write') write(`${written} declaration(s) written`)
  return EXIT_OK
}

/**
 * The launcher's bounded exit, or nothing when it cannot take a code back.
 *
 * A launcher without one cannot answer a command, so the invocation declines
 * loudly rather than running work whose outcome it cannot report.
 * @param ctx - the plugin context.
 * @param options - the parsed flags, named in the diagnostic.
 * @returns the exit request, or undefined when the launcher provides none.
 */
export function boundedExit(ctx: Context, options: ModelCapabilitiesOptions): AppExit | undefined {
  const exit = ctx.get('appExit')
  if (exit !== undefined) return exit
  const asked = [...toRuns(options.modelsSync), ...toRuns(options.modelsExplain)].join(' ')
  process.stderr.write(
    `model-capabilities: this composition provides no bounded exit, so ${JSON.stringify(asked)} cannot run\n`,
  )
  return undefined
}

/**
 * Parse this app's flags and run the requested command once the tree is up.
 *
 * The command runs at `appReady`, not during `apply`: it reads the settings
 * document and the route set, and a tree that is still mounting has not
 * published either yet. Flags repeat in argv order, so one invocation may write
 * a sync and then check what it left behind.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const program = modelCapabilitiesCommand()
  program.action(() => {})
  parseCmdline(ctx, program)
  const options = program.opts<ModelCapabilitiesOptions>()
  if (requestedRuns(options).length === 0) return
  const exit = boundedExit(ctx, options)
  /* v8 ignore next -- `boundedExit` is the only way back, and it reports before returning. */
  if (exit === undefined) return
  /**
   * Run the invocation and hand its outcome to the launcher.
   *
   * A programming error inside the operation is contained here rather than
   * escaping as an unhandled rejection.
   */
  const start = async (): Promise<void> => {
    let code: number
    try {
      code = await evaluateCommand(ctx, options)
    } catch (error) {
      process.stderr.write(`model-capabilities: ${String(error)}\n`)
      code = EXIT_FAILURE
    }
    exit(code)
  }
  /** Defer the run to the launcher's readiness signal when there is one. */
  const begin = (): void => { void start() }
  const ready = ctx.get('appReady')
  if (ready === undefined) begin()
  else ctx.effect(() => ready.onReady(begin), 'model-capabilities.runCommand()')
}

/**
 * The commands one invocation asks for, in argv order.
 *
 * A refresh-only invocation is a check with the network asked for, which is why
 * it appears here rather than at the call sites.
 * @param options - the parsed flags.
 * @returns one entry per command to run, empty when none was requested.
 */
function requestedRuns(options: ModelCapabilitiesOptions): ModelCapabilityRun[] {
  const refresh = options.modelsRefresh === true ? { modelsRefresh: true } : {}
  const runs: ModelCapabilityRun[] = [
    ...toRuns(options.modelsSync).map(modelsSync => ({ modelsSync, ...refresh })),
    ...toRuns(options.modelsExplain).map(modelsExplain => ({ modelsExplain, ...refresh })),
  ]
  if (runs.length === 0 && options.modelsRefresh === true) runs.push({ modelsSync: 'check', modelsRefresh: true })
  return runs
}

/**
 * Run one invocation's requested commands, in argv order.
 *
 * The first failure is the run's outcome: a later command that succeeds does not
 * turn a failed sync into a successful process exit.
 * @param ctx - the plugin context.
 * @param options - the parsed flags.
 * @param out - stdout sink.
 * @param err - stderr sink.
 * @returns the process exit code.
 */
export async function evaluateCommand(
  ctx: Context,
  options: ModelCapabilitiesOptions,
  out: (text: string) => void = text => void process.stdout.write(text),
  err: (text: string) => void = text => void process.stderr.write(text),
): Promise<number> {
  let code = EXIT_OK
  for (const run of requestedRuns(options)) {
    const next = await runOnce(ctx, run, out, err)
    if (next !== EXIT_OK) return next
    code = next
  }
  return code
}

/**
 * Read one repeatable flag's values in argv order.
 *
 * Commander answers a flag given once with its value and a flag given more than
 * once with the list, so both forms are read here rather than at each use.
 * @param value - the parsed value: undefined, one value, or several.
 * @returns the values, empty when the flag was absent.
 */
function toRuns(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'string' ? [value] : value
}

/**
 * Collect one repeatable option's values in argv order.
 *
 * Commander calls this parser once per occurrence with whatever the option holds
 * so far, so the accumulator is also the option's declared type. Declaring a
 * default would make commander treat the value as already-accumulated and skip
 * the parser, which is why the first occurrence arrives as `undefined`.
 * @param value - the value this occurrence carried.
 * @param previous - the values earlier occurrences carried.
 * @returns the accumulated values.
 */
function collect(value: string, previous: readonly string[] | undefined): readonly string[] {
  return [...previous ?? [], value]
}
