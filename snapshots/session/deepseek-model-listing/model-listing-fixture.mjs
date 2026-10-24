/** Fixed external listing response exercised through the real official provider. */
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const inject = ['tools', 'llm']

/** Register the listing probe and restore the exact fetch owner at unload. */
export function apply(ctx) {
  let requests = 0
  let announcements = 0
  ctx.effect(() => {
    const previous = console.error
    const observeListing = (...args) => {
      if (args.length === 2 && args[0] === '[llm-deepseek-api-key]'
        && args[1] === 'model listing from https://api.deepseek.com/models loaded 1 model(s), skipped 0 row(s)') {
        announcements += 1
        return
      }
      previous(...args)
    }
    console.error = observeListing
    return () => {
      if (console.error !== observeListing) throw new Error('model-listing-fixture: diagnostic owner changed')
      console.error = previous
    }
  })
  ctx.effect(() => {
    const previous = globalThis.fetch
    const fetchListing = async (input, init) => {
      const request = new Request(input, init)
      if (request.url !== 'https://api.deepseek.com/models' || request.method !== 'GET') {
        throw new Error('model-listing-fixture: unexpected external request')
      }
      if (request.headers.get('x-api-key') !== 'fixture-only') throw new Error('model-listing-fixture: missing fixture credential')
      requests += 1
      return new Response(JSON.stringify({ data: [{
        id: 'listed-fixture', name: 'Listed fixture model', context_window: 4321,
        input_modalities: ['text'], client_requirements: { 'deepseek-harness': { min_version: '0.0.1' } },
        api_capabilities: { anthropic_messages: {} },
      }] }), { headers: { 'content-type': 'application/json' } })
    }
    globalThis.fetch = fetchListing
    return () => {
      if (globalThis.fetch !== fetchListing) throw new Error('model-listing-fixture: fetch owner changed')
      globalThis.fetch = previous
    }
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'inspect_model_catalog', description: 'Inspect the available official model catalog.', parameters: {},
    execute: async () => {
      const models = await ctx.llm.listModels('deepseek-official')
      const resolved = await Promise.all(models.map(async model => {
        const info = await ctx.llm.resolveModelInfo('deepseek-official', model.id)
        return { id: model.id, name: model.name, contextWindow: info.context.contextWindow, inputModalities: model.inputModalities }
      }))
      return [{ type: 'text', text: JSON.stringify({ requests, announcements, models: resolved }) }]
    },
  })))
}
