import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import * as CustomHarness from '@deepseek-ai/dsh-custom-harness'

const POLICY_PARAGRAPHS = CustomHarness.HARNESSY_OPERATIONAL_POLICY.split('\n\n')

describe('the Harnessy operational policy', () => {
  it('applies to every agent scope and disappears when the product row unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment identity.' })
      const fiber = await ctx.plugin(CustomHarness)
      const scoped = await ctx.systemPrompt.assemble({ scope: { agent: 'child' } })
      const policy = scoped.sections.find(section => section.name === 'harnessy:operational-policy')

      expect(policy?.text).toContain('Generate a new image only when the user explicitly asks')
      expect(policy?.text).toContain('stop after the first failed access check')
      expect(policy?.text).toContain('Do not keep retrying')

      await fiber.dispose()
      expect((await ctx.systemPrompt.assemble()).sections)
        .not.toContainEqual(expect.objectContaining({ name: 'harnessy:operational-policy' }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps complete-prompt and external CLI entry paths aligned with the product policy', () => {
    const bundlePatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const minimalPatch = readFileSync(new URL('../presets/minimal.patch.yml', import.meta.url), 'utf8')

    for (const paragraph of POLICY_PARAGRAPHS) {
      expect(bundlePatch).toContain(paragraph)
      expect(minimalPatch).toContain(paragraph)
    }
  })
})
