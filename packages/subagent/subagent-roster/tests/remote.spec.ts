/**
 * The roster's Host Remote surface: the enabled roles one Settings page reads
 * with their per-field provenance, the stored document it edits, the routing
 * authority it authorizes through, and the refusal a cancelled caller sees.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSubagentSettings, DEFAULT_SUBAGENT_LIMITS } from '../src/defaults.ts'
import { canonicalWorkspaceKey, SUBAGENT_ROSTER_NAMESPACE } from '../src/settings.ts'
import type {
  SubagentDefinition,
  SubagentRoleView,
  SubagentSettings,
  SubagentWorkspaceOverride,
} from '../src/types.ts'
import { bootPlugin } from './harness.ts'

/** One real workspace path and the key its overrides live under. */
const WORKSPACE = resolve('roster-remote-workspace')
const KEY = canonicalWorkspaceKey(WORKSPACE)

/** Shared non-aborted signal for the reads under test. */
const signal = new AbortController().signal

/** The shipped document with one workspace's override layer. */
function storedWith(override: SubagentWorkspaceOverride): SubagentSettings {
  return { ...defaultSubagentSettings(), overrides: { [KEY]: override } }
}

/** One shipped definition, as the global layer stores it. */
function shipped(id: string): SubagentDefinition {
  const definition = defaultSubagentSettings().subagents.find(candidate => candidate.id === id)
  if (definition === undefined) throw new Error(`the shipped roster has no "${id}" role`)
  return definition
}

/** One resolved role of a view, which the view must carry. */
function roleOf(roles: readonly SubagentRoleView[], id: string): SubagentRoleView {
  const role = roles.find(candidate => candidate.id === id)
  if (role === undefined) throw new Error(`expected a resolved role "${id}"`)
  return role
}

/** Provenance for a definition no workspace layer names at all. */
const INHERITED = {
  name: false, enabled: false, purpose: false, whenToUse: false, invocation: false,
  model: false, access: false, tools: false, instructions: false, maxDepth: false,
  execution: false,
}

describe('roster Remote surface', () => {
  it('resolves one workspace against an override that changes exactly one field', async () => {
    const plugin = await bootPlugin(storedWith({ subagents: { code: { purpose: 'Only here.' } } }))
    const view = plugin.controller.resolvedRoster(WORKSPACE, signal)
    const code = roleOf(view.subagents, 'code')

    expect(view.workspaceKey).toBe(KEY)
    expect(view.subagents.map(role => role.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])
    expect(code.purpose).toBe('Only here.')
    expect(code.overrides).toEqual({ ...INHERITED, purpose: true })
    // The overridden field is the only difference; every other value is the global one.
    expect({
      name: code.name,
      whenToUse: code.whenToUse,
      invocation: code.invocation,
      model: code.model,
      access: code.access,
      execution: code.execution,
    }).toEqual({
      name: shipped('code').name,
      whenToUse: shipped('code').whenToUse,
      invocation: shipped('code').invocation,
      model: shipped('code').model,
      access: shipped('code').access,
      execution: shipped('code').execution,
    })
    await plugin.dispose()
  })

  it('reports an override that names the global value as overridden', async () => {
    // Provenance records that the workspace layer decided this field, which is
    // what an editor's reset offers to undo — not whether the value differs.
    const plugin = await bootPlugin(storedWith({
      subagents: { code: { purpose: shipped('code').purpose } },
    }))
    const code = roleOf(plugin.controller.resolvedRoster(WORKSPACE, signal).subagents, 'code')

    expect(code.purpose).toBe(shipped('code').purpose)
    expect(code.overrides).toEqual({ ...INHERITED, purpose: true })
    await plugin.dispose()
  })

  it('omits a disabled role from the resolved view and keeps it in the stored document', async () => {
    const settings = defaultSubagentSettings()
    const plugin = await bootPlugin({
      ...settings,
      subagents: settings.subagents.map(definition =>
        definition.id === 'docs' ? { ...definition, enabled: false } : definition),
    })

    const resolved = plugin.controller.resolvedRoster(WORKSPACE, signal)
    expect(resolved.subagents.map(role => role.id)).not.toContain('docs')
    // The stored document is what the page edits, so the disabled role stays visible there.
    const stored = plugin.controller.storedRoster(signal)
    expect(stored.subagents.map(definition => definition.id)).toContain('docs')
    expect(stored.subagents.find(definition => definition.id === 'docs')?.enabled).toBe(false)
    await plugin.dispose()
  })

  it('resolves a null workspace with no override layer', async () => {
    const plugin = await bootPlugin(storedWith({
      subagents: { code: { purpose: 'Only here.', access: 'workspace-write' } },
    }))
    const view = plugin.controller.resolvedRoster(null, signal)

    expect(view.workspaceKey).toBeNull()
    expect(view.subagents.map(role => role.id)).toHaveLength(6)
    for (const role of view.subagents) expect(role.overrides).toEqual(INHERITED)
    expect(roleOf(view.subagents, 'code').purpose).toBe(shipped('code').purpose)
    expect(roleOf(view.subagents, 'code').access).toBe(shipped('code').access)
    await plugin.dispose()
  })

  it('reads the automatic-routing authority and run bounds, following a saved edit', async () => {
    const plugin = await bootPlugin()
    expect(plugin.controller.automaticRouting(signal)).toEqual({ enabled: false, allowedModels: [] })
    const before = plugin.controller.storedRoster(signal)
    expect(before.limits).toEqual(DEFAULT_SUBAGENT_LIMITS)
    expect(before.subagents.map(definition => definition.id))
      .toEqual(['code', 'review', 'tests', 'docs', 'research', 'architecture'])

    await plugin.settingsCtx.settings.replace(SUBAGENT_ROSTER_NAMESPACE, {
      ...defaultSubagentSettings(),
      automaticRouting: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'small' }] },
      limits: { maxConcurrentRuns: 4, defaultTimeoutMs: 120_000 },
    })

    const routing = plugin.controller.automaticRouting(signal)
    expect(routing.enabled).toBe(true)
    expect(routing.allowedModels).toEqual([{ provider: 'alpha', model: 'small' }])
    expect(plugin.controller.storedRoster(signal).limits)
      .toEqual({ maxConcurrentRuns: 4, defaultTimeoutMs: 120_000 })
    await plugin.dispose()
  })

  it('refuses every read whose caller had already cancelled', async () => {
    const plugin = await bootPlugin()
    const cancelled = AbortSignal.abort(new Error('superseded by a newer read'))
    const reads = [
      () => plugin.controller.resolvedRoster(null, cancelled),
      () => plugin.controller.automaticRouting(cancelled),
      () => plugin.controller.storedRoster(cancelled),
    ]
    for (const read of reads) expect(read).toThrow('superseded by a newer read')
    // The same reads answer completely once the caller is still waiting.
    expect(plugin.controller.resolvedRoster(null, signal).subagents).toHaveLength(6)
    expect(plugin.controller.storedRoster(signal).subagents).toHaveLength(6)
    await plugin.dispose()
  })
})
