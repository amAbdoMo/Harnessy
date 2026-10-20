/**
 * Verify the Harnessy upstream review ledger.
 *
 * The ledger records which upstream commits were reviewed, which files each
 * review covered, and how far the review reached. This module checks that
 * record mechanically: the inventory matches Git, every reviewed commit's
 * changed paths carry an explicit disposition, and the reviewed closure is the
 * closure the branch actually carries. It never judges whether a human review
 * was correct, and it never merges, rebases, or rewrites anything.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'

/** Ledger format version understood by this module. */
const SCHEMA_VERSION = 1

/** Ledger path, relative to the repository, used when `--ledger` is absent. */
const DEFAULT_LEDGER_PATH = 'scripts/harnessy-upstream-review.json'

/** Upper bound for a single Git response; the upstream inventory is large. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

/** Full 40-character lowercase hexadecimal commit id. */
const SHA_PATTERN = /^[0-9a-f]{40}$/u

const shaSchema = z.string().regex(SHA_PATTERN, 'expected a full 40-character lowercase hexadecimal commit id')
const reviewTextSchema = z.string().refine(value => value.trim().length > 0, 'expected non-blank review text')

/** One file disposition recorded by a review. */
const reviewFileSchema = z.strictObject({
  path: z.string().min(1),
  disposition: z.enum(['adopted', 'retained-newer', 'excluded']),
  reason: reviewTextSchema,
})

/** One review record: a group of inventory entries reviewed together. */
const reviewSchema = z.strictObject({
  status: z.enum(['adopted', 'reviewed-excluded']),
  summary: reviewTextSchema,
  files: z.array(reviewFileSchema),
  evidence: z.array(reviewTextSchema).min(1),
})

/** One inventory entry: the recorded metadata of a single upstream commit. */
const entrySchema = z.strictObject({
  sha: shaSchema,
  parents: z.array(shaSchema),
  tree: shaSchema,
  subject: z.string(),
  review: reviewTextSchema.nullable(),
  mergeEvidence: reviewTextSchema.optional(),
})

/** The reviewed-upstream ledger document. */
export const upstreamReviewLedgerSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  baselineHead: shaSchema,
  upstreamTip: shaSchema,
  mergeBase: shaSchema,
  reviewedThrough: shaSchema,
  entries: z.array(entrySchema),
  reviews: z.record(reviewTextSchema, reviewSchema),
})

/** The ledger document after schema validation. */
export type UpstreamReviewLedger = z.infer<typeof upstreamReviewLedgerSchema>

/** One inventory entry after schema validation. */
export type UpstreamReviewEntry = z.infer<typeof entrySchema>

/** One review record after schema validation. */
export type UpstreamReview = z.infer<typeof reviewSchema>

/** Options that narrow what a verification run asserts. */
export interface UpstreamVerifyOptions {
  /**
   * Proposed upstream checkpoint whose whole ancestry closure must already be
   * reviewed. The checkpoint is validated as a proposal; it is never treated
   * as integrated ancestry.
   */
  checkpointSha?: string
}

/** The mechanical result of one verification run. */
export interface UpstreamVerifyReport {
  schemaVersion: typeof SCHEMA_VERSION
  baselineHead: string
  upstreamTip: string
  mergeBase: string
  reviewedThrough: string
  checkpoint: string | null
  counts: {
    /** Commits in `baselineHead..upstreamTip`. */
    inventory: number
    /** Inventory entries that carry a review. */
    reviewed: number
    /** Inventory entries that carry no review. */
    unreviewed: number
    /** Commits in `baselineHead..reviewedThrough`. */
    closureSize: number
    /** Commits in `baselineHead..checkpoint`; null outside checkpoint runs. */
    checkpointClosureSize: number | null
  }
  head: {
    sha: string
    /** Commits the current HEAD is behind the pinned upstream tip. */
    behindPinnedTip: number
  }
}

/** The parsed command line of the review verifier. */
export type UpstreamReviewCliOptions =
  | { mode: 'inventory'; repoDir: string; baselineSha: string; upstreamRef: string; outputPath: string }
  | { mode: 'verify'; repoDir: string; ledgerPath: string; checkpointSha?: string }

/** Git metadata for one commit. */
interface CommitMetadata {
  sha: string
  parents: string[]
  tree: string
  subject: string
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

function gitFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const failure = error as Error & { stderr?: string | Buffer }
  const stderr = failure.stderr
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
  if (Buffer.isBuffer(stderr) && stderr.toString('utf8').trim() !== '') return stderr.toString('utf8').trim()
  return failure.message
}

function gitFailureStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  const failure = error as Error & { status?: number }
  return typeof failure.status === 'number' ? failure.status : undefined
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Run one read-only Git command in an explicit repository directory.
 * @param repoDir - Directory whose containing Git worktree is inspected.
 * @param args - Git arguments; no shell is involved.
 * @param context - Failure context reported when Git fails.
 * @returns the command's standard output.
 */
function git(repoDir: string, args: string[], context: string): string {
  try {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`${context}: ${gitFailureDetail(error)}`)
  }
}

function assertGitWorktree(repoDir: string): void {
  git(repoDir, ['rev-parse', '--git-dir'], `${repoDir} is not a Git repository`)
}

function resolveCommit(repoDir: string, ref: string, label: string): string {
  const output = git(repoDir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], `cannot resolve the ${label} commit ${ref}`)
  const sha = output.trim()
  if (!SHA_PATTERN.test(sha)) throw new Error(`the ${label} commit ${ref} did not resolve to a commit id`)
  return sha
}

function revList(repoDir: string, range: string, context: string): string[] {
  const output = git(repoDir, ['rev-list', range], `cannot list ${context}`)
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

function commitMetadata(repoDir: string, range: string, context: string): Map<string, CommitMetadata> {
  const output = git(repoDir, ['log', '-z', '--format=%H%x00%T%x00%P%x00%s', range], `cannot read the commit metadata of ${context}`)
  const fields = output.split('\0')
  const metadata = new Map<string, CommitMetadata>()
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = fields[index] ?? ''
    const tree = fields[index + 1] ?? ''
    const parents = fields[index + 2] ?? ''
    const subject = fields[index + 3] ?? ''
    metadata.set(sha, {
      sha,
      tree,
      parents: parents === '' ? [] : parents.split(' '),
      subject,
    })
  }
  return metadata
}

/**
 * List the paths a commit changed against its first parent.
 * @param repoDir - Directory whose containing Git worktree is inspected.
 * @param sha - Commit whose delta is read.
 * @param parents - The commit's ordered parents.
 * @returns the changed paths; a merge contributes only its first-parent delta.
 */
function changedPaths(repoDir: string, sha: string, parents: string[]): string[] {
  const firstParent = parents[0]
  const args = firstParent === undefined
    ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', sha]
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', firstParent, sha]
  const output = git(repoDir, args, `cannot read the changed paths of ${sha}`)
  return output.split('\0').filter(path => path !== '')
}

function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoDir,
      stdio: 'ignore',
      windowsHide: true,
    })
    return true
  } catch (error) {
    const status = gitFailureStatus(error)
    if (status === 1) return false
    throw new Error(`cannot compare ${ancestor} and ${descendant}: ${gitFailureDetail(error)}`)
  }
}

function mergeBases(repoDir: string, baseline: string, upstreamTip: string): string[] {
  const output = git(repoDir, ['merge-base', '--all', baseline, upstreamTip], 'cannot resolve the merge base')
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(part => String(part)).join('.') : '(root)'
    return `${path}: ${issue.message}`
  }).join('; ')
}

/**
 * Parse and validate a reviewed-upstream ledger document.
 * @param raw - The ledger's JSON text.
 * @returns the validated ledger.
 * @throws Error when the text is not JSON or does not match the schema.
 */
export function parseUpstreamReviewLedger(raw: string): UpstreamReviewLedger {
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`the review ledger is not valid JSON: ${message}`)
  }
  const result = upstreamReviewLedgerSchema.safeParse(document)
  if (!result.success) {
    throw new Error(`the review ledger does not match schema version ${SCHEMA_VERSION}: ${formatIssues(result.error)}`)
  }
  return result.data
}

/**
 * Build an all-unreviewed inventory of the upstream commits that are missing
 * from the baseline.
 * @param repoDir - Directory whose containing Git worktree is inspected.
 * @param baselineSha - The pinned baseline head.
 * @param upstreamTipSha - The pinned upstream tip.
 * @returns a ledger whose entries are all unreviewed and whose reviewed-through
 * commit is the merge base.
 * @throws Error when the range, the merge base, or the commit metadata cannot be read.
 */
