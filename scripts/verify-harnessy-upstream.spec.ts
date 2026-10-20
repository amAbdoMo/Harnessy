import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildUpstreamInventory,
  parseUpstreamReviewLedger,
  runUpstreamReviewCli,
  verifyUpstreamReviewLedger,
  type UpstreamReview,
  type UpstreamReviewLedger,
} from './verify-harnessy-upstream.ts'

type ReviewFile = UpstreamReview['files'][number]

interface Fixture {
  root: string
  mergeBase: string
  baseline: string
  first: string
  second: string
  side: string
  merge: string
}

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function commitFiles(root: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content)
  git(root, ['add', '--', ...Object.keys(files)])
  git(root, ['commit', '-q', '-m', message])
}

/**
 * Build a repository whose baseline and upstream lines diverged at a merge
 * base, with a genuine merge on the upstream line.
 * @returns the commit ids the fixture is built from.
 */
function createFixture(): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-upstream-review-'))
  fixtureRoots.push(container)
  const root = join(container, 'repo')
  const hooks = join(container, 'hooks')
  mkdirSync(hooks)
  mkdirSync(root)
  git(container, ['init', '-q', '--initial-branch=master', root])
  git(root, ['config', 'user.email', 'upstream-review@example.com'])
  git(root, ['config', 'user.name', 'Upstream Review Tests'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  git(root, ['config', 'core.hooksPath', hooks])

  commitFiles(root, { 'root.txt': 'root\n' }, 'root commit')
  commitFiles(root, { 'base.txt': 'base\n' }, 'baseline commit')

  git(root, ['checkout', '-q', '-b', 'upstream', 'master^'])
  commitFiles(root, { 'u1.txt': 'u1\n', 'u1b.txt': 'u1b\n' }, 'upstream first commit')
  commitFiles(root, { 'u2.txt': 'u2\n' }, 'upstream second commit')

  git(root, ['checkout', '-q', '-b', 'side', 'master^'])
  commitFiles(root, { 's1.txt': 's1\n' }, 'side commit')

  git(root, ['checkout', '-q', 'upstream'])
  git(root, ['merge', '-q', '--no-ff', 'side', '-m', 'merge the side line'])
  git(root, ['checkout', '-q', 'master'])

  const [mergeBase, baseline, first, second, side, merge] = git(root, [
    'rev-parse', 'master^', 'master', 'upstream^^', 'upstream^1', 'upstream^2', 'upstream',
  ]).split('\n').map(line => line.trim())
  return {
    root,
    mergeBase: mergeBase!,
    baseline: baseline!,
    first: first!,
    second: second!,
    side: side!,
    merge: merge!,
  }
}

function adopt(root: string, sha: string, message: string): void {
  git(root, ['checkout', '-q', 'master'])
  git(root, ['merge', '-q', '--no-ff', '-m', message, sha])
}

function inventory(fixture: Fixture): UpstreamReviewLedger {
  return buildUpstreamInventory(fixture.root, fixture.baseline, fixture.merge)
}

const firstFiles: ReviewFile[] = [
  { path: 'u1.txt', disposition: 'adopted', reason: 'the local branch has no equivalent change' },
  { path: 'u1b.txt', disposition: 'adopted', reason: 'the local branch has no equivalent change' },
]
const secondFiles: ReviewFile[] = [
  { path: 'u2.txt', disposition: 'retained-newer', reason: 'the local branch already carries a newer fix' },
]
const sideFiles: ReviewFile[] = [
  { path: 's1.txt', disposition: 'adopted', reason: 'the side line change is wanted' },
]
const mergeFiles: ReviewFile[] = [
  { path: 's1.txt', disposition: 'adopted', reason: 'the merge resolution keeps the side line change' },
]

/**
 * Attach one review to a group of inventory entries.
 * @param ledger - The ledger to extend.
 * @param id - The review id referenced by the group members.
 * @param shas - The inventory entries the review covers.
 * @param files - The file dispositions the review records.
 * @param mergeEvidence - Topology evidence, required for a reviewed merge.
 * @returns the extended ledger.
 */
function applyReview(
  ledger: UpstreamReviewLedger,
  id: string,
  shas: string[],
  files: ReviewFile[],
  mergeEvidence?: string,
): UpstreamReviewLedger {
  const review: UpstreamReview = {
    status: 'adopted',
    summary: `reviewed ${id}`,
    files,
    evidence: [`inspected ${id} against the local branch`],
  }
  return {
    ...ledger,
    entries: ledger.entries.map((entry) => {
      if (!shas.includes(entry.sha)) return entry
      if (mergeEvidence === undefined) return { ...entry, review: id }
      return { ...entry, review: id, mergeEvidence }
    }),
    reviews: { ...ledger.reviews, [id]: review },
  }
}

function fullyReviewed(fixture: Fixture): UpstreamReviewLedger {
  let ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], firstFiles)
  ledger = applyReview(ledger, 'r-second', [fixture.second], secondFiles)
  ledger = applyReview(ledger, 'r-side', [fixture.side], sideFiles)
  ledger = applyReview(ledger, 'r-merge', [fixture.merge], mergeFiles, 'inspected the topology and the conflict resolution')
  ledger.reviewedThrough = fixture.merge
  return ledger
}

