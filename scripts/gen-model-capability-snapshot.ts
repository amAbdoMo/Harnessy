/**
 * Generate the bundled public model capability snapshot from captured public
 * databases.
 *
 * The snapshot is what lets a deployment resolve public reasoning-effort
 * metadata with no network: it is a curated re-encode of one capture of
 * `models.dev/api.json` and OpenRouter's `/api/v1/models`, in the document form
 * `resolvePublicCapability` already reads. Curation, ordering, and the document
 * schema live in the package (`src/snapshot.ts`), so this script owns only
 * reading the captures, hashing them, and writing or checking the artifact.
 *
 * The artifact is a TypeScript data module rather than JSON: this repository
 * publishes an exact `files` list per package and its NodeNext consumer check
 * compiles built declarations, so a tracked JSON file would have to be imported
 * through a path the published tree cannot carry. A generated module is the
 * same bytes of data with none of that friction, and the package bundles it
 * into its entry like any other source.
 *
 * Offline by design: it reads the already-captured files and never calls an
 * endpoint. Both inputs may be overridden, which is what lets a test prove the
 * generator against a fixture capture.
 *
 * `generatedAt` is the one field that differs between two writes of the same
 * captures. `--check` reuses the committed module's timestamp, so a stale
 * artifact fails on its content and never on the wall clock.
 *
 * @module scripts/gen-model-capability-snapshot
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSnapshot, SNAPSHOT_SCHEMA_VERSION } from '../packages/llm/model-capabilities/src/snapshot.ts'
import type { ModelCapabilitySnapshot, SnapshotInputs } from '../packages/llm/model-capabilities/src/snapshot.ts'

const root = resolve(import.meta.dirname, '..')

/** The committed artifact this script owns. */
export const SNAPSHOT_PATH = 'packages/llm/model-capabilities/src/snapshot/public-model-capabilities.ts'

/** The export the generated module states the document under. */
export const SNAPSHOT_EXPORT = 'snapshotModule'

/**
 * The curated captures this script reads by default.
 *
 * They are checked in, so a fresh checkout reproduces the artifact without the
 * multi-megabyte raw captures. Regenerating them from new captures is
 * `.artifacts/make-snapshot-fixtures.mjs`, which is also outside the gate: the
 * gate verifies that the artifact matches these inputs and this generator.
 */
export const DEFAULT_MODELS_DEV_INPUT = 'packages/llm/model-capabilities/tests/fixtures/upstream/models-dev.json'
/** The curated OpenRouter capture this script reads by default. */
export const DEFAULT_OPENROUTER_INPUT = 'packages/llm/model-capabilities/tests/fixtures/upstream/openrouter.json'

/** One resolved command line: what to read, what to write, and how. */
export interface SnapshotRequest {
  /** Whether to verify the committed artifact instead of writing it. */
  readonly check: boolean
  /** Repository-relative path of the captured models.dev database. */
  readonly modelsDevInput: string
  /** Repository-relative path of the captured OpenRouter catalog. */
  readonly openRouterInput: string
  /** Repository-relative path of the artifact to write or verify. */
  readonly output: string
  /** Timestamp to record instead of the current time; `--write` only. */
  readonly generatedAt?: string
}

const VALUE_FLAGS = ['--models-dev', '--openrouter', '--out', '--generated-at'] as const

/** One value-taking flag and the request field it sets. */
type ValueFlag = (typeof VALUE_FLAGS)[number]

/**
 * Parse this script's command line.
 * @param args - process arguments after the script path.
 * @returns the resolved request.
 * @throws When a flag is unknown or a value-taking flag has no value.
 */
export function parseRequest(args: readonly string[]): SnapshotRequest {
  let check = false
  const inputs: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string
    if (flag === '--check') {
      check = true
      continue
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`gen-model-capability-snapshot: unknown flag ${flag}`)
    }
    const value = args[index + 1]
    if (value === undefined) throw new Error(`gen-model-capability-snapshot: ${flag} needs a value`)
    index += 1
    inputs[(flag as ValueFlag).slice(2)] = value
  }
  return {
    check,
    modelsDevInput: inputs['models-dev'] ?? DEFAULT_MODELS_DEV_INPUT,
    openRouterInput: inputs.openrouter ?? DEFAULT_OPENROUTER_INPUT,
    output: inputs.out ?? SNAPSHOT_PATH,
    ...inputs['generated-at'] === undefined ? {} : { generatedAt: inputs['generated-at'] },
  }
}

