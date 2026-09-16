import { describe, expect, it } from 'vitest'
import type { CommandCodeCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { subagentBackendRows } from '../src/client/backends.ts'
import {
  commandCodeModelGroups,
  subagentCatalogOwner,
  subagentModelChoices,
  subagentModelDirectory,
  subagentModelKey,
} from '../src/client/catalog.ts'

describe('roster backend rows', () => {
  it('reports a probed backend first and the remaining named backends after it', () => {
    expect(subagentBackendRows(['spawn', 'commandcode'], ['commandcode'])).toEqual([
      { backend: 'commandcode', probed: true },
      { backend: 'spawn', probed: false },
    ])
  })

  it('lists a backend a role names without a probe as one this deployment cannot ask', () => {
    expect(subagentBackendRows(['fork', 'spawn'], [])).toEqual([
      { backend: 'fork', probed: false },
      { backend: 'spawn', probed: false },
    ])
  })

  it('lists a probed backend once when no role names it', () => {
    expect(subagentBackendRows([], ['commandcode'])).toEqual([
      { backend: 'commandcode', probed: true },
    ])
  })

  it('keeps one row per backend when several roles name the same one', () => {
    expect(subagentBackendRows(['spawn', 'spawn', 'commandcode'], ['commandcode'])).toEqual([
      { backend: 'commandcode', probed: true },
      { backend: 'spawn', probed: false },
    ])
  })

  it('reports nothing to route to when no role names a backend and none is probed', () => {
    expect(subagentBackendRows([], [])).toEqual([])
  })
})

describe('catalog ownership', () => {
  it('sends a backend that owns its model space to its own catalog', () => {
    expect(subagentCatalogOwner('commandcode')).toBe('backend')
  })

  it('leaves every other backend on the runtime catalog', () => {
    expect(subagentCatalogOwner('spawn')).toBe('runtime')
    expect(subagentCatalogOwner('fork')).toBe('runtime')
  })
})

const CATALOG: CommandCodeCatalog = {
  models: [
    { id: 'deepseek/deepseek-v4.1-flash', description: 'fast' },
    { id: 'deepseek/deepseek-v4-pro', description: 'deep' },
    { id: 'z-ai/glm-5.3-flash', description: 'cheap' },
    { id: 'local-model', description: 'local' },
  ],
}

describe('backend-owned catalog projection', () => {
  it('groups the whole listing under the backend that owns it, in listing order', () => {
    const groups = commandCodeModelGroups(CATALOG, 'commandcode')
    expect(groups.map(group => group.id)).toEqual(['commandcode'])
    expect(groups[0]?.name).toBe('commandcode')
    expect(groups[0]?.models.map(model => model.id)).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4-pro',
      'z-ai/glm-5.3-flash',
      'local-model',
    ])
  })

  it('keeps a slash in an id part of the model, because the CLI takes the whole id', () => {
    const groups = commandCodeModelGroups(CATALOG, 'commandcode')
    expect(groups.map(group => group.id)).not.toContain('deepseek')
    expect(groups[0]?.models[0]?.id).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('shows the full listing id, so the offered row names what the CLI accepts', () => {
    const groups = commandCodeModelGroups(CATALOG, 'commandcode')
    expect(groups[0]?.models[0]?.name).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('projects an id exactly as the roster migration does, so one model is one route', () => {
    const directory = subagentModelDirectory(subagentModelChoices(commandCodeModelGroups(CATALOG, 'commandcode'), []))
    // `migrate.ts` projects the lane's model id onto this exact route: the whole
    // CLI id is the model and the backend that owns that model space is the
    // provider. A projection that disagreed would read the same model back as
    // unavailable — and, worse, would ask the CLI for a truncated id.
    expect(directory.groups[0]?.choices[0]?.key)
      .toBe(subagentModelKey({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }))
    expect(directory.unavailable).toEqual([])
  })

  it('treats a route the migration projected as the listing\'s own entry', () => {
    for (const stored of [
      { provider: 'commandcode', model: 'local-model' },
      { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    ]) {
      const directory = subagentModelDirectory(subagentModelChoices(commandCodeModelGroups(CATALOG, 'commandcode'), [stored]))
      expect(directory.unavailable).toEqual([])
    }
  })

  it('advertises no reasoning levels, because the listing states none', () => {
    const choices = subagentModelChoices(commandCodeModelGroups(CATALOG, 'commandcode'), [])
    expect(choices.every(choice => choice.efforts.length === 0)).toBe(true)
  })
})
