import { describe, expect, it } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SUBAGENT_MODEL_AUTOMATIC_SELECTION,
  selectSubagentModel,
  subagentEffortName,
  subagentEfforts,
  subagentModelChoices,
  subagentModelDirectory,
  subagentModelKey,
  subagentModelName,
  subagentModelSelection,
  withSubagentEffort,
} from '../src/client/catalog.ts'

const GROUPS: ModelProviderGroup[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      },
      { id: 'deepseek-plain', name: 'DeepSeek Plain' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-sol', name: 'GPT-5.6 Sol', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
    ],
  },
]

const CHAT = { provider: 'deepseek', model: 'deepseek-chat' }
const SOL = { provider: 'openai', model: 'gpt-sol' }

describe('subagent model choices', () => {
  it('lists every advertised route in catalog order', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(choices.map(choice => choice.key)).toEqual([
      subagentModelKey(CHAT),
      subagentModelKey({ provider: 'deepseek', model: 'deepseek-plain' }),
      subagentModelKey(SOL),
    ])
    expect(choices.every(choice => choice.available)).toBe(true)
    expect(choices[0]?.providerName).toBe('DeepSeek')
    expect(choices[0]?.modelName).toBe('DeepSeek Chat')
  })

  it('keeps a stored route the catalog no longer advertises', () => {
    const ghost = { provider: 'ghost', model: 'gone' }
    const choices = subagentModelChoices(GROUPS, [ghost])
    const stored = choices.at(-1)
    expect(stored?.key).toBe(subagentModelKey(ghost))
    expect(stored?.available).toBe(false)
    expect(stored?.efforts).toEqual([])
  })

  it('does not list a stored route twice when the catalog still advertises it', () => {
    const choices = subagentModelChoices(GROUPS, [{ provider: 'openai', model: 'gpt-sol' }])
    expect(choices.filter(choice => choice.key === subagentModelKey(SOL))).toHaveLength(1)
  })

  it('splits advertised groups from the leftovers', () => {
    const ghost = { provider: 'ghost', model: 'gone' }
    const directory = subagentModelDirectory(subagentModelChoices(GROUPS, [ghost]))
    expect(directory.groups.map(group => group.provider)).toEqual(['deepseek', 'openai'])
    expect(directory.groups[0]?.providerName).toBe('DeepSeek')
    expect(directory.groups[0]?.choices).toHaveLength(2)
    expect(directory.unavailable.map(choice => choice.key)).toEqual([subagentModelKey(ghost)])
  })

  it('names a route from the catalog, falling back to provider over model', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(subagentModelName(choices, SOL)).toBe('GPT-5.6 Sol')
    expect(subagentModelName(choices, { provider: 'ghost', model: 'gone' })).toBe('ghost/gone')
  })

  it('reports no selectable level for a model that advertises no reasoning', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(subagentEfforts(choices, { mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-plain' } }))
      .toEqual([])
    expect(subagentEfforts(choices, { mode: 'automatic' })).toEqual([])
    expect(subagentEfforts(choices, undefined)).toEqual([])
  })

  it('offers only the levels the pinned model advertises', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(subagentEfforts(choices, { mode: 'fixed', route: CHAT }).map(effort => effort.id))
      .toEqual(['low', 'high'])
  })

  it('names a stored effort, and falls back to the stored id when it is no longer advertised', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(subagentEffortName(choices, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }))
      .toBe('High')
    expect(subagentEffortName(choices, { provider: 'openai', model: 'gpt-sol', reasoningEffort: 'high' }))
      .toBe('high')
    expect(subagentEffortName(choices, SOL)).toBeUndefined()
    expect(subagentEffortName(choices, undefined)).toBeUndefined()
  })
})

describe('model selection', () => {
  it('renders the stored policy as its select value', () => {
    expect(subagentModelSelection(undefined)).toBe('')
    expect(subagentModelSelection({ mode: 'fixed' })).toBe('')
    expect(subagentModelSelection({ mode: 'automatic' })).toBe(SUBAGENT_MODEL_AUTOMATIC_SELECTION)
    expect(subagentModelSelection({ mode: 'fixed', route: SOL })).toBe(subagentModelKey(SOL))
  })

  it('stores inherit, automatic, and a pinned route for the three selections', () => {
    const choices = subagentModelChoices(GROUPS, [])
    expect(selectSubagentModel(choices, undefined, '')).toEqual({ mode: 'fixed' })
    expect(selectSubagentModel(choices, undefined, SUBAGENT_MODEL_AUTOMATIC_SELECTION)).toEqual({ mode: 'automatic' })
    expect(selectSubagentModel(choices, undefined, subagentModelKey(SOL)))
      .toEqual({ mode: 'fixed', route: { provider: 'openai', model: 'gpt-sol' } })
  })

  it('carries an effort the newly selected model still advertises', () => {
    const choices = subagentModelChoices(GROUPS, [])
    const next = selectSubagentModel(
      choices,
      { mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-plain', reasoningEffort: 'high' } },
      subagentModelKey(CHAT),
    )
    expect(next).toEqual({ mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
  })

  it('clears an effort the newly selected model does not advertise', () => {
    const choices = subagentModelChoices(GROUPS, [])
    const next = selectSubagentModel(
      choices,
      { mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
      subagentModelKey(SOL),
    )
    expect(next).toEqual({ mode: 'fixed', route: { provider: 'openai', model: 'gpt-sol' } })
  })

  it('clears the effort when the newly selected model advertises none at all', () => {
    const choices = subagentModelChoices(GROUPS, [])
    const next = selectSubagentModel(
      choices,
      { mode: 'fixed', route: { provider: 'openai', model: 'gpt-sol', reasoningEffort: 'low' } },
      subagentModelKey({ provider: 'deepseek', model: 'deepseek-plain' }),
    )
    expect(next).toEqual({ mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-plain' } })
  })

  it('keeps the current policy for a selection the picker never offered', () => {
    const choices = subagentModelChoices(GROUPS, [])
    const current = { mode: 'fixed' as const, route: SOL }
    expect(selectSubagentModel(choices, current, 'not-a-route')).toBe(current)
    expect(selectSubagentModel(choices, undefined, 'not-a-route')).toEqual({ mode: 'fixed' })
  })

  it('stores one effort on a route, or clears it back to the model default', () => {
    expect(withSubagentEffort(SOL, 'low')).toEqual({ provider: 'openai', model: 'gpt-sol', reasoningEffort: 'low' })
    expect(withSubagentEffort({ provider: 'openai', model: 'gpt-sol', reasoningEffort: 'low' }, ''))
      .toEqual({ provider: 'openai', model: 'gpt-sol' })
  })
})