/**
 * Read one captured document and the digest of the bytes it was parsed from.
 * @param path - repository-relative path of the capture.
 * @returns the parsed document and its SHA-256 digest.
 * @throws When the capture is absent, so a caller never reads a missing file as an empty database.
 */
export function readCapture(path: string): { readonly document: unknown; readonly digest: string } {
  const text = readFileSync(resolve(root, path), 'utf8')
  return { document: JSON.parse(text) as unknown, digest: createHash('sha256').update(text).digest('hex') }
}

/**
 * Read both captures.
 * @param request - the resolved command line.
 * @returns the inputs one snapshot build consumes.
 */
export function readInputs(request: SnapshotRequest): SnapshotInputs {
  const modelsDev = readCapture(request.modelsDevInput)
  const openRouter = readCapture(request.openRouterInput)
  return {
    modelsDevInput: request.modelsDevInput,
    modelsDevSource: modelsDev.document,
    modelsDevDigest: modelsDev.digest,
    openRouterInput: request.openRouterInput,
    openRouterSource: openRouter.document,
    openRouterDigest: openRouter.digest,
  }
}

/** The banner every generated module carries, so nobody edits one by hand. */
const GENERATED_BANNER = [
  '/**',
  ' * Generated by scripts/gen-model-capability-snapshot.ts — do not edit by hand.',
  ' * Run `pnpm run gen-model-capability-snapshot` to regenerate it from the',
  ' * curated captures in tests/fixtures/upstream/.',
  ' *',
  ' * The document is the bundled public capability snapshot: one curated capture',
  ' * of each public model database, reduced to the reasoning-effort claims this',
  ' * package resolves, plus the identity of the captures it was built from.',
  ' *',
  ' * @module @deepseek-ai/dsh-model-capabilities/snapshot',
  ' */',
  '',
  "import type { ModelCapabilitySnapshot } from '../snapshot.ts'",
  '',
  '/** The bundled snapshot document, exactly as the generator wrote it. */',
  `export const ${SNAPSHOT_EXPORT}: ModelCapabilitySnapshot = `,
].join('\n')

/**
 * Render one snapshot as the generated module's source.
 *
 * The document is emitted as a pretty-printed literal, which is valid
 * TypeScript and keeps a diff line oriented when a capture moves. Only
 * `generatedAt` differs between two writes of the same captures.
 * @param snapshot - the document to render.
 * @returns the module's exact text.
 */
export function renderSnapshotModule(snapshot: ModelCapabilitySnapshot): string {
  return `${GENERATED_BANNER}${renderLiteral(snapshot, 0)}\n`
}

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

function quoteLiteral(value: string): string {
  const body = value.replace(/[\\'\u0000-\u001f\u2028\u2029]/gu, character => (
    STRING_ESCAPES[character]
    ?? `\\u${(character.codePointAt(0) as number).toString(16).padStart(4, '0')}`
  ))
  return `'${body}'`
}

function renderArray(values: readonly unknown[], depth: number): string {
  if (values.length === 0) return '[]'
  const indentation = ' '.repeat(depth + 2)
  const rows = values.map(value => `${indentation}${renderLiteral(value, depth + 2)},`)
  return `[\n${rows.join('\n')}\n${' '.repeat(depth)}]`
}

function renderObject(value: Readonly<Record<string, unknown>>, depth: number): string {
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const indentation = ' '.repeat(depth + 2)
  const rows = entries.map(([key, entry]) => (
    `${indentation}${quoteLiteral(key)}: ${renderLiteral(entry, depth + 2)},`
  ))
  return `{\n${rows.join('\n')}\n${' '.repeat(depth)}}`
}

