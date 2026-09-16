/**
 * Deterministic Command Code CLI behind the shipped process owner.
 *
 * The recorded-session composition inserts this row before the delegation
 * plugin, so the plugin's own executable resolution succeeds on every platform
 * and every helper process it starts is answered from fixed bytes instead of
 * whatever the machine happens to have installed. Argv this fixture does not
 * recognize is delegated to the shipped process owner unchanged, so the rest of
 * the profile behaves exactly as it does without the fixture.
 *
 * @module commandcode-fake-cli
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export const name = 'commandcode-fake-cli'
export const inject = ['subprocess']

/** The version line `--version` reports. */
const VERSION = '1.54.0'
/** The sign-in line `status` reports; the probe matches `/authenticated/i`. */
const STATUS = 'Authenticated as snapshot@example.com'
/** The advisory catalog `--list-models` prints, in the CLI's listing shape. */
const CATALOG = [
  'Available models',
  '',
  'deepseek/deepseek-v4.1-flash  Fast default for delegated coding work',
  'deepseek/deepseek-v4.1         Deeper reasoning, slower',
  '',
].join('\n')

/** The NDJSON frames one delegation emits, in stream order. */
const RUN_FRAMES = [
  // Two coarse activities and a final answer: the parent job shows the
  // category while the run is live and the answer once it has settled.
  { type: 'event', event: { type: 'agent_start' } },
  { type: 'event', event: { type: 'tool_start', toolName: 'read_file' } },
  { type: 'event', event: { type: 'tool_start', toolName: 'apply_patch' } },
  { type: 'result', subtype: 'success', finalText: 'COMMANDCODE_DELEGATE_OK\n' },
].map(frame => `${JSON.stringify(frame)}\n`).join('')

/** Which fixed answer one argv asks for, if any. */
function stageOf(argv: readonly string[]): 'version' | 'status' | 'catalog' | 'run' | undefined {
  if (argv.includes('--version')) return 'version'
  if (argv.includes('status')) return 'status'
  if (argv.includes('--list-models')) return 'catalog'
  return argv.includes('--output-format') ? 'run' : undefined
}

/** One exit with no signal, the outcome every fixed answer reports. */
const EXIT: SubprocessOutcome = { exitCode: 0, signal: null }

/** The stdout bytes one stage emits. */
function payloadOf(stage: string): string {
  switch (stage) {
    case 'run': return RUN_FRAMES
    case 'version': return `${VERSION}\n`
    case 'status': return `${STATUS}\n`
    default: return CATALOG
  }
}

/**
 * Build one managed process that answers a recognized argv from fixed bytes.
 * @param stage - which fixed answer this argv asks for.
 * @param spec - the spawn request, used for its abort signal.
 * @returns the handle the caller holds.
 */
function answer(stage: string, spec: SubprocessSpawnSpec): SubprocessHandle {
  const out = new PassThrough()
  const err = new PassThrough()
  const input = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const exited = Promise.withResolvers<boolean>()
  const payload = payloadOf(stage)
  let finished = false

  const finish = (): void => {
    if (finished) return
    finished = true
    out.end()
    err.end()
    done.resolve(EXIT)
    exited.resolve(true)
  }

  const handle: SubprocessHandle = {
    stdin: input,
    stdout: out,
    stderr: err,
    collected: {
      // The probe reads collected output rather than the piped stream, so the
      // fixed answer is served from both.
      stdout: {
        readFrom: (fromByte: number) => fromByte === 0
          ? { text: payload, nextOffset: payload.length, lossy: false }
          : { text: '', nextOffset: fromByte, lossy: false },
      },
      stderr: {
        readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }),
      },
    },
    done: done.promise,
    terminate: finish,
    waitForExit: () => exited.promise,
  }

  spec.signal?.addEventListener('abort', finish, { once: true })
  // Traffic is emitted after the caller had its chance to attach listeners.
  setImmediate(() => {
    out.write(payload)
    finish()
  })
  return handle
}

/**
 * Make Command Code resolvable and answer it deterministically.
 * @param ctx - Loader context supplying the shared process owner.
 */
export function apply(ctx: Context): void {
  // Windows resolves the CLI through an npm `.cmd` shim on PATH, and other
  // platforms return the bare command name without touching the filesystem, so
  // the shim directory is what makes this scenario platform-independent. Its
  // contents are never run: the wrapper below answers the spawn.
  if (process.platform === 'win32') {
    const shim = mkdtempSync(join(tmpdir(), 'commandcode-fake-cli-'))
    writeFileSync(join(shim, 'cmdc.cmd'), '@ECHO off\r\nnode "%~dp0\\cmdc.js" %*\r\n')
    writeFileSync(join(shim, 'cmdc.js'), '')
    const before = process.env.PATH ?? ''
    process.env.PATH = [shim, before].filter(entry => entry.length > 0).join(delimiter)
    ctx.effect(() => () => {
      process.env.PATH = before
      rmSync(shim, { recursive: true, force: true })
    })
  }

  const original = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    const stage = stageOf(spec.argv)
    return stage === undefined ? original(spec) : answer(stage, spec)
  }
}
