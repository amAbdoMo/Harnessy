// @vitest-environment jsdom
/**
 * The Models page's rendering of where a model's reasoning levels came from.
 *
 * Every case is driven from the Host's own answer, so these specs assert what a
 * person reads rather than re-deriving a match: a provider-aware public claim,
 * an id-only suggestion, an ambiguity, a disabled layer, and a declaration that
 * outranks all of them.
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { ModelCapabilityInspectionView } from '@deepseek-ai/dsh-api-remotes/client'
import { capabilityKey, capabilityProvenance, routeCapabilities } from '../src/client/capability.ts'
import type { CapabilityProvenanceState } from '../src/client/capability.ts'
import { CapabilityProvenance } from '../src/client/CapabilityProvenance.tsx'
import { en } from '../src/client/locales.ts'

/** Section copy as the page binds it, without the locale runtime. */
const t = ((key: keyof typeof en, params?: Record<string, unknown>): string => {
  const text = en[key]
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))
})

/** The instant every fetch age is measured from, so a render is deterministic. */
const NOW = Date.parse('2026-09-16T12:00:00.000Z')

/**
 * One Host answer.
 * @param overrides - the fields this case states.
 * @returns the inspection view.
 */
function view(overrides: Partial<ModelCapabilityInspectionView> = {}): ModelCapabilityInspectionView {
  return { route: 'cortex', model: 'gpt-5.6-sol', enabled: true, suggestions: [], ...overrides }
}

/**
 * Render one row's provenance.
 * @param state - the reduced state to render.
 * @returns the container's text content.
 */
function text(state: Parameters<typeof CapabilityProvenance>[0]['state']): string {
  const { container } = render(<CapabilityProvenance state={state} now={NOW} t={t} />)
  return container.textContent ?? ''
}

/** The undeclared row a case inspects. */
const UNDECLARED = { declaresNoReasoning: false }

