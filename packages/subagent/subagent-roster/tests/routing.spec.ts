/**
 * Where a delegated child's model comes from: the definition's fixed route, the
 * parent's authorized choice, the route the backend contributes, and the
 * reasoning effort that travels with whichever route won.
 */

import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DELEGATE_TOOL } from '../src/tools.ts'
import {
  bootRoster,
  delegate,
  definition,
  documentOf,
  headerAgent,
  listSubagents,
  parametersOf,
  text,
} from './harness.ts'

/** The package's own implementation directory, read to prove it names no vendor. */
const SOURCE_DIR = new URL('../src/', import.meta.url)

/**
 * Provider and model vocabulary that must never appear as a literal in this
 * package's source: a route is user data resolved against the deployment's live
 * catalog, never a value this package knows.
 */
const VENDOR_VOCABULARY
  = /(deepseek|openai|anthropic|gemini|claude|gpt-|llama|qwen|mistral|xai|cohere|groq)/u

const EFFORTS: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

const ALPHA_SMALL = { provider: 'alpha', model: 'small' } as const
const BETA_LARGE = { provider: 'beta', model: 'large' } as const

/** Register one adapter per named provider, all answering from the same catalog. */
function catalog(
  roster: Awaited<ReturnType<typeof bootRoster>>,
  providers: readonly string[],
  reasoning?: LlmModelReasoningInfo,
): void {
  roster.ctx.llm.registerAdapter([...providers], new MockAdapter([], reasoning))
}

