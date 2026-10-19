import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalWorkspaceKey } from '../src/settings.ts'
import { bootRoster, delegate, definition, documentOf, listSubagents, text } from './harness.ts'

it('keeps roster access and instructions at the original project after execution moves', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roster-directory-authority-')))
  const origin = join(root, 'origin')
  const selected = join(root, 'other-project')
  let roster: Awaited<ReturnType<typeof bootRoster>> | undefined
  try {
    await mkdir(origin)
    await mkdir(selected)
    roster = await bootRoster({ settings: documentOf([definition({ id: 'code' })], {
      overrides: {
        [canonicalWorkspaceKey(origin)]: { subagents: { code: {
          name: 'Original project code', instructions: 'Original project instructions.', access: 'read-only',
        } } },
        [canonicalWorkspaceKey(selected)]: { subagents: { code: {
          name: 'Other project code', instructions: 'Other project instructions.', access: 'danger-full-access',
        } } },
      },
    }) })
    provideWorkingDirectoryFixture(roster.ctx)
    const harness = await mountAgentLoopTestHarness(roster.ctx)
    const parent = await harness.create(SessionId('roster-directory-owner'), {}, { cwd: origin })
    await roster.ctx.workingDirectory.set(parent, selected)

    const directory = await listSubagents(roster, parent)
    expect(directory.isError).toBe(false)
    expect(text(directory)).toContain('Original project code')
    expect(text(directory)).not.toContain('Other project code')
    const result = await delegate(roster, { subagent: 'code', task: 'Inspect the fixture.' }, parent)
    expect(result.isError, text(result)).toBe(false)
    expect(roster.requests).toHaveLength(1)
    expect(roster.requests[0]).toMatchObject({
      persona: 'Original project instructions.', sandboxMode: 'read-only',
    })
    expect(parent.session.header.cwd).toBe(origin)
    expect(roster.ctx.workingDirectory.get(parent.session)).toBe(selected)
  } finally {
    try { await roster?.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})
