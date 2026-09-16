/**
 * The no-escalation invariant: what a definition asks for reaches the child,
 * what the child gets never exceeds its parent, and no delegation argument can
 * widen either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { DELEGATE_TOOL } from '../src/tools.ts'
import {
  bootRoster,
  delegate,
  definition,
  documentOf,
  headerAgent,
  parametersOf,
  text,
} from './harness.ts'
import { bootRealChild } from './real-child.ts'
import type { RealChild } from './real-child.ts'

const WORKSPACES: string[] = []
const BOOTED: RealChild[] = []

beforeEach(async () => {
  WORKSPACES.push(await realpath(await mkdtemp(join(tmpdir(), 'dsh-roster-access-'))))
})

afterEach(async () => {
  for (const booted of BOOTED.splice(0).reverse()) await booted.dispose()
  for (const workspace of WORKSPACES.splice(0)) await rm(workspace, { recursive: true, force: true })
})

/** One workspace created for the current test. */
function workspace(): string {
  const value = WORKSPACES.at(-1)
  if (value === undefined) throw new Error('no workspace was created for this test')
  return value
}

/** Boot a real child composition and register it for teardown. */
async function boot(mode: SandboxMode, access: SandboxMode | 'inherit'): Promise<RealChild> {
  const booted = await bootRealChild({
    workspace: workspace(),
    deploymentMode: mode,
    settings: documentOf([definition({ id: 'review', access })]),
  })
  BOOTED.push(booted)
  return booted
}

describe('access on the start request', () => {
  it.each<SandboxMode | 'inherit'>(['inherit', 'read-only', 'workspace-write', 'danger-full-access'])(
    'carries an %s definition verbatim to the backend',
    async (access) => {
      const roster = await bootRoster({ settings: documentOf([definition({ id: 'code', access })]) })
      const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
      expect(result.isError).toBe(false)
      expect(roster.requests[0]?.sandboxMode).toBe(access)
      await roster.dispose()
    },
  )

  it('is refused loudly by a backend that cannot confine the child', async () => {
    const roster = await bootRoster({
      children: [{ name: 'spawn', capabilities: { accessPolicy: false } }],
      settings: documentOf([definition({ id: 'code', access: 'read-only' })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "accessPolicy" capability')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('starts on a backend without the capability when the definition inherits', async () => {
    const roster = await bootRoster({
      children: [{ name: 'spawn', capabilities: { accessPolicy: false } }],
      settings: documentOf([definition({ id: 'code', access: 'inherit' })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.sandboxMode).toBe('inherit')
    await roster.dispose()
  })
})

describe('access escalation is unrepresentable at the tool boundary', () => {
  it('declares no access, sandbox, or permission parameter', async () => {
    const roster = await bootRoster({ settings: documentOf([definition({ id: 'code', access: 'read-only' })]) })
    const declared = Object.keys(parametersOf(roster.ctx, DELEGATE_TOOL))
    expect(declared).not.toContain('access')
    expect(declared).not.toContain('sandbox_mode')
    expect(declared).not.toContain('sandbox')
    expect(declared).not.toContain('permissions')
    await roster.dispose()
  })

  it('never widens the request for a call that tries to name an access', async () => {
    const roster = await bootRoster({ settings: documentOf([definition({ id: 'code', access: 'read-only' })]) })
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'Work.', access: 'danger-full-access', sandbox_mode: 'danger-full-access' },
      headerAgent(),
    )
    // Extra keys never become access: the definition's value is the only one
    // that reaches the backend, whatever the call carries.
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.sandboxMode).toBe('read-only')
    await roster.dispose()
  })
})

describe('access narrowing on a real child', () => {
  it('confines a read-only definition under a danger-full-access deployment default', async () => {
    const booted = await boot('danger-full-access', 'read-only')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    const child = booted.children[0]
    expect(child).toBeDefined()
    expect(booted.modeOf(child!)).toBe('read-only')
    expect(booted.modeEvents(child!)).toMatchObject([
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
  })

  it('still narrows when the parent carries the wider mode as its own override', async () => {
    const booted = await boot('workspace-write', 'read-only')
    setSandboxMode(booted.parent.session, 'danger-full-access')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    expect(booted.ctx.sandboxPolicy.overrideOf(booted.parent.session)).toBe('danger-full-access')
    expect(booted.modeOf(booted.children[0]!)).toBe('read-only')
  })

  it('narrows a workspace-write deployment default without any parent override', async () => {
    const booted = await boot('workspace-write', 'read-only')
    expect(booted.ctx.sandboxPolicy.overrideOf(booted.parent.session)).toBeUndefined()
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    expect(booted.ctx.sandboxPolicy.overrideOf(booted.parent.session)).toBeUndefined()
    expect(booted.modeOf(booted.children[0]!)).toBe('read-only')
  })

  it('never lets a definition widen the child past its parent', async () => {
    const booted = await boot('read-only', 'danger-full-access')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    expect(booted.modeOf(booted.children[0]!)).toBe('read-only')
  })

  it('keeps the definition inside a narrower parent mode', async () => {
    const booted = await boot('read-only', 'workspace-write')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    expect(booted.modeOf(booted.children[0]!)).toBe('read-only')
  })

  it('reproduces the current behavior for an inheriting definition', async () => {
    const booted = await boot('workspace-write', 'inherit')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    const child = booted.children[0]!
    // No override on the parent, so no delegated mode is recorded at all and the
    // child rides the deployment default exactly as a delegation always did.
    expect(booted.modeEvents(child)).toHaveLength(0)
    expect(booted.modeOf(child)).toBeUndefined()
  })

  it('copies an explicit parent override for an inheriting definition', async () => {
    const booted = await boot('workspace-write', 'inherit')
    setSandboxMode(booted.parent.session, 'danger-full-access')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    expect(booted.modeOf(booted.children[0]!)).toBe('danger-full-access')
  })

  it('pins the child approval policy so its own escalation asks fail closed', async () => {
    const booted = await boot('danger-full-access', 'read-only')
    const result = await delegate(booted, { subagent: 'review', task: 'Review it.' }, booted.parent)
    expect(result.isError).toBe(false)
    const child = booted.children[0]!
    expect(booted.ctx.approval.overrideOf(child)).toBe('never')
    expect(child.snapshotEvents().filter(event => event.type === 'approval/policy')).toMatchObject([
      { data: { policy: 'never', source: 'delegation' } },
    ])
  })
})