function renderLiteral(value: unknown, depth: number): string {
  if (typeof value === 'string') return quoteLiteral(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return renderArray(value, depth)
  if (typeof value === 'object') return renderObject(value as Readonly<Record<string, unknown>>, depth)
  throw new TypeError(`model capability snapshot: cannot render ${typeof value}`)
}

/**
 * Read the `generatedAt` a committed module already carries.
 *
 * The generated module has no runtime dependencies, so its document is read as
 * text rather than imported: a check never executes the artifact it verifies.
 * @param path - repository-relative path of the artifact.
 * @returns the recorded timestamp, or undefined when the artifact is absent or states none.
 */
export function committedGeneratedAt(path: string): string | undefined {
  const absolute = resolve(root, path)
  if (!existsSync(absolute)) return undefined
  return /^ {2}'generatedAt': '([^']+)',$/mu.exec(readFileSync(absolute, 'utf8'))?.[1]
}

/**
 * Report the first line two artifacts differ on, so a stale check is actionable.
 * @param committed - the committed artifact's text, when it exists.
 * @param generated - the text this run produced.
 */
function reportDifference(committed: string | undefined, generated: string): void {
  if (committed === undefined) {
    console.error(`gen-model-capability-snapshot: ${SNAPSHOT_PATH} is missing. Run \`pnpm run gen-model-capability-snapshot\`.`)
    return
  }
  const committedLines = committed.split('\n')
  const generatedLines = generated.split('\n')
  const count = Math.max(committedLines.length, generatedLines.length)
  for (let index = 0; index < count; index += 1) {
    if (committedLines[index] === generatedLines[index]) continue
    console.error(`gen-model-capability-snapshot: first difference at line ${index + 1}`)
    console.error(`  committed: ${JSON.stringify(committedLines[index])}`)
    console.error(`  generated: ${JSON.stringify(generatedLines[index])}`)
    return
  }
}

/** CLI entry: default writes the artifact, `--check` verifies the committed one. */
function main(): void {
  const request = parseRequest(process.argv.slice(2))
  const absoluteOutput = resolve(root, request.output)

  if (request.check && request.generatedAt !== undefined) {
    throw new Error('gen-model-capability-snapshot: --generated-at cannot be combined with --check')
  }
  // A check run reuses the committed timestamp, so identical captures produce
  // identical bytes and the gate can never fail on the wall clock.
  const generatedAt = request.check
    ? committedGeneratedAt(request.output) ?? ''
    : request.generatedAt ?? new Date().toISOString()
  if (generatedAt.length === 0) {
    console.error(
      `gen-model-capability-snapshot: ${request.output} is stale against `
      + `${request.modelsDevInput} + ${request.openRouterInput}.`,
    )
    reportDifference(undefined, '')
    console.error('gen-model-capability-snapshot: run `pnpm run gen-model-capability-snapshot` and commit the artifact.')
    process.exitCode = 1
    return
  }

  const built = buildSnapshot(readInputs(request), generatedAt)
  const rendered = renderSnapshotModule(built.snapshot)

  if (!request.check) {
    writeFileSync(absoluteOutput, rendered)
    console.log(
      `gen-model-capability-snapshot: wrote ${request.output} `
      + `(schema ${SNAPSHOT_SCHEMA_VERSION}, ${built.providerCount} models.dev provider(s), `
      + `${built.modelCount} OpenRouter model(s), ${built.skipped} entr(ies) skipped as unusable)`,
    )
    return
  }

  const committed = existsSync(absoluteOutput) ? readFileSync(absoluteOutput, 'utf8') : undefined
  if (committed === rendered) {
    console.log(
      `gen-model-capability-snapshot: ${request.output} is fresh `
      + `(${built.providerCount} models.dev provider(s), ${built.modelCount} OpenRouter model(s), `
      + `generated ${generatedAt})`,
    )
    return
  }
  console.error(
    `gen-model-capability-snapshot: ${request.output} is stale against `
    + `${request.modelsDevInput} + ${request.openRouterInput}.`,
  )
  reportDifference(committed, rendered)
  console.error('gen-model-capability-snapshot: run `pnpm run gen-model-capability-snapshot` and commit the artifact.')
  process.exitCode = 1
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
