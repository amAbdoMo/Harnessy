/**
 * The shipped plugin's registration surface: the two model-facing tools, the
 * parameters they declare, the settings section they read through, and the
 * disposal every registry contribution owes.
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { defaultSubagentSettings } from '../src/defaults.ts'
import { canonicalWorkspaceKey, SUBAGENT_ROSTER_NAMESPACE } from '../src/settings.ts'
import { DELEGATE_TOOL, LIST_SUBAGENTS_TOOL } from '../src/tools.ts'
import type { SubagentDefinition } from '../src/types.ts'
import {
  bootPlugin,
  bootRoster,
  delegate,
  headerAgent,
  listSubagents,
  parametersOf,
  text,
} from './harness.ts'

const WORKSPACE = process.cwd()

/** The shipped `code` role, replaced in place with one field changed. */
function withCode(mutate: (definition: SubagentDefinition) => SubagentDefinition) {
  const settings = defaultSubagentSettings()
  return {
    ...settings,
    subagents: settings.subagents.map(definition => definition.id === 'code' ? mutate(definition) : definition),
  }
}

describe('roster plugin registration', () => {
  it('registers the two token-stable tools and removes them on disposal', async () => {
    const plugin = await bootPlugin()
    expect([DELEGATE_TOOL, LIST_SUBAGENTS_TOOL].map(name => plugin.ctx.tools.get(name)?.name))
      .toEqual([DELEGATE_TOOL, LIST_SUBAGENTS_TOOL])
    await plugin.dispose()
    expect(plugin.ctx.tools.get(DELEGATE_TOOL)).toBeUndefined()
    expect(plugin.ctx.tools.get(LIST_SUBAGENTS_TOOL)).toBeUndefined()
  })

  it('has the Loader-safe namespace export shape', async () => {
    const roster = await import('../src/index.ts')
    expect(typeof roster.apply).toBe('function')
    expect('default' in roster).toBe(false)
    expect(roster.name).toBe('subagent-roster')
    expect(roster.inject).toEqual(['tools', 'subagents', 'agents', 'sessionProjections'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(roster)).toBe(roster)
  })

  it('exposes the role id, the task, the background choice, and the route fields', async () => {
    const { ctx } = await bootPlugin()
    expect(Object.keys(parametersOf(ctx, DELEGATE_TOOL)).sort()).toEqual([
      'model', 'provider', 'reasoning_effort', 'run_in_background', 'subagent', 'task',
    ])
  })

  it('declares no access, sandbox, permission, credential, or timeout parameter', async () => {
    const { ctx } = await bootPlugin()
    const declared = Object.keys(parametersOf(ctx, DELEGATE_TOOL))
    for (const forbidden of [
      'access', 'sandbox', 'sandbox_mode', 'permission', 'permissions', 'approval',
      'credential', 'token', 'timeout', 'timeout_ms', 'backend', 'provider_name',
    ]) {
      expect(declared).not.toContain(forbidden)
    }
    expect(Object.keys(parametersOf(ctx, LIST_SUBAGENTS_TOOL))).toEqual([])
  })

  it('reads the live settings document on every call', async () => {
    const plugin = await bootPlugin()
    const before = await listSubagents(plugin)
    expect(text(before)).toContain('code — Code')

    await plugin.settingsCtx.settings.replace(SUBAGENT_ROSTER_NAMESPACE, withCode(definition => ({
      ...definition,
      name: 'Renamed',
      purpose: 'Changed while the session ran.',
    })))

    const after = await listSubagents(plugin)
    expect(text(after)).toContain('code — Renamed')
    expect(text(after)).toContain('Changed while the session ran.')
    expect(text(after)).not.toContain('code — Code')
  })

  it('rejects a stored document the resolver cannot act on', async () => {
    const { settingsCtx } = await bootPlugin()
    await expect(settingsCtx.settings.replace(SUBAGENT_ROSTER_NAMESPACE, withCode(definition => ({
      ...definition,
      id: 'review',
    })))).rejects.toThrow(/duplicate subagent id "review"/u)
  })

  it('follows a settings provider that attaches after the section is installed', async () => {
    const plugin = await bootPlugin(undefined, 'after')
    expect(text(await listSubagents(plugin))).toContain('code — Code')

    await plugin.settingsCtx.settings.replace(SUBAGENT_ROSTER_NAMESPACE, withCode(definition => ({
      ...definition,
      name: 'Attached later',
    })))
    expect(text(await listSubagents(plugin))).toContain('code — Attached later')

    // Losing the provider leaves the shipped entry serving, never a stale document.
    await plugin.detachSettings()
    const afterDetach = text(await listSubagents(plugin))
    expect(afterDetach).toContain('code — Code')
    expect(afterDetach).not.toContain('Attached later')
  })

  it('serves the shipped roles in a composition with no settings provider', async () => {
    const plugin = await bootPlugin(undefined, 'none')
    const result = await listSubagents(plugin)
    expect(text(result)).toContain('code — Code')
    expect(result.value).toHaveLength(6)
  })
})

describe('roster tool presentation', () => {
  it('presents the directory as a read and delegation as an execute', async () => {
    const { ctx } = await bootPlugin()
    expect(ctx.tools.get(LIST_SUBAGENTS_TOOL)?.presentCall?.({})).toEqual({
      card: 'generic', title: 'List subagents', kind: 'read',
    })
    expect(ctx.tools.get(DELEGATE_TOOL)?.presentCall?.({ subagent: 'code', task: 'x' })).toEqual({
      card: 'generic', title: 'Delegate to the "code" subagent', kind: 'execute', rawInput: 'code',
    })
  })

  it('declares delegation concurrency-safe and refuses the claim for invalid arguments', async () => {
    const { ctx } = await bootPlugin()
    const tool = ctx.tools.get(DELEGATE_TOOL)
    expect(tool?.isConcurrencySafe?.({ subagent: 'code', task: 'Work.' })).toBe(true)
    // The wrapper refuses the claim when the call does not satisfy the schema.
    expect(tool?.isConcurrencySafe?.({ subagent: 'code' })).toBe(false)
  })

  it('delegates through the composition the plugin itself built', async () => {
    const plugin = await bootPlugin()
    const result = await delegate(plugin, { subagent: 'review', task: 'Review it.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('scripted child reply')
  })

  it('carries the workspace the calling session reports into the directory', async () => {
    const roster = await bootRoster({
      settings: {
        ...defaultSubagentSettings(),
        overrides: {
          [canonicalWorkspaceKey(WORKSPACE)]: {
            subagents: { code: { purpose: 'Only here.' } },
            removed: ['docs'],
          },
        },
      },
      workspace: WORKSPACE,
    })
    const result = await listSubagents(roster, headerAgent())
    expect(text(result)).toContain('Only here.')
    expect(text(result)).not.toContain('docs — Docs')
    await roster.dispose()
  })

  it('delegates the task text to the resolved child', async () => {
    const roster = await bootRoster()
    const result = await delegate(roster, { subagent: 'review', task: 'Review the diff.' }, headerAgent())
    expect(text(result)).toBe('scripted child reply')
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.prompt).toEqual([{ type: 'text', text: 'Review the diff.' }])
    await roster.dispose()
  })

  it('refuses a delegation that reached it without a calling agent', async () => {
    const roster = await bootRoster()
    const result = await delegate(roster, { subagent: 'review', task: 'Review the diff.' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('delegate requires a calling agent')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})