describe('deriving what a row renders', () => {
  it('applies a provider-aware match to an undeclared row', () => {
    expect(capabilityProvenance(view({
      resolved: {
        levels: ['low', 'medium', 'high'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-host',
        origin: 'cache',
        fetchedAt: '2026-09-16T11:42:00.000Z',
      },
    }), UNDECLARED)).toEqual({
      kind: 'public',
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'cache',
      fetchedAt: '2026-09-16T11:42:00.000Z',
    })
  })

  it('leaves an id-only claim as a claim, never as a capability', () => {
    const state = capabilityProvenance(view({
      suggestions: [{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] }],
    }), UNDECLARED)
    expect(state).toEqual({
      kind: 'id-only',
      claims: [{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] }],
    })
  })

  it('reports a disabled layer rather than an absence of claims', () => {
    expect(capabilityProvenance(view({ enabled: false }), UNDECLARED)).toEqual({ kind: 'disabled' })
  })

  it('says nothing about a model no database claims', () => {
    expect(capabilityProvenance(view(), UNDECLARED)).toEqual({ kind: 'none' })
  })

  it('says nothing for a row the Host does not report at all', () => {
    expect(capabilityProvenance(undefined, UNDECLARED)).toEqual({ kind: 'none' })
  })

  it('keeps a declaration as the active source, whatever the catalogs state', () => {
    const declared = { declaresNoReasoning: false, efforts: ['low', 'max'] }
    // A differing public claim is reported and not applied.
    expect(capabilityProvenance(view({
      resolved: {
        levels: ['low', 'medium', 'high'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-host',
        origin: 'bundled',
      },
    }), declared)).toEqual({ kind: 'declared', notApplied: ['low', 'medium', 'high'] })
  })

  it('reports no public claim beside a declaration when no catalog matched', () => {
    expect(capabilityProvenance(view(), { declaresNoReasoning: false, efforts: ['low', 'max'] }))
      .toEqual({ kind: 'declared' })
  })

  it('carries no fetch time for a bundled answer, which has none', () => {
    expect(capabilityProvenance(view({
      resolved: {
        levels: ['low', 'medium', 'high'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-host',
        origin: 'bundled',
      },
    }), UNDECLARED)).toEqual({
      kind: 'public',
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'bundled',
    })
  })

  it('reports no unused claim when the public levels match the declaration', () => {
    expect(capabilityProvenance(view({
      resolved: {
        levels: ['max', 'low'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-id',
        origin: 'bundled',
      },
    }), { declaresNoReasoning: false, efforts: ['low', 'max'] })).toEqual({ kind: 'declared' })
  })

  it('keeps a refusal as the active source', () => {
    expect(capabilityProvenance(view({
      resolved: {
        levels: ['low'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-host',
        origin: 'bundled',
      },
    }), { declaresNoReasoning: true })).toEqual({ kind: 'declared', notApplied: ['low'] })
  })

  it('reports nothing applied for a declared row even when the layer is disabled', () => {
    expect(capabilityProvenance(view({ enabled: false }), {
      declaresNoReasoning: false,
      efforts: ['low'],
    })).toEqual({ kind: 'declared' })
  })
})

describe('what a row reads', () => {
  it('names the levels, the database, the provider, and the cached fetch', () => {
    const rendered = text({
      kind: 'public',
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'cache',
      fetchedAt: '2026-09-16T11:42:00.000Z',
    })
    expect(rendered).toContain('Reasoning')
    expect(rendered).toContain('Low · Medium · High')
    expect(rendered).toContain('Source')
    expect(rendered).toContain('Public metadata · models.dev')
    expect(rendered).toContain('Matched provider: cortecs')
    expect(rendered).toContain('Cached metadata · updated 18 min ago')
  })

  it('names a live answer as live', () => {
    const rendered = text({
      kind: 'public',
      levels: ['low', 'high'],
      source: 'openrouter',
      provider: 'openrouter',
      match: 'openrouter-route',
      origin: 'live',
      fetchedAt: '2026-09-16T11:59:30.000Z',
    })
    expect(rendered).toContain('Live metadata · updated just now')
    // The OpenRouter route has no models.dev provider entry, so the line names
    // the match rather than a provider that does not exist.
    expect(rendered).toContain('Matched OpenRouter')
  })

  it('names a bundled answer without inventing a fetch time', () => {
    const rendered = text({
      kind: 'public',
      levels: ['low', 'medium', 'high'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'bundled',
    })
    expect(rendered).toContain('Bundled with Harnessy')
    expect(rendered).not.toContain('updated')
  })

  it('never leaks a fixture origin into a shipped surface', () => {
    const rendered = text({
      kind: 'public',
      levels: ['low'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'fixture',
      fetchedAt: '2026-09-16T11:42:00.000Z',
    })
    // The row still reads; only the internal word is withheld.
    expect(rendered).toContain('Public metadata · models.dev')
    expect(rendered).not.toContain('fixture')
    expect(rendered).not.toContain('Fixture')
  })

  it('states a configured declaration as the active source', () => {
    expect(text({ kind: 'declared' })).toContain('Configured')
  })

  it('reports a public claim the declaration outranks, and says it is not applied', () => {
    const rendered = text({ kind: 'declared', notApplied: ['low', 'medium', 'high'] })
    expect(rendered).toContain('Configured')
    expect(rendered).toContain('not applied')
    expect(rendered).toContain('Low · Medium · High')
  })

  it('keeps a unique id-only claim distinguishable from an applied capability', () => {
    const rendered = text({
      kind: 'id-only',
      claims: [{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] }],
    })
    expect(rendered).toContain('route could not be verified')
    // A suggestion never prints an applied level set of its own.
    expect(rendered).not.toContain('Reasoning')
  })

  it('reports disagreement without choosing a winner, and lists the claims', () => {
    const rendered = text({
      kind: 'id-only',
      claims: [
        { source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] },
        { source: 'models.dev', provider: 'other', levels: ['low', 'high', 'max'] },
      ],
    })
    expect(rendered).toContain('Multiple public providers report different effort sets')
    expect(rendered).toContain('models.dev / cortecs: Low · High')
    expect(rendered).toContain('models.dev / other: Low · High · Max')
  })

  it('says the layer is disabled rather than showing an absence of claims', () => {
    expect(text({ kind: 'disabled' })).toContain('Public metadata is disabled')
  })

  it('renders nothing at all when there is nothing to say', () => {
    expect(text({ kind: 'none' })).toBe('')
    expect(text({ kind: 'none' })).not.toContain('Reasoning')
  })

  it('omits an age it cannot read rather than reporting a nonsense one', () => {
    const rendered = text({
      kind: 'public',
      levels: ['low'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'cache',
      fetchedAt: 'not-a-time',
    })
    // The tier still reads; only the unreadable age is left out.
    expect(rendered).toContain('Cached metadata')
    expect(rendered).not.toContain('updated')
  })

  it('dates a fetch against the render clock when no clock is supplied', () => {
    const state: CapabilityProvenanceState = {
      kind: 'public',
      levels: ['low'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'live',
      fetchedAt: new Date().toISOString(),
    }
    const { container } = render(<CapabilityProvenance state={state} t={t} />)
    expect(container.textContent).toContain('updated just now')
  })
})

describe('what the row exposes to assistive technology', () => {
  it('pairs every term with its value as a description list', () => {
    const { container } = render(
      <CapabilityProvenance
        state={{
          kind: 'public',
          levels: ['low'],
          source: 'models.dev',
          provider: 'cortecs',
          match: 'provider-host',
          origin: 'bundled',
        }}
        now={NOW}
        t={t}
      />,
    )
    const terms = [...container.querySelectorAll('dt')].map(node => node.textContent)
    expect(terms).toEqual(['Reasoning', 'Source', 'Matched provider'])
    expect([...container.querySelectorAll('dd')].length).toBeGreaterThanOrEqual(terms.length)
  })

  it('carries the authoritative-versus-suggestion distinction in words, not only in tone', () => {
    const applied = text({
      kind: 'public',
      levels: ['low'],
      source: 'models.dev',
      provider: 'cortecs',
      match: 'provider-host',
      origin: 'bundled',
    })
    const suggested = text({
      kind: 'id-only',
      claims: [{ source: 'models.dev', provider: 'cortecs', levels: ['low'] }],
    })
    expect(applied).not.toBe(suggested)
    expect(suggested).toContain('could not be verified')
    expect(applied).not.toContain('could not be verified')
  })
})

describe('the lookup the page builds', () => {
  it('keys a row by its route and model, so two routes cannot collide', () => {
    expect(capabilityKey('cortex', 'gpt-5.6-sol')).not.toBe(capabilityKey('commandcode', 'gpt-5.6-sol'))
  })

  it('projects one route out of the page map', () => {
    const other = view({
      route: 'commandcode',
      model: 'gpt-5.6-sol',
      resolved: {
        levels: ['low', 'max'],
        source: 'models.dev',
        provider: 'cortecs',
        match: 'provider-id',
        origin: 'bundled',
      },
    })
    const capabilities = new Map([
      [capabilityKey('cortex', 'gpt-5.6-sol'), view({ model: 'gpt-5.6-sol' })],
      [capabilityKey('commandcode', 'gpt-5.6-sol'), other],
      [capabilityKey('commandcode', 'other-model'), view({ route: 'commandcode', model: 'other-model' })],
    ])
    const route = routeCapabilities(capabilities, 'commandcode')
    expect([...route.keys()]).toEqual(['gpt-5.6-sol', 'other-model'])
    expect(route.get('gpt-5.6-sol')).toEqual(other)
  })

  it('states nothing for a route the page has no answer for', () => {
    expect([...routeCapabilities(undefined, 'cortex')]).toEqual([])
    expect([...routeCapabilities(new Map(), 'cortex')]).toEqual([])
  })

  it('shows the same model differently through two routes', () => {
    const capabilities = new Map([
      [capabilityKey('cortex', 'gpt-5.6-sol'), view({
        resolved: {
          levels: ['low', 'medium', 'high'],
          source: 'models.dev',
          provider: 'cortecs',
          match: 'provider-host',
          origin: 'cache',
          fetchedAt: '2026-09-16T11:42:00.000Z',
        },
      })],
      [capabilityKey('commandcode', 'gpt-5.6-sol'), view({
        route: 'commandcode',
        suggestions: [{ source: 'models.dev', provider: 'cortecs', levels: ['low', 'high'] }],
      })],
    ])
    const matched = routeCapabilities(capabilities, 'cortex').get('gpt-5.6-sol')
    const suggested = routeCapabilities(capabilities, 'commandcode').get('gpt-5.6-sol')
    expect(capabilityProvenance(matched, UNDECLARED)).toMatchObject({ kind: 'public' })
    expect(capabilityProvenance(suggested, UNDECLARED)).toMatchObject({ kind: 'id-only' })
  })
})
