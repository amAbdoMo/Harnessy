/**
 * What the parent reads and what the child receives: the directory projection,
 * its rendered text, and the standing instructions and scoping one definition
 * contributes to the child it starts.
 */

import { describe, expect, it } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { renderSubagentDirectory, subagentDirectory } from '../src/directory.ts'
import { subagentRosterView } from '../src/settings.ts'
import {
  bootRoster,
  delegate,
  definition,
  documentOf,
  headerAgent,
  listSubagents,
  text,
} from './harness.ts'

describe('subagentDirectory', () => {
  it('projects every enabled definition and omits every disabled one', () => {
    const entries = subagentDirectory(subagentRosterView(documentOf([
      definition({ id: 'code', name: 'Code', purpose: 'Write code.' }),
      definition({ id: 'retired', enabled: false }),
    ]), null))
    expect(entries).toEqual([{
      id: 'code',
      name: 'Code',
      purpose: 'Write code.',
      whenToUse: '',
      invocation: 'automatic',
      model: 'inherit',
      access: 'inherit',
      background: 'foreground',
    }])
  })

  it('reports an exact route with its effort, and inherit without either', () => {
    const entries = subagentDirectory(subagentRosterView(documentOf([
      definition({
        id: 'code',
        model: { mode: 'fixed', route: { provider: 'alpha', model: 'small', reasoningEffort: 'high' } },
      }),
      definition({ id: 'review', model: { mode: 'fixed', route: { provider: 'beta', model: 'large' } } }),
    ]), null))
    expect(entries[0]).toMatchObject({ model: 'alpha/small', reasoningEffort: 'high' })
    expect(entries[1]?.model).toBe('beta/large')
    expect(entries[1]).not.toHaveProperty('reasoningEffort')
  })

  it('carries the invocation, access, and schedule the parent must respect', () => {
    const entries = subagentDirectory(subagentRosterView(documentOf([
      definition({
        id: 'code',
        invocation: 'ask-first',
        access: 'workspace-write',
        execution: { backend: 'spawn', background: 'background' },
      }),
    ]), null))
    expect(entries[0]).toMatchObject({
      invocation: 'ask-first', access: 'workspace-write', background: 'background',
    })
  })
})

describe('renderSubagentDirectory', () => {
  it('says so when nothing is enabled', () => {
    expect(renderSubagentDirectory([])).toBe('(no subagents are enabled for this workspace)')
  })

  it('renders one line per role with and without routing guidance', () => {
    const rendered = renderSubagentDirectory(subagentDirectory(subagentRosterView(documentOf([
      definition({
        id: 'code',
        name: 'Code',
        purpose: 'Write code.',
        whenToUse: 'Use for a bounded edit.',
        model: { mode: 'fixed', route: { provider: 'alpha', model: 'small', reasoningEffort: 'high' } },
        access: 'workspace-write',
        execution: { backend: 'spawn', background: 'auto' },
      }),
      definition({ id: 'review', name: 'Review', purpose: 'Review code.' }),
    ]), null)))
    expect(rendered.split('\n')).toEqual([
      'code — Code (invocation automatic, access workspace-write, model alpha/small at high, runs auto): '
        + 'Write code. When to use: Use for a bounded edit.',
      'review — Review (invocation automatic, access inherit, model inherit, runs foreground): Review code.',
    ])
  })

  it('is stable between two reads of the same settings', () => {
    const settings = documentOf([
      definition({ id: 'code' }),
      definition({ id: 'review', whenToUse: 'Use it.' }),
    ])
    const first = renderSubagentDirectory(subagentDirectory(subagentRosterView(settings, null)))
    const second = renderSubagentDirectory(subagentDirectory(subagentRosterView(settings, null)))
    expect(second).toBe(first)
  })
})

describe('the directory the model reads', () => {
  it('reports the routing guidance and hides disabled roles', async () => {
    const roster = await bootRoster({ settings: documentOf([
      definition({ id: 'code', whenToUse: 'Use for a bounded edit.' }),
      definition({ id: 'retired', enabled: false }),
    ]) })
    const result = await listSubagents(roster, headerAgent())
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('When to use: Use for a bounded edit.')
    expect(text(result)).not.toContain('retired')
    await roster.dispose()
  })

  it('reports no roles at all when every one is disabled', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', enabled: false })]),
    })
    const result = await listSubagents(roster, headerAgent())
    expect(text(result)).toBe('(no subagents are enabled for this workspace)')
    await roster.dispose()
  })

  it('answers with the raw directory rows as its value', async () => {
    const roster = await bootRoster({ settings: documentOf([definition({ id: 'code' })]) })
    const result = await listSubagents(roster, headerAgent())
    expect(result.value).toEqual([{
      id: 'code',
      name: 'code',
      purpose: 'code purpose',
      whenToUse: '',
      invocation: 'automatic',
      model: 'inherit',
      access: 'inherit',
      background: 'foreground',
    }])
    await roster.dispose()
  })
})

describe('the child request one definition describes', () => {
  it('delivers the standing instructions as the child persona', async () => {
    const roster = await bootRoster({ settings: documentOf([
      definition({ id: 'code', instructions: 'Answer in one paragraph.' }),
    ]) })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.persona).toBe('Answer in one paragraph.')
    await roster.dispose()
  })

  it('leaves the deployment persona alone when the definition has no instructions', async () => {
    const roster = await bootRoster({ settings: documentOf([definition({ id: 'code', instructions: '  ' })]) })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(false)
    // An empty persona would SHADOW the deployment's, so the key stays absent.
    expect(roster.requests[0]).not.toHaveProperty('persona')
    await roster.dispose()
  })

  it('labels the child with the definition name and carries its scoping', async () => {
    const roster = await bootRoster({ settings: documentOf([
      definition({
        id: 'code',
        name: 'Code',
        tools: { deny: ['write'] },
        maxDepth: 3,
      }),
    ]) })
    const result = await delegate(roster, { subagent: 'code', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]).toMatchObject({
      label: 'Code',
      maxDepth: 3,
      toolFilter: { deny: ['write'] },
    })
    await roster.dispose()
  })

  it('treats a custom definition exactly like a shipped one', async () => {
    const custom = definition({
      id: 'incident-review',
      name: 'Incident review',
      purpose: 'Review an incident.',
      whenToUse: 'Use after an incident report exists.',
      invocation: 'automatic',
      model: { mode: 'fixed', route: { provider: 'alpha', model: 'small' } },
      access: 'read-only',
      instructions: 'Stay on the incident.',
      maxDepth: 1,
      execution: { backend: 'spawn', background: 'foreground' },
    })
    const roster = await bootRoster({ settings: documentOf([custom]) })
    roster.ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
    const listed = await listSubagents(roster, headerAgent())
    expect(text(listed)).toContain('incident-review — Incident review')
    const result = await delegate(roster, { subagent: 'incident-review', task: 'Review it.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]).toMatchObject({
      label: 'Incident review',
      persona: 'Stay on the incident.',
      maxDepth: 1,
      sandboxMode: 'read-only',
    })
    await roster.dispose()
  })

  it('refuses a definition the user deleted rather than falling back to a built-in', async () => {
    const roster = await bootRoster({ settings: documentOf([definition({ id: 'code' })]) })
    const result = await delegate(roster, { subagent: 'review', task: 'Work.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no subagent "review" exists; configured subagents: code')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})