export function buildUpstreamInventory(repoDir: string, baselineSha: string, upstreamTipSha: string): UpstreamReviewLedger {
  const repo = resolve(repoDir)
  assertGitWorktree(repo)
  const baseline = resolveCommit(repo, baselineSha, 'baseline head')
  const upstreamTip = resolveCommit(repo, upstreamTipSha, 'upstream tip')
  const bases = mergeBases(repo, baseline, upstreamTip)
  if (bases.length !== 1) {
    throw new Error(`${baseline} and ${upstreamTip} have ${bases.length} merge bases; expected exactly one`)
  }
  const mergeBase = requireValue(bases[0], 'the merge base is missing')
  const range = `${baseline}..${upstreamTip}`
  const inventory = revList(repo, range, `the upstream inventory ${range}`)
  const metadata = commitMetadata(repo, range, `the upstream inventory ${range}`)
  const entries = inventory.map((sha) => {
    const actual = requireValue(metadata.get(sha), `commit ${sha} has no metadata in ${range}`)
    return { sha, parents: actual.parents, tree: actual.tree, subject: actual.subject, review: null }
  })
  return {
    schemaVersion: SCHEMA_VERSION,
    baselineHead: baseline,
    upstreamTip,
    mergeBase,
    reviewedThrough: mergeBase,
    entries,
    reviews: {},
  }
}

/**
 * Verify a reviewed-upstream ledger against a repository.
 *
 * The checks are mechanical: inventory membership and metadata, review
 * references, per-review path coverage, merge evidence, the reviewed closure,
 * and the ancestry the current HEAD actually carries. They are not evidence
 * that the recorded review was correct.
 * @param repoDir - Directory whose containing Git worktree is inspected.
 * @param ledger - The validated ledger document.
 * @param options - Optional checkpoint whose closure must be fully reviewed.
 * @returns the counts and ancestry facts the run established.
 * @throws Error on the first violated invariant.
 */