describe('fixed model routes', () => {
  const fixed = definition({
    id: 'code',
    model: { mode: 'fixed', route: { ...ALPHA_SMALL, reasoningEffort: 'low' } },
  })

  it('sends the definition route to the child whatever the parent does', async () => {
    const roster = await bootRoster({ settings: documentOf([fixed]) })
    catalog(roster, ['alpha'], EFFORTS)
    const result = await delegate(roster, { subagent: 'code', task: 'Do it.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'small',
      reasoningEffort: 'low',
    })
    await roster.dispose()
  })

  it.each([
    ['provider and model', { provider: 'beta', model: 'large' }],
    ['effort alone', { reasoning_effort: 'high' }],
    ['a partial route', { provider: 'beta' }],
  ])('refuses %s from a call against a fixed definition', async (_label, selection) => {
    const roster = await bootRoster({ settings: documentOf([fixed]) })
    catalog(roster, ['alpha', 'beta'], EFFORTS)
    const result = await delegate(roster, { subagent: 'code', task: 'Do it.', ...selection }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('fixes its model, so this call cannot select a route')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('reports the fixed route and its effort in the directory', async () => {
    const roster = await bootRoster({ settings: documentOf([fixed]) })
    const result = await listSubagents(roster, headerAgent())
    expect(text(result)).toContain('model alpha/small at low')
    await roster.dispose()
  })

  it('offers the route fields only because one schema serves both modes', async () => {
    const roster = await bootRoster({ settings: documentOf([fixed]) })
    // The tool itself decides nothing: the definition's mode is what refuses a
    // selection, and the schema names the route fields for the automatic case.
    expect(Object.keys(parametersOf(roster.ctx, DELEGATE_TOOL))).toContain('provider')
    expect(fixed.model.mode).toBe('fixed')
    await roster.dispose()
  })
})

describe('fixed definitions that name no route', () => {
  const inheriting = definition({ id: 'code', model: { mode: 'fixed' } })

  it('sends no route, so the child inherits the parent route', async () => {
    const roster = await bootRoster({ settings: documentOf([inheriting]) })
    const result = await delegate(roster, { subagent: 'code', task: 'Do it.' }, headerAgent())
    expect(result.isError).toBe(false)
    // An omitted route is exactly the `configured === undefined` case the shared
    // selection path already handles by contributing no agent options.
    expect(roster.requests[0]?.agentOptions).toBeUndefined()
    await roster.dispose()
  })

  it.each([
    ['provider and model', { provider: 'alpha', model: 'small' }],
    ['effort alone', { reasoning_effort: 'high' }],
    ['a partial route', { provider: 'alpha' }],
  ])('refuses %s with SUBAGENT_ROUTE_FIXED and starts no child', async (_label, selection) => {
    const roster = await bootRoster({ settings: documentOf([inheriting]) })
    catalog(roster, ['alpha', 'beta'], EFFORTS)
    const result = await delegate(roster, { subagent: 'code', task: 'Do it.', ...selection }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('fixes its model, so this call cannot select a route')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('reports the inherited route in the directory rather than a selection', async () => {
    const roster = await bootRoster({ settings: documentOf([inheriting]) })
    const result = await listSubagents(roster, headerAgent())
    expect(text(result)).toContain('model inherit')
    await roster.dispose()
  })

  it('is what every shipped role does, so a delegation selects nothing for it', async () => {
    const roster = await bootRoster()
    const result = await delegate(roster, { subagent: 'code', task: 'Do it.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toBeUndefined()

    // A shipped role refuses a selection as a fixed policy, not as a disabled
    // selection: the model owns nothing about the child's route here.
    const refused = await delegate(
      roster,
      { subagent: 'code', task: 'Again.', provider: 'alpha', model: 'small' },
      headerAgent(),
    )
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('fixes its model, so this call cannot select a route')
    expect(roster.requests).toHaveLength(1)
    await roster.dispose()
  })
})

describe('automatic model routing', () => {
  const automatic = definition({
    id: 'code',
    model: { mode: 'automatic' },
  })
  const authorized = documentOf([automatic], {
    automaticRouting: { enabled: true, allowedModels: [ALPHA_SMALL, BETA_LARGE] },
  })

  it('accepts every authorized route and sends the chosen one to the child', async () => {
    const roster = await bootRoster({ settings: authorized })
    catalog(roster, ['alpha', 'beta'])
    const first = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'alpha', model: 'small' },
      headerAgent(),
    )
    const second = await delegate(
      roster,
      { subagent: 'code', task: 'Two.', provider: 'beta', model: 'large' },
      headerAgent(),
    )
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(roster.requests.map(request => request.agentOptions)).toEqual([
      { provider: 'alpha', model: 'small' },
      { provider: 'beta', model: 'large' },
    ])
    await roster.dispose()
  })

  it('rejects an unauthorized route with the shared selection error', async () => {
    const roster = await bootRoster({ settings: authorized })
    catalog(roster, ['alpha', 'beta', 'gamma'])
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'gamma', model: 'unlisted' },
      headerAgent(),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: child LLM route "gamma/unlisted" is not allowed for this Session')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('drops a configured effort when the call changes the route without naming one', async () => {
    const configured = definition({
      id: 'code',
      model: { mode: 'automatic', route: { ...ALPHA_SMALL, reasoningEffort: 'high' } },
    })
    const roster = await bootRoster({ settings: documentOf([configured], {
      automaticRouting: { enabled: true, allowedModels: [ALPHA_SMALL, BETA_LARGE] },
    }) })
    catalog(roster, ['alpha', 'beta'], EFFORTS)
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'beta', model: 'large' },
      headerAgent(),
    )
    expect(result.isError).toBe(false)
    // The effort belonged to the route that was replaced, so it is not sent.
    expect(roster.requests[0]?.agentOptions).toEqual({ provider: 'beta', model: 'large' })
    await roster.dispose()
  })

  it('carries no route at all when the definition configures none and the call selects none', async () => {
    const roster = await bootRoster({ settings: authorized })
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toBeUndefined()
    await roster.dispose()
  })
})

describe('automatic routing authority', () => {
  const automatic = definition({ id: 'code', model: { mode: 'automatic' } })

  it('yields no model selection at all while routing is disabled', async () => {
    const roster = await bootRoster({ settings: documentOf([automatic]) })
    catalog(roster, ['alpha'])
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'alpha', model: 'small' },
      headerAgent(),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child model selection is disabled for this tool instance')
    expect(roster.requests).toHaveLength(0)

    const inherited = await delegate(roster, { subagent: 'code', task: 'Two.' }, headerAgent())
    expect(inherited.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toBeUndefined()
    await roster.dispose()
  })

  it('yields no route parameters for a definition that fixes its model while routing is disabled', async () => {
    const fixed = definition({ id: 'code', model: { mode: 'fixed', route: ALPHA_SMALL } })
    const roster = await bootRoster({ settings: documentOf([fixed]) })
    catalog(roster, ['alpha'])
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', reasoning_effort: 'high' },
      headerAgent(),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('fixes its model')
    await roster.dispose()
  })
})

describe('reasoning effort capability', () => {
  it('refuses an effort the selected model does not advertise', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', model: { mode: 'automatic' } })], {
        automaticRouting: { enabled: true, allowedModels: [ALPHA_SMALL] },
      }),
    })
    catalog(roster, ['alpha'], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
      defaultEffort: ReasoningEffortId('low'),
    })
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'alpha', model: 'small', reasoning_effort: 'high' },
      headerAgent(),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "high"')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('sends exactly an effort the model advertises', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', model: { mode: 'automatic' } })], {
        automaticRouting: { enabled: true, allowedModels: [ALPHA_SMALL] },
      }),
    })
    catalog(roster, ['alpha'], EFFORTS)
    const accepted = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'alpha', model: 'small', reasoning_effort: 'low' },
      headerAgent(),
    )
    expect(accepted.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toEqual({
      provider: 'alpha', model: 'small', reasoningEffort: 'low',
    })
    await roster.dispose()
  })

  it('refuses an effort for a model whose catalog entry advertises none', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', model: { mode: 'automatic' } })], {
        automaticRouting: { enabled: true, allowedModels: [ALPHA_SMALL] },
      }),
    })
    catalog(roster, ['alpha'])
    const result = await delegate(
      roster,
      { subagent: 'code', task: 'One.', provider: 'alpha', model: 'small', reasoning_effort: 'high' },
      headerAgent(),
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "high"')
    await roster.dispose()
  })

  it('refuses a fixed effort the fixed route does not advertise', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({
        id: 'code',
        model: { mode: 'fixed', route: { ...ALPHA_SMALL, reasoningEffort: 'max' } },
      })]),
    })
    catalog(roster, ['alpha'], EFFORTS)
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support reasoning effort "max"')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})

