import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { reportSnapshotAge } from '@deepseek-ai/dsh-model-capabilities/plugin'

/** Records what the age diagnostic said, so a test can assert its exact wording. */
function logger(): { warn: (message: string) => void; warnings: string[] } {
  const warnings: string[] = []
  return { warnings, warn: (message: string) => { warnings.push(message) } }
}

/** One day in the units the diagnostic measures age in. */
const DAY_MS = 24 * 60 * 60 * 1000

/** The instant every age case is measured from. */
const NOW = Date.parse('2026-09-16T12:00:00.000Z')

describe('the bundled snapshot age diagnostic', () => {
  it('says nothing while the snapshot is inside the advisory window', () => {
    const sink = logger()
    reportSnapshotAge(sink as unknown as Context['logger'], new Date(NOW - 89 * DAY_MS).toISOString(), NOW)
    reportSnapshotAge(sink as unknown as Context['logger'], new Date(NOW).toISOString(), NOW)
    expect(sink.warnings).toEqual([])
  })

  it('warns, without failing, once the snapshot reaches the window', () => {
    const sink = logger()
    reportSnapshotAge(sink as unknown as Context['logger'], new Date(NOW - 90 * DAY_MS).toISOString(), NOW)
    reportSnapshotAge(sink as unknown as Context['logger'], new Date(NOW - 400 * DAY_MS).toISOString(), NOW)
    expect(sink.warnings).toEqual([
      'model-capabilities: the bundled snapshot is 90 days old; run `pnpm run gen-model-capability-snapshot` when refreshing it is intended',
      'model-capabilities: the bundled snapshot is 400 days old; run `pnpm run gen-model-capability-snapshot` when refreshing it is intended',
    ])
  })

  it('names an unreadable generation time rather than reporting a nonsense age', () => {
    const sink = logger()
    reportSnapshotAge(sink as unknown as Context['logger'], 'not-a-time', NOW)
    expect(sink.warnings).toEqual(['model-capabilities: the bundled snapshot states no usable generation time'])
  })

  it('is wired to the bundled artifact the plugin actually ships', async () => {
    // The diagnostic is only useful if the mount passes the real artifact's
    // timestamp, so the metadata the module exports is what a mount reads.
    const { bundledSnapshotMetadata } = await import('@deepseek-ai/dsh-model-capabilities')
    const sink = logger()
    reportSnapshotAge(sink as unknown as Context['logger'], bundledSnapshotMetadata.generatedAt, NOW)
    expect(sink.warnings).toHaveLength(0)
  })
})

describe('the failure diagnostic', () => {
  it('names the database and the reason it kept its previous catalog', async () => {
    const { createPublicCatalogStore } = await import('@deepseek-ai/dsh-model-capabilities')
    const warnings: string[] = []
    const store = createPublicCatalogStore({
      policy: () => ({ enabled: true, refresh: 'auto', cacheTtlMs: 1000 }),
      fetchCatalog: source => Promise.reject(new Error(`offline: ${source}`)),
      onFailure: (source, reason) => warnings.push(`${source}:${reason}`),
    })
    await store.load()
    await store.refresh(new AbortController().signal)
    expect(warnings).toEqual(['openrouter:fetch-failed', 'models.dev:fetch-failed'])
  })
})

describe('an unexpected refresh failure', () => {
  it('is reported once instead of escaping as an unhandled rejection', async () => {
    const { apply } = await import('@deepseek-ai/dsh-model-capabilities/plugin')
    const { Context } = await import('@deepseek-ai/cordis')
    const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
    const { createPublicCatalogStore } = await import('@deepseek-ai/dsh-model-capabilities')
    const ctx = new Context()
    const warn = vi.fn()
    vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warn(...args) })
    await ctx.plugin(LlmRuntime)
    try {
      // A store whose refresh rejects stands in for a programming error inside
      // the layer: the plugin must contain it and keep serving.
      apply(ctx, { publicMetadata: { enabled: true, refresh: 'auto', cacheTtl: '7d' } }, () => ({
        ...createPublicCatalogStore({
          policy: () => ({ enabled: true, refresh: 'auto', cacheTtlMs: 1000 }),
          fetchCatalog: () => Promise.reject(new Error('never reached')),
        }),
        refresh: () => Promise.reject(new Error('unexpected')),
      }))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(warn).toHaveBeenCalledWith('model-capabilities: the public metadata refresh failed unexpectedly')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
