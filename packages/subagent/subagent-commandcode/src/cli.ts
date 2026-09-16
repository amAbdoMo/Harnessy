/**
 * Locating and interrogating the user's own installed Command Code CLI: the
 * executable this build invokes, its installation and authentication state,
 * and its advisory model catalog.
 *
 * Nothing here redistributes or vendors the CLI, and no credential is read,
 * copied, or stored: the executable answers for itself.
 *
 * @module @deepseek-ai/dsh-subagent-commandcode/cli
 */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CommandCodeCatalog, CommandCodeHealth, CommandCodeModelSummary } from './types.ts'

/** Executable this build invokes on Windows. */
export const COMMAND_CODE_WINDOWS_COMMAND = 'cmdc'

/** Executable this build invokes elsewhere. */
export const COMMAND_CODE_POSIX_COMMAND = 'cmd'

/** Bound on one installation, authentication, or catalog probe. */
export const COMMAND_CODE_PROBE_TIMEOUT_MS = 20_000

/** How one resolved invocation starts the CLI. */
export interface CommandCodeInvocation {
  /** Program handed to the operating system as argv[0]. */
  readonly program: string
  /** Fixed arguments preceding the CLI's own flags. */
  readonly prefix: readonly string[]
  /** How the executable was located, for host-side diagnostics. */
  readonly source: 'path' | 'windows-shim'
}

/** Outcome of one short-lived CLI helper process. */
export interface CommandCodeProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run one short-lived CLI helper.
 * @param args - CLI arguments after the invocation prefix.
 * @param signal - bound on the probe.
 * @returns exit facts and both collected streams.
 */
export type CommandCodeRunner = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<CommandCodeProcessResult>

/** Filesystem operations the locator uses, injectable so Windows resolution is testable anywhere. */
export interface CommandCodeLocatorInternals {
  /** Directory list from `PATH`. */
  readonly pathEntries: readonly string[]
  /** Whether a path names an existing file. */
  readonly exists: (path: string) => boolean
  /** Read a shim script as text. */
  readonly readText: (path: string) => string
}

/**
 * Resolve how to start the user's Command Code CLI on this platform.
 *
 * Windows is the only platform needing translation: npm installs the CLI as a
 * `.cmd` shim, and the subprocess seam spawns argv directly without a shell, so
 * the shim is read for the JavaScript entry it launches. Everywhere else the
 * executable on `PATH` is the program itself.
 * @param platform - the running platform.
 * @param internals - injected filesystem access.
 * @returns the invocation to spawn.
 * @throws {Error} when no installed CLI can be resolved.
 */
export function resolveCommandCodeInvocation(
  platform: NodeJS.Platform,
  internals: CommandCodeLocatorInternals,
): CommandCodeInvocation {
  if (platform !== 'win32') {
    return { program: COMMAND_CODE_POSIX_COMMAND, prefix: [], source: 'path' }
  }
  for (const entry of internals.pathEntries) {
    if (entry.length === 0) continue
    const shim = join(entry, `${COMMAND_CODE_WINDOWS_COMMAND}.cmd`)
    if (!internals.exists(shim)) continue
    const target = windowsShimEntry(internals.readText(shim), entry)
    if (target === undefined) {
      // The message reaches the model through a health detail, so it names no
      // host path; the shim's location stays in the Host log.
      throw new Error(
        `commandcode: the installed ${COMMAND_CODE_WINDOWS_COMMAND} launcher does not name a JavaScript entry — reinstall Command Code`,
      )
    }
    return { program: process.execPath, prefix: [target], source: 'windows-shim' }
  }
  throw new Error(
    `commandcode: ${COMMAND_CODE_WINDOWS_COMMAND} is not on PATH — install Command Code and run "${COMMAND_CODE_WINDOWS_COMMAND} login"`,
  )
}

/**
 * Resolve the CLI using the running process's own PATH and filesystem.
 * @returns the invocation to spawn.
 * @throws {Error} when no installed CLI can be resolved.
 */
export function defaultCommandCodeInvocation(): CommandCodeInvocation {
  return resolveCommandCodeInvocation(process.platform, {
    pathEntries: (process.env.PATH ?? '').split(delimiter),
    exists: path => existsSync(path),
    readText: path => readFileSync(path, 'utf8'),
  })
}

/**
 * Read the JavaScript entry an npm `.cmd` shim launches.
 * @param script - the shim's text.
 * @param directory - the shim's own directory, which `%dp0%` names.
 * @returns the absolute entry path, or undefined when the shim names none.
 */