describe('route resolution over a multi-provider catalog', () => {
  it('resolves a route through the backend that declares its own defaults', async () => {
    const roster = await bootRoster({
      children: [{ name: 'spawn', agentRouteDefaults: { provider: 'alpha', model: 'small' } }],
      settings: documentOf([definition({ id: 'code', model: { mode: 'fixed', route: BETA_LARGE } })]),
    })
    // The definition's route wins over the backend default, and both are catalog data.
    catalog(roster, ['alpha', 'beta'])
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toEqual({ provider: 'beta', model: 'large' })
    await roster.dispose()
  })

  it('rejects a route the catalog does not serve', async () => {
    const roster = await bootRoster({
      settings: documentOf([definition({ id: 'code', model: { mode: 'fixed', route: BETA_LARGE } })]),
    })
    catalog(roster, ['alpha'])
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no adapter registered for provider "beta"')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })

  it('refuses a configured route in a composition with no LLM runtime', async () => {
    const roster = await bootRoster({
      withoutLlm: true,
      settings: documentOf([definition({ id: 'code', model: { mode: 'fixed', route: ALPHA_SMALL } })]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the `llm` service is unavailable')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})

describe('backends that own their model space', () => {
  /**
   * A backend such as a CLI product resolves its own model ids, so the roster
   * hands the route over untouched instead of asking the composed LLM runtime
   * about a model it does not serve. The composition mounts no LLM runtime at
   * all, which is what proves the runtime was never consulted.
   */
  const ownRoute = definition({
    id: 'code',
    model: { mode: 'fixed', route: { provider: 'vendor', model: 'vendor-product/model-x', reasoningEffort: 'high' } },
  })

  it('hands the route to the backend untouched without resolving it against the LLM runtime', async () => {
    const roster = await bootRoster({
      withoutLlm: true,
      children: [{ name: 'spawn', capabilities: { runtimeRoute: false } }],
      settings: documentOf([ownRoute]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toEqual({
      provider: 'vendor',
      model: 'vendor-product/model-x',
      reasoningEffort: 'high',
    })
    await roster.dispose()
  })

  it('fails through the backend when the backend cannot honour the route', async () => {
    const roster = await bootRoster({
      withoutLlm: true,
      children: [{ name: 'spawn', capabilities: { runtimeRoute: false }, refuse: { failure: 'error' } }],
      settings: documentOf([ownRoute]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    // The route reached the backend rather than being refused here, and the
    // backend's own refusal is what the caller reads.
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: the child failed to start')
    await roster.dispose()
  })

  it('still resolves and preflights a route for a backend that declares the runtime resolves it', async () => {
    const roster = await bootRoster({
      withoutLlm: true,
      children: [{ name: 'spawn', capabilities: { runtimeRoute: true } }],
      settings: documentOf([ownRoute]),
    })
    const result = await delegate(roster, { subagent: 'code', task: 'One.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the `llm` service is unavailable')
    expect(roster.requests).toHaveLength(0)
    await roster.dispose()
  })
})

describe('provider-agnostic routing', () => {
  /**
   * The roster enumerates no provider and no model of its own: it is a settings
   * document plus the live catalog. A third provider added to the deployment
   * therefore reaches both surfaces with no change to this package's source.
   */
  const thirdProvider = definition({
    id: 'audit',
    model: { mode: 'fixed', route: { provider: 'gamma', model: 'auditor' } },
  })

  it('accepts a definition naming a provider this package has never heard of', async () => {
    const roster = await bootRoster({ settings: documentOf([thirdProvider]) })
    catalog(roster, ['gamma'])
    const result = await delegate(roster, { subagent: 'audit', task: 'Audit it.' }, headerAgent())
    expect(result.isError).toBe(false)
    expect(roster.requests[0]?.agentOptions).toEqual({ provider: 'gamma', model: 'auditor' })
    await roster.dispose()
  })

  it('reports a route only in the catalog the deployment registered it in', async () => {
    const roster = await bootRoster({ settings: documentOf([thirdProvider]) })
    // With no adapter registered for `gamma` the same definition fails at the
    // catalog, not at a hard-coded list inside this package.
    const result = await delegate(roster, { subagent: 'audit', task: 'Audit it.' }, headerAgent())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no adapter registered for provider "gamma"')
    await roster.dispose()
  })

  it('names no provider or model anywhere in its own source', async () => {
    // Vocabulary, not a catalog. Every route is user data resolved against the
    // live LLM runtime, so adding a provider or model to the deployment's
    // catalog must never require a change to this package. Reading the source
    // is the only way to prove the absence of a hardcoded list: a runtime
    // assertion cannot distinguish "resolved from the catalog" from "matched a
    // literal that happens to be there".
    const sources = await readdir(SOURCE_DIR)
    expect(sources.length).toBeGreaterThan(0)
    for (const name of sources) {
      const text = await readFile(new URL(name, SOURCE_DIR), 'utf8')
      // The package scope `@deepseek-ai/` is the only legitimate appearance of
      // a provider-looking token; anything else is a hardcoded vendor.
      const scoped = text.replaceAll('@deepseek-ai/', '@scope/')
      expect(VENDOR_VOCABULARY.test(scoped), `${name} names a provider or model`).toBe(false)
    }
  })
})