export function verifyUpstreamReviewLedger(
  repoDir: string,
  ledger: UpstreamReviewLedger,
  options: UpstreamVerifyOptions = {},
): UpstreamVerifyReport {
  const repo = resolve(repoDir)
  assertGitWorktree(repo)

  const baseline = resolveCommit(repo, ledger.baselineHead, 'baseline head')
  const upstreamTip = resolveCommit(repo, ledger.upstreamTip, 'upstream tip')
  const mergeBase = resolveCommit(repo, ledger.mergeBase, 'merge base')
  const reviewedThrough = resolveCommit(repo, ledger.reviewedThrough, 'reviewed-through')

  const head = resolveCommit(repo, 'HEAD', 'HEAD')
  if (!isAncestor(repo, baseline, head)) {
    throw new Error(`the baseline head ${baseline} is not an ancestor of HEAD ${head}`)
  }
  const bases = mergeBases(repo, baseline, upstreamTip)
  if (!bases.includes(mergeBase)) {
    throw new Error(`the recorded merge base ${mergeBase} is not a merge base of ${baseline} and ${upstreamTip}`)
  }
  if (!isAncestor(repo, mergeBase, baseline)) {
    throw new Error(`the merge base ${mergeBase} is not an ancestor of the baseline head ${baseline}`)
  }
  if (!isAncestor(repo, mergeBase, upstreamTip)) {
    throw new Error(`the merge base ${mergeBase} is not an ancestor of the upstream tip ${upstreamTip}`)
  }
  if (!isAncestor(repo, reviewedThrough, upstreamTip)) {
    throw new Error(`the reviewed-through commit ${reviewedThrough} is not an ancestor of the upstream tip ${upstreamTip}`)
  }

  const range = `${baseline}..${upstreamTip}`
  const inventory = revList(repo, range, `the upstream inventory ${range}`)
  const inventorySet = new Set(inventory)
  const metadata = commitMetadata(repo, range, `the upstream inventory ${range}`)

  const entriesBySha = new Map<string, UpstreamReviewEntry>()
  for (const entry of ledger.entries) {
    if (entriesBySha.has(entry.sha)) throw new Error(`ledger entry ${entry.sha} appears more than once`)
    if (!inventorySet.has(entry.sha)) throw new Error(`ledger entry ${entry.sha} is not part of ${range}`)
    entriesBySha.set(entry.sha, entry)
  }
  for (const sha of inventory) {
    if (!entriesBySha.has(sha)) throw new Error(`inventory commit ${sha} has no ledger entry`)
  }

  for (const entry of ledger.entries) {
    const actual = metadata.get(entry.sha)
    if (actual === undefined) throw new Error(`ledger entry ${entry.sha} has no commit metadata in ${range}`)
    if (actual.tree !== entry.tree) {
      throw new Error(`ledger entry ${entry.sha} records tree ${entry.tree} but Git reports ${actual.tree}`)
    }
    const parentsMatch = actual.parents.length === entry.parents.length
      && actual.parents.every((parent, index) => parent === entry.parents[index])
    if (!parentsMatch) {
      throw new Error(`ledger entry ${entry.sha} records parents ${entry.parents.join(' ')} but Git reports ${actual.parents.join(' ')}`)
    }
    if (actual.subject !== entry.subject) {
      const recorded = JSON.stringify(entry.subject)
      const reported = JSON.stringify(actual.subject)
      throw new Error(`ledger entry ${entry.sha} records subject ${recorded} but Git reports ${reported}`)
    }
  }

  const reviewTable = new Map<string, UpstreamReview>()
  for (const [id, review] of Object.entries(ledger.reviews)) reviewTable.set(id, review)

  const groupMembers = new Map<string, string[]>()
  for (const entry of ledger.entries) {
    if (entry.review === null) continue
    if (!reviewTable.has(entry.review)) {
      throw new Error(`ledger entry ${entry.sha} references the unknown review ${entry.review}`)
    }
    const members = groupMembers.get(entry.review)
    if (members === undefined) groupMembers.set(entry.review, [entry.sha])
    else members.push(entry.sha)
  }
  for (const id of reviewTable.keys()) {
    if (!groupMembers.has(id)) throw new Error(`review ${id} is not referenced by any ledger entry`)
  }

  for (const [id, members] of groupMembers) {
    const review = requireValue(reviewTable.get(id), `review ${id} is missing`)
    if (review.status === 'reviewed-excluded' && review.files.some(file => file.disposition !== 'excluded')) {
      throw new Error(`excluded review ${id} records a non-excluded path`)
    }
    const recordedPaths = review.files.map(file => file.path)
    const duplicate = recordedPaths.find((path, index) => recordedPaths.indexOf(path) !== index)
    if (duplicate !== undefined) throw new Error(`review ${id} lists the path ${duplicate} more than once`)
    const recorded = new Set(recordedPaths)
    const changed = new Set<string>()
    for (const sha of members) {
      const entry = requireValue(entriesBySha.get(sha), `ledger entry ${sha} is missing`)
      for (const path of changedPaths(repo, sha, entry.parents)) changed.add(path)
    }
    for (const path of changed) {
      if (!recorded.has(path)) throw new Error(`review ${id} does not cover the changed path ${path}`)
    }
    for (const path of recordedPaths) {
      if (!changed.has(path)) throw new Error(`review ${id} records the path ${path} that no associated commit changed`)
    }
  }

  for (const entry of ledger.entries) {
    if (entry.parents.length > 1 && entry.review !== null && entry.mergeEvidence === undefined) {
      throw new Error(`the reviewed merge ${entry.sha} has no mergeEvidence`)
    }
  }

  const closure = revList(repo, `${baseline}..${reviewedThrough}`, `the reviewed closure ${baseline}..${reviewedThrough}`)
  for (const sha of closure) {
    const entry = entriesBySha.get(sha)
    if (entry === undefined) {
      throw new Error(`commit ${sha} is an ancestor of the reviewed-through commit ${reviewedThrough} but is not in the inventory`)
    }
    if (entry.review === null) {
      throw new Error(`commit ${sha} is an ancestor of the reviewed-through commit ${reviewedThrough} but has no review`)
    }
  }

  for (const entry of ledger.entries) {
    if (entry.parents.length < 2 || entry.review === null) continue
    const firstParent = requireValue(entry.parents[0], `merge ${entry.sha} has no first parent`)
    const side = revList(repo, `${firstParent}..${entry.sha}`, `the side ancestors of ${entry.sha}`)
    for (const sha of side) {
      if (sha === entry.sha || !inventorySet.has(sha)) continue
      const sideEntry = requireValue(entriesBySha.get(sha), `ledger entry ${sha} is missing`)
      if (sideEntry.review === null) {
        throw new Error(`the reviewed merge ${entry.sha} has the unreviewed side ancestor ${sha}`)
      }
    }
  }

  const headAncestors = new Set(revList(repo, 'HEAD', 'the HEAD history'))
  for (const entry of ledger.entries) {
    if (entry.review !== null) continue
    if (headAncestors.has(entry.sha)) {
      throw new Error(`the unreviewed commit ${entry.sha} is already an ancestor of HEAD ${head}`)
    }
  }

  if (options.checkpointSha === undefined && !headAncestors.has(reviewedThrough)) {
    throw new Error(`the reviewed-through commit ${reviewedThrough} is not an ancestor of HEAD ${head}`)
  }

  let checkpoint: string | null = null
  let checkpointClosure: string[] | null = null
  if (options.checkpointSha !== undefined) {
    checkpoint = resolveCommit(repo, options.checkpointSha, 'checkpoint')
    if (!isAncestor(repo, checkpoint, upstreamTip)) {
      throw new Error(`the checkpoint ${checkpoint} is not an ancestor of the upstream tip ${upstreamTip}`)
    }
    checkpointClosure = revList(repo, `${baseline}..${checkpoint}`, `the checkpoint closure ${baseline}..${checkpoint}`)
    for (const sha of checkpointClosure) {
      const entry = entriesBySha.get(sha)
      if (entry === undefined) throw new Error(`checkpoint ancestor ${sha} is not in the inventory`)
      if (entry.review === null) throw new Error(`checkpoint ancestor ${sha} has no review`)
    }
  }

  const reviewedCount = [...groupMembers.values()].reduce((total, members) => total + members.length, 0)
  const behindPinnedTip = revList(repo, `HEAD..${upstreamTip}`, 'the commits between HEAD and the pinned upstream tip').length
  return {
    schemaVersion: SCHEMA_VERSION,
    baselineHead: baseline,
    upstreamTip,
    mergeBase,
    reviewedThrough,
    checkpoint,
    counts: {
      inventory: inventory.length,
      reviewed: reviewedCount,
      unreviewed: inventory.length - reviewedCount,
      closureSize: closure.length,
      checkpointClosureSize: checkpointClosure === null ? null : checkpointClosure.length,
    },
    head: {
      sha: head,
      behindPinnedTip,
    },
  }
}