// Every case builds a scratch repository and drives the verifier through real
// Git, so the suite is bound by process creation rather than by its
// assertions. A describe value grants every case in this file the same
// allowance instead of the default per-test budget.
describe('verify-harnessy-upstream', { timeout: 30_000 }, () => {
  it('rejects a baseline outside HEAD instead of shrinking the unreviewed inventory', () => {
    const fixture = createFixture()
    const ledger = buildUpstreamInventory(fixture.root, fixture.merge, fixture.merge)
    ledger.reviewedThrough = fixture.mergeBase
    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger))
      .toThrow(/baseline head .* is not an ancestor of HEAD/)
  })

  it('rejects an excluded review that still claims adopted paths', () => {
    const fixture = createFixture()
    const ledger = fullyReviewed(fixture)
    ledger.reviews['r-first']!.status = 'reviewed-excluded'
    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger, { checkpointSha: fixture.merge }))
      .toThrow(/excluded review .* records a non-excluded path/)
  })

  it.each(['summary', 'evidence'] as const)('rejects whitespace-only review %s', (field) => {
    const fixture = createFixture()
    const ledger = fullyReviewed(fixture)
    if (field === 'summary') ledger.reviews['r-first']!.summary = ' '
    else ledger.reviews['r-first']!.evidence = [' ']
    expect(() => parseUpstreamReviewLedger(JSON.stringify(ledger))).toThrow(/non-blank/)
  })

  it('rejects unknown ledger fields instead of silently discarding them', () => {
    const fixture = createFixture()
    expect(() => parseUpstreamReviewLedger(JSON.stringify({ ...inventory(fixture), reviewedCount: 100 })))
      .toThrow(/Unrecognized key/)
  })

  it('rejects reviewed ancestry acquired beyond the declared integrated checkpoint', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'integrate the full reviewed upstream')
    const ledger = fullyReviewed(fixture)
    ledger.reviewedThrough = fixture.second
    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger))
      .toThrow(/acquired upstream commit .* is outside the reviewed-through closure/)
  })

  it('rejects a proposal that omits already acquired reviewed ancestry', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'integrate the full reviewed upstream')
    expect(() => verifyUpstreamReviewLedger(fixture.root, fullyReviewed(fixture), { checkpointSha: fixture.second }))
      .toThrow(/acquired upstream commit .* is outside the proposed checkpoint closure/)
  })

  it('accepts a fully reviewed checkpoint whose reviewed commits are integrated', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.second, 'adopt the reviewed upstream commits')
    const ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], firstFiles)
    const reviewed = applyReview(ledger, 'r-second', [fixture.second], secondFiles)
    reviewed.reviewedThrough = fixture.second

    const report = verifyUpstreamReviewLedger(fixture.root, reviewed)

    expect(report.counts).toEqual({
      inventory: 4,
      reviewed: 2,
      unreviewed: 2,
      closureSize: 2,
      checkpointClosureSize: null,
    })
    expect(report.reviewedThrough).toBe(fixture.second)
    expect(report.mergeBase).toBe(fixture.mergeBase)
    expect(report.head.behindPinnedTip).toBe(2)
  })

  it('rejects an ancestor of the reviewed-through commit that carries no review', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.second, 'adopt the reviewed upstream commits')
    const ledger = applyReview(inventory(fixture), 'r-second', [fixture.second], secondFiles)
    ledger.reviewedThrough = fixture.second

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger))
      .toThrow(/is an ancestor of the reviewed-through commit .* but has no review/)
  })

  it('rejects an inventory commit the ledger dropped', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const dropped: UpstreamReviewLedger = {
      ...ledger,
      entries: ledger.entries.filter(entry => entry.sha !== fixture.side),
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, dropped)).toThrow(/has no ledger entry/)
  })

  it('rejects a duplicated ledger entry', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const duplicated: UpstreamReviewLedger = {
      ...ledger,
      entries: [...ledger.entries, ledger.entries[0]!],
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, duplicated)).toThrow(/appears more than once/)
  })

  it('rejects a ledger entry that records the wrong tree', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const wrongTree: UpstreamReviewLedger = {
      ...ledger,
      entries: ledger.entries.map(entry => entry.sha === fixture.first ? { ...entry, tree: '0'.repeat(40) } : entry),
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, wrongTree)).toThrow(/records tree .* but Git reports/)
  })

  it('rejects a ledger entry that records the parents in the wrong order', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const wrongParents: UpstreamReviewLedger = {
      ...ledger,
      entries: ledger.entries.map(entry => entry.sha === fixture.merge
        ? { ...entry, parents: [fixture.side, fixture.second] }
        : entry),
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, wrongParents)).toThrow(/records parents .* but Git reports/)
  })

  it('rejects an entry that references an unknown review', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const unknown: UpstreamReviewLedger = {
      ...ledger,
      entries: ledger.entries.map(entry => entry.sha === fixture.first ? { ...entry, review: 'r-missing' } : entry),
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, unknown)).toThrow(/references the unknown review r-missing/)
  })

  it('rejects a review that no ledger entry references', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const orphan: UpstreamReviewLedger = {
      ...ledger,
      reviews: {
        ...ledger.reviews,
        'r-orphan': { status: 'reviewed-excluded', summary: 'unused', files: [], evidence: ['unused'] },
      },
    }

    expect(() => verifyUpstreamReviewLedger(fixture.root, orphan)).toThrow(/review r-orphan is not referenced by any ledger entry/)
  })

  it('rejects a review that leaves a changed path uncovered', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const partial: ReviewFile[] = [
      { path: 'u1.txt', disposition: 'adopted', reason: 'only the first hunk was inspected' },
    ]
    const ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], partial)

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/does not cover the changed path u1b\.txt/)
  })

  it('rejects a review that records a path no associated commit changed', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const extra: ReviewFile[] = [
      { path: 'u2.txt', disposition: 'adopted', reason: 'adopted' },
      { path: 'ghost.txt', disposition: 'excluded', reason: 'never existed' },
    ]
    const ledger = applyReview(inventory(fixture), 'r-second', [fixture.second], extra)

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/records the path ghost\.txt that no associated commit changed/)
  })

  it('rejects a review that lists one path twice', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const repeated: ReviewFile[] = [
      { path: 'u2.txt', disposition: 'adopted', reason: 'adopted' },
      { path: 'u2.txt', disposition: 'excluded', reason: 'excluded' },
    ]
    const ledger = applyReview(inventory(fixture), 'r-second', [fixture.second], repeated)

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/lists the path u2\.txt more than once/)
  })

  it('rejects a reviewed merge that records no merge evidence', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = applyReview(inventory(fixture), 'r-merge', [fixture.merge], mergeFiles)
    ledger.reviewedThrough = fixture.merge

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/the reviewed merge .* has no mergeEvidence/)
  })

  it('rejects a reviewed merge whose side ancestor carries no review', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.second, 'adopt the reviewed upstream commits')
    let ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], firstFiles)
    ledger = applyReview(ledger, 'r-second', [fixture.second], secondFiles)
    ledger = applyReview(ledger, 'r-merge', [fixture.merge], mergeFiles, 'inspected the topology')
    ledger.reviewedThrough = fixture.second

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/has the unreviewed side ancestor/)
  })

  it('reports a reviewed checkpoint that is not integrated and accepts it as a proposal', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.second, 'adopt the reviewed upstream commits')
    const ledger = fullyReviewed(fixture)

    expect(gitSucceeds(fixture.root, ['merge-base', '--is-ancestor', fixture.merge, 'HEAD'])).toBe(false)
    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger)).toThrow(/is not an ancestor of HEAD/)

    const report = verifyUpstreamReviewLedger(fixture.root, ledger, { checkpointSha: fixture.merge })

    expect(report.checkpoint).toBe(fixture.merge)
    expect(report.counts.checkpointClosureSize).toBe(4)
    expect(report.counts.reviewed).toBe(4)
  })

  it('rejects a checkpoint whose closure still has an unreviewed commit', () => {
    const fixture = createFixture()
    const ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], firstFiles)
    ledger.reviewedThrough = fixture.first

    expect(() => verifyUpstreamReviewLedger(fixture.root, ledger, { checkpointSha: fixture.merge }))
      .toThrow(/checkpoint ancestor .* has no review/)
  })

  it('rejects an unreviewed commit that HEAD already acquired', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = applyReview(inventory(fixture), 'r-first', [fixture.first], firstFiles)
    const reviewed = applyReview(ledger, 'r-second', [fixture.second], secondFiles)
    reviewed.reviewedThrough = fixture.second

    expect(() => verifyUpstreamReviewLedger(fixture.root, reviewed)).toThrow(/is already an ancestor of HEAD/)
  })

  it('accepts a genuine merge whose side ancestors are reviewed too', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)

    const report = verifyUpstreamReviewLedger(fixture.root, ledger)

    expect(report.counts).toEqual({
      inventory: 4,
      reviewed: 4,
      unreviewed: 0,
      closureSize: 4,
      checkpointClosureSize: null,
    })
    expect(report.head.behindPinnedTip).toBe(0)
  })

  it('rejects a merge base that disagrees with Git', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledger = fullyReviewed(fixture)
    const wrongMergeBase: UpstreamReviewLedger = { ...ledger, mergeBase: fixture.baseline }

    expect(() => verifyUpstreamReviewLedger(fixture.root, wrongMergeBase)).toThrow(/is not a merge base of/)
  })

  it('rejects a ledger whose review omits the summary or the evidence', () => {
    const fixture = createFixture()
    const ledger = fullyReviewed(fixture)
    const broken = JSON.stringify({
      ...ledger,
      reviews: { 'r-first': { ...ledger.reviews['r-first'], evidence: [] } },
    })

    expect(() => parseUpstreamReviewLedger(broken)).toThrow(/does not match schema version 1/)
  })

  it('creates an all-unreviewed inventory and refuses to overwrite an existing ledger', () => {
    const fixture = createFixture()
    const outputPath = join(fixture.root, 'ledger.json')

    const written = runUpstreamReviewCli([
      '--repo', fixture.root,
      '--inventory',
      '--baseline', fixture.baseline,
      '--upstream', fixture.merge,
      '--output', outputPath,
    ], fixture.root)

    expect(written).toContain('4 unreviewed inventory entries')
    const ledger = parseUpstreamReviewLedger(readFileSync(outputPath, 'utf8'))
    expect(ledger.reviewedThrough).toBe(fixture.mergeBase)
    expect(ledger.mergeBase).toBe(fixture.mergeBase)
    expect(ledger.entries.map(entry => entry.review)).toEqual([null, null, null, null])
    expect(ledger.reviews).toEqual({})

    expect(() => runUpstreamReviewCli([
      '--repo', fixture.root,
      '--inventory',
      '--baseline', fixture.baseline,
      '--upstream', fixture.merge,
      '--output', outputPath,
    ], fixture.root)).toThrow(/refusing to overwrite the existing review ledger/)
  })

  it('verifies a ledger through the command line', () => {
    const fixture = createFixture()
    adopt(fixture.root, fixture.merge, 'adopt the whole upstream line')
    const ledgerPath = join(fixture.root, 'ledger.json')
    writeFileSync(ledgerPath, `${JSON.stringify(fullyReviewed(fixture), null, 2)}\n`)

    const output = runUpstreamReviewCli(['--repo', fixture.root, '--ledger', ledgerPath], fixture.root)

    const report = JSON.parse(output) as { counts: { reviewed: number; unreviewed: number } }
    expect(report.counts.reviewed).toBe(4)
    expect(report.counts.unreviewed).toBe(0)
  })
})