export function windowsShimEntry(script: string, directory: string): string | undefined {
  const match = /"([^"]*\.m?js)"/iu.exec(script)
  const raw = match?.[1]
  if (raw === undefined) return undefined
  const expanded = raw
    .replace(/%~?dp0%/giu, directory)
    .replace(/[\\/]+/gu, '\\')
  return expanded
}

/**
 * Report whether the CLI is installed, which version it is, and whether it
 * holds an authenticated account.
 * @param run - helper-process runner bound to the resolved executable.
 * @param signal - caller cancellation.
 * @returns the bounded health facts the Settings page shows.
 */
export async function probeCommandCode(
  run: CommandCodeRunner,
  signal: AbortSignal,
): Promise<CommandCodeHealth> {
  const command = COMMAND_CODE_WINDOWS_COMMAND_OR_POSIX()
  let version: CommandCodeProcessResult
  try {
    version = await run(['--version'], signal)
  } catch {
    return {
      command,
      installed: false,
      authenticated: false,
      detail: `Command Code was not found. Install it, then run "${command} login".`,
    }
  }
  if (version.exitCode !== 0) {
    return {
      command,
      installed: false,
      authenticated: false,
      detail: `"${command} --version" exited with ${String(version.exitCode)}. Reinstall Command Code, then run "${command} login".`,
    }
  }
  const reported = firstLine(version.stdout)
  let status: CommandCodeProcessResult
  try {
    status = await run(['status'], signal)
  } catch {
    return {
      command,
      installed: true,
      ...(reported.length === 0 ? {} : { version: reported }),
      authenticated: false,
      detail: `"${command} status" could not run. Run "${command} login" to sign in.`,
    }
  }
  const authenticated = status.exitCode === 0 && /authenticated/iu.test(status.stdout)
  return {
    command,
    installed: true,
    ...(reported.length === 0 ? {} : { version: reported }),
    authenticated,
    ...authenticated ? {} : { detail: `Command Code is not signed in. Run "${command} login".` },
  }
}

/** The executable name this build looks for on the running platform. */
function COMMAND_CODE_WINDOWS_COMMAND_OR_POSIX(): string {
  return process.platform === 'win32' ? COMMAND_CODE_WINDOWS_COMMAND : COMMAND_CODE_POSIX_COMMAND
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/u)[0] ?? '').trim()
}

/**
 * Read the CLI's advisory model catalog.
 * @param run - helper-process runner.
 * @param signal - caller cancellation.
 * @returns catalog rows, or an empty catalog with a bounded explanation.
 */
export async function readCommandCodeCatalog(
  run: CommandCodeRunner,
  signal: AbortSignal,
): Promise<CommandCodeCatalog> {
  let listing: CommandCodeProcessResult
  try {
    listing = await run(['--list-models'], signal)
  } catch {
    return { models: [], detail: 'The model catalog could not be read. Enter a model id manually.' }
  }
  if (listing.exitCode !== 0) {
    return {
      models: [],
      detail: `"${COMMAND_CODE_WINDOWS_COMMAND_OR_POSIX()} --list-models" exited with ${String(listing.exitCode)}. Enter a model id manually.`,
    }
  }
  const models = parseModelCatalog(listing.stdout)
  return models.length === 0
    ? { models, detail: 'The model catalog could not be read. Enter a model id manually.' }
    : { models }
}

/**
 * Parse the `--list-models` listing into rows.
 *
 * The listing groups ids under provider headings with a description column;
 * headings and the trailing usage footer have no description column, so a
 * conservative two-or-more-space split is what separates rows from prose. A
 * renamed or reformatted catalog yields no rows, which the Settings page
 * answers by accepting a manually typed model id.
 * @param stdout - the complete listing text.
 * @returns unique catalog rows in listing order.
 */
export function parseModelCatalog(stdout: string): CommandCodeModelSummary[] {
  const models: CommandCodeModelSummary[] = []
  const seen = new Set<string>()
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trimEnd()
    if (line.length === 0 || /^\s/u.test(raw)) continue
    const match = /^(\S+)\s{2,}(.+)$/u.exec(line)
    const id = match?.[1]
    const description = match?.[2]?.trim()
    if (id === undefined || description === undefined) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(id)) continue
    // A label such as `Docs:` separates the listing's footer from real rows:
    // it reads as an id, but no id ends in a colon.
    if (id.endsWith(':')) continue
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, description })
  }
  return models
}