/**
 * Parse the command line of the review verifier.
 * @param args - Command-line arguments after the script path.
 * @param cwd - Directory that relative paths resolve against.
 * @returns the parsed options.
 * @throws Error on an unknown option or an incomplete option combination.
 */
export function parseUpstreamReviewCliArgs(args: string[], cwd: string): UpstreamReviewCliOptions {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      ledger: { type: 'string' },
      checkpoint: { type: 'string' },
      inventory: { type: 'boolean' },
      baseline: { type: 'string' },
      upstream: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  })
  const repoDir = resolve(values.repo ?? cwd)
  if (values.inventory === true) {
    if (values.checkpoint !== undefined) throw new Error('--checkpoint cannot be combined with --inventory')
    if (values.baseline === undefined) throw new Error('--inventory requires --baseline <sha>')
    if (values.upstream === undefined) throw new Error('--inventory requires --upstream <ref>')
    if (values.output === undefined) throw new Error('--inventory requires --output <path>')
    return {
      mode: 'inventory',
      repoDir,
      baselineSha: values.baseline,
      upstreamRef: values.upstream,
      outputPath: resolve(repoDir, values.output),
    }
  }
  if (values.baseline !== undefined || values.upstream !== undefined || values.output !== undefined) {
    throw new Error('--baseline, --upstream, and --output apply only to --inventory')
  }
  const ledgerPath = resolve(repoDir, values.ledger ?? DEFAULT_LEDGER_PATH)
  if (values.checkpoint !== undefined) {
    return { mode: 'verify', repoDir, ledgerPath, checkpointSha: values.checkpoint }
  }
  return { mode: 'verify', repoDir, ledgerPath }
}

function writeLedgerExclusive(path: string, payload: string): void {
  try {
    writeFileSync(path, payload, { flag: 'wx' })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`refusing to overwrite the existing review ledger at ${path}`)
    }
    throw error
  }
}

/**
 * Run the review verifier and render its result.
 * @param args - Command-line arguments after the script path.
 * @param cwd - Directory that relative paths resolve against.
 * @returns the text written to standard output.
 * @throws Error on an invalid ledger, a violated invariant, or a failed write.
 */
export function runUpstreamReviewCli(args: string[], cwd: string): string {
  const options = parseUpstreamReviewCliArgs(args, cwd)
  if (options.mode === 'inventory') {
    const ledger = buildUpstreamInventory(options.repoDir, options.baselineSha, options.upstreamRef)
    const payload = `${JSON.stringify(ledger, null, 2)}\n`
    writeLedgerExclusive(options.outputPath, payload)
    return `wrote ${options.outputPath} with ${ledger.entries.length} unreviewed inventory entries\n`
  }
  let raw: string
  try {
    raw = readFileSync(options.ledgerPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the review ledger at ${options.ledgerPath}: ${gitFailureDetail(error)}`)
  }
  const ledger = parseUpstreamReviewLedger(raw)
  const verifyOptions: UpstreamVerifyOptions = {}
  if (options.checkpointSha !== undefined) verifyOptions.checkpointSha = options.checkpointSha
  const report = verifyUpstreamReviewLedger(options.repoDir, ledger, verifyOptions)
  return `${JSON.stringify(report, null, 2)}\n`
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(runUpstreamReviewCli(process.argv.slice(2), process.cwd()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`verify-harnessy-upstream: ${message}\n`)
    process.exitCode = 1
  }
}
