// @vitest-environment jsdom
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, onTestFinished } from 'vitest'
import type { ComponentProps } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en, zh } from '../src/client/locales.ts'

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    ...overrides,
  }
}

function mount(overrides: Partial<ComponentProps<typeof ModelSelect>> = {}) {
  const directory = overrides.directory ?? createSnapshotStore(state())
  const load = overrides.load ?? vi.fn()
  const select = overrides.select ?? vi.fn().mockResolvedValue({ ok: true, value: undefined })
  render(<ModelSelect
    locked={false}
    fastEnabled={false}
    available
    directory={directory}
    load={load}
    select={select}
    t={t}
    {...overrides}
  />)
  return { directory, load, select }
}

function doubleClick(element: HTMLElement): void {
  fireEvent.click(element, { detail: 1 })
  fireEvent.click(element, { detail: 2 })
  fireEvent.doubleClick(element, { detail: 2 })
}

afterEach(cleanup)

describe('ModelSelect dialog', () => {
  it('opens one searchable picker with models and thinking levels', () => {
    const { load } = mount()

    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: zh['dialog.title'] })
    expect(load).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: zh['dialog.searchAria'] }))
    expect(within(dialog).getByRole('radio', { name: /DeepSeek-V4-Flash/ })).toBeTruthy()
    expect(within(dialog).getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).queryByText('Accounts')).toBeNull()
  })

  it('filters by model and provider metadata and explains an empty search', () => {
    mount({ directory: createSnapshotStore(state({
      groups: [
        ...state().groups,
        { id: 'openrouter', name: 'OpenRouter', models: [
          { id: 'anthropic/claude', name: 'Claude Sonnet', description: 'Balanced coding model' },
        ] },
      ],
    })) })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    const search = screen.getByRole('textbox', { name: zh['dialog.searchAria'] })

    fireEvent.change(search, { target: { value: 'balanced' } })
    expect(screen.queryByRole('radio', { name: /DeepSeek-V4-Flash/ })).toBeNull()
    expect(screen.getByRole('radio', { name: /Claude Sonnet/ })).toBeTruthy()

    fireEvent.change(search, { target: { value: 'missing model' } })
    expect(screen.getByText(zh['empty.search'])).toBeTruthy()
  })

  it('ranks fuzzy model names while keeping provider groups and staged selection', () => {
    const { select } = mount({ directory: createSnapshotStore(state({
      groups: [{ id: 'openrouter', name: 'OpenRouter', models: [
        { id: 'claude-opus', name: 'Claude Opus' },
        { id: 'claude-sonnet', name: 'Claude Sonnet' },
      ] }],
    })) })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['dialog.searchAria'] }), {
      target: { value: 'clsn' },
    })
    expect(screen.queryByRole('radio', { name: /Claude Opus/ })).toBeNull()
    expect(screen.getByRole('radio', { name: /Claude Sonnet/ })).toBeTruthy()
    expect(screen.getByText('OpenRouter')).toBeTruthy()
    expect(select).not.toHaveBeenCalled()
  })

  it('stages a model, then applies the model and thinking level together and closes', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        ...state().groups[0]!.models,
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
      ],
    }]
    const directory = createSnapshotStore(state({ groups }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ groups, current: selection }))
      return { ok: true as const, value: undefined }
    })
    mount({ directory, select })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))

    fireEvent.click(screen.getByRole('radio', { name: /DeepSeek-V4-Pro/ }))
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /DeepSeek-V4-Pro/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max',
      })
      expect(screen.getByRole('button', { name: /推理等级 Max/ })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: zh['dialog.title'] })).toBeNull()
    })
  })

  it('applies only a model on double-click and closes', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        ...state().groups[0]!.models,
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning },
      ],
    }]
    const directory = createSnapshotStore(state({ groups }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ groups, current: selection }))
      return { ok: true as const, value: undefined }
    })
    mount({ directory, select })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))

    doubleClick(screen.getByRole('radio', { name: /DeepSeek-V4-Pro/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledOnce()
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
      })
      expect(screen.queryByRole('dialog', { name: zh['dialog.title'] })).toBeNull()
    })
  })

  it('applies only a thinking level on double-click and closes', async () => {
    const directory = createSnapshotStore(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    mount({ directory, select })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))

    doubleClick(screen.getByRole('radio', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledOnce()
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
      })
      expect(screen.queryByRole('dialog', { name: zh['dialog.title'] })).toBeNull()
    })
  })

  it('offers provider default only when the model has no configured default', () => {
    mount({ directory: createSnapshotStore(state({
      groups: [{ id: 'provider', name: 'Provider', models: [{
        id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
      }] }],
      current: { provider: 'provider', model: 'model' },
    })) })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    const effortGroup = screen.getByRole('radiogroup', { name: zh['dialog.effort'] })
    expect(within(effortGroup).getAllByRole('radio').map(row => row.textContent)).toEqual(['Default', 'Standard'])
  })

  it('shows an explanation when the selected model has no thinking metadata', () => {
    mount({ directory: createSnapshotStore(state({
      groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
      current: { provider: 'provider', model: 'model' },
    })) })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.getByText(zh['empty.efforts'])).toBeTruthy()
  })

  it('keeps the durable route visible when its catalog model is absent', () => {
    mount({ directory: createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model', reasoningEffort: 'high' },
      retainedEffort: 'High',
    })) })
    const trigger = screen.getByRole('button', { name: /deepseek-official\/removed-model/ })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('radio', { name: /removed-model/ })).toBeNull()
    expect(screen.getByRole('radio', { name: /DeepSeek-V4-Flash/ })).toBeTruthy()
  })

  it('shows catalog load failures and retries without closing', () => {
    const load = vi.fn()
    mount({
      load,
      directory: createSnapshotStore(state({
        status: 'error',
        error: 'catalog down',
        failures: [{ id: 'gateway', name: 'Gateway', message: 'bad credentials' }],
      })),
    })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.getByText('模型操作失败：catalog down')).toBeTruthy()
    expect(screen.getByText('Gateway 加载失败：bad credentials')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: zh['action.reload'] })[0]!)
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog', { name: zh['dialog.title'] })).toBeTruthy()
  })

  it.each([
    ['model unavailability', false],
    ['writer contention', true],
  ] as const)('announces %s and leaves the picker open', async (_scenario, sessionInUse) => {
    const groups = [{ id: 'provider', name: 'Provider', models: [
      { id: 'one', name: 'One' }, { id: 'two', name: 'Two' },
    ] }]
    const directory = createSnapshotStore(state({ groups, current: { provider: 'provider', model: 'one' } }))
    const select = vi.fn(async () => ({
      ok: false as const,
      error: sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'not available', { provider: 'provider', model: 'two' }),
    }))
    mount({ directory, select })
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    doubleClick(screen.getByRole('radio', { name: /Two/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : '模型操作失败：session/model-unavailable: not available')
    expect(screen.getByRole('dialog', { name: zh['dialog.title'] })).toBeTruthy()
  })

  it('shows pending feedback on the trigger and selected row', () => {
    const groups = [{ id: 'provider', name: 'Provider', models: [
      { id: 'one', name: 'One' }, { id: 'two', name: 'Two' },
    ] }]
    const directory = createSnapshotStore(state({ groups, current: { provider: 'provider', model: 'one' } }))
    const select = vi.fn((selection: ModelSelection) => {
      directory.set(state({ groups, current: { provider: 'provider', model: 'one' }, status: 'selecting', pending: selection }))
      return new Promise<undefined>(() => {})
    })
    mount({ directory, select })
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    doubleClick(screen.getByRole('radio', { name: /Two/ }))
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole('radio', { name: /Two/ }).querySelector('[data-state="ongoing"]')).not.toBeNull()
  })

  it('closes with Escape and restores focus to the trigger', () => {
    mount()
    const trigger = screen.getByRole('button', { name: /选择模型/ })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: zh['dialog.title'] })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

it('disables the trigger when the composer is locked', () => {
  mount({ locked: true })
  expect(screen.getByRole('button', { name: /选择模型/ }).hasAttribute('disabled')).toBe(true)
})

it('renders no Agent-bound control for an addressed subagent session', () => {
  const load = vi.fn()
  mount({ available: false, load })
  expect(screen.queryByRole('button')).toBeNull()
  expect(load).not.toHaveBeenCalled()
})

it('opens an unselected model picker directly and retains its effort caption', () => {
  mount({ directory: createSnapshotStore(state({ current: null, routable: false, retainedEffort: 'High' })) })
  const trigger = screen.getByRole('button', { name: zh['trigger.selectAria'] })
  expect(trigger.textContent).toContain('High')
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: zh['dialog.title'] })).toBeTruthy()
  expect(screen.getByRole('radio', { name: /DeepSeek-V4-Flash/ })).toBeTruthy()
})

it('places account and official models before third-party providers without mutating the catalog', () => {
  const groups = ['custom', 'deepseek-official', 'deepseek-account', 'another'].map(id => ({
    id,
    name: id,
    models: [{ id: `${id}-model`, name: `${id}-model` }],
  }))
  mount({ directory: createSnapshotStore(state({ current: null, groups })) })
  fireEvent.click(screen.getByRole('button', { name: zh['trigger.selectAria'] }))
  expect(screen.getAllByRole('radio').map(row => row.textContent)).toEqual([
    'deepseek-account-modeldeepseek-account · deepseek-account-model',
    'deepseek-official-modeldeepseek-official · deepseek-official-model',
    'custom-modelcustom · custom-model',
    'another-modelanother · another-model',
  ])
  expect(groups.map(group => group.id)).toEqual(['custom', 'deepseek-official', 'deepseek-account', 'another'])
})

it.each([en, zh])('localizes the account provider while preserving external names', (copy) => {
  const translate: ComponentProps<typeof ModelSelect>['t'] = key => copy[key as keyof typeof copy] ?? key
  mount({
    t: translate,
    directory: createSnapshotStore(state({
      current: null,
      groups: [
        { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'one', name: 'One' }] },
        { id: 'custom', name: 'My Gateway', models: [{ id: 'two', name: 'Two' }] },
      ],
    })),
  })
  fireEvent.click(screen.getByRole('button', { name: copy['trigger.selectAria'] }))
  expect(screen.getByRole('group', { name: copy['provider.account'] })).toBeTruthy()
  expect(screen.getByRole('group', { name: 'My Gateway' })).toBeTruthy()
})

it.each([
  ['Codex on', 'openai-codex', true, true],
  ['Codex off', 'openai-codex', false, false],
  ['GPT on another provider', 'openai', true, false],
  ['another provider on', 'deepseek-official', true, false],
] as const)('shows the saved fast preference only on the Codex route: %s', (_scenario, provider, fastEnabled, visible) => {
  mount({ fastEnabled, directory: createSnapshotStore(state({
    current: { provider, model: 'gpt-5', reasoningEffort: 'high' },
    groups: [{ id: provider, name: provider, models: [{ id: 'gpt-5', name: 'GPT-5', reasoning }] }],
  })) })
  const trigger = screen.getByRole('button', { name: /选择模型/ })
  expect(trigger.getAttribute('aria-label')?.includes('本会话已开启 Codex 快速模式')).toBe(visible)
  expect(trigger.title.includes('本会话已开启 Codex 快速模式')).toBe(visible)
  expect(trigger.firstElementChild?.getAttribute('fill')).toBe(visible ? 'currentColor' : 'none')
  expect(trigger.querySelectorAll('svg')).toHaveLength(2)
  expect(trigger.textContent).toBe('GPT-5High')
})

it.each([en, zh])('localizes the fast state without adding an action or replacing pending feedback', (copy) => {
  const translate: ComponentProps<typeof ModelSelect>['t'] = makeTranslate(copy)
  mount({ t: translate, fastEnabled: true, directory: createSnapshotStore(state({
    current: { provider: 'openai-codex', model: 'custom-model' },
    groups: [{ id: 'openai-codex', name: 'Codex', models: [{ id: 'custom-model', name: 'Custom model' }] }],
    status: 'selecting',
    pending: { provider: 'openai-codex', model: 'next-model' },
  })) })
  const trigger = screen.getByRole('button')
  const stateLabel = copy['trigger.fast'].replace('{selection} · ', '')
  expect(trigger.getAttribute('aria-label')).toContain(stateLabel)
  expect(trigger.title).toBe(`Custom model · ${stateLabel}`)
  expect(trigger.getAttribute('aria-busy')).toBe('true')
  expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()
  expect(trigger.firstElementChild?.getAttribute('fill')).toBe('currentColor')
})

it('keeps the saved fast preference visible when the Codex catalog model is absent', () => {
  mount({ fastEnabled: true, directory: createSnapshotStore(state({
    current: { provider: 'openai-codex', model: 'removed-model', reasoningEffort: 'high' },
    groups: [], routable: false, retainedEffort: 'High',
  })) })
  const trigger = screen.getByRole('button', { name: /openai-codex\/removed-model/ })
  expect(trigger.title).toBe('openai-codex/removed-model · High · 本会话已开启 Codex 快速模式')
  expect(trigger.firstElementChild?.getAttribute('fill')).toBe('currentColor')
})

it('hides fast mode without a selected route even when the saved preference is on', () => {
  mount({ fastEnabled: true, directory: createSnapshotStore(state({ current: null })) })
  const trigger = screen.getByRole('button', { name: zh['trigger.selectAria'] })
  expect(trigger.title).toBe(zh['trigger.fallback'])
  expect(trigger.firstElementChild?.getAttribute('fill')).toBe('none')
})

it('restores the catalog name after account login without changing the saved route', () => {
  const groups = [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning },
  ] }]
  const selected = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  const directory = createSnapshotStore(state({ current: selected, groups, retainedEffort: 'High' }))
  mount({ directory })
  expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toBe('DeepSeek FlashHigh')
  act(() => { directory.update((snapshot) => { snapshot.groups = []; snapshot.routable = false }) })
  expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toBe('deepseek-account/deepseek-flashHigh')
  act(() => { directory.update((snapshot) => { snapshot.groups = groups; snapshot.routable = true }) })
  expect(screen.getByRole('button', { name: /选择模型，当前/ }).textContent).toBe('DeepSeek FlashHigh')
  expect(directory.getSnapshot().current).toEqual(selected)
})


it('opens the existing model dialog without mobile search focus and permits explicit typing', () => {
  const detection = vi.spyOn(uiPrimitives, 'isMobileDevice').mockReturnValue(true)
  onTestFinished(() => { detection.mockRestore() })
  mount()
  fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4-Flash/ }))
  const dialog = screen.getByRole('dialog')
  const search = within(dialog).getByRole('textbox')
  expect(document.activeElement).not.toBe(search)
  expect(dialog.contains(document.activeElement)).toBe(true)
  act(() => { search.focus() })
  expect(document.activeElement).toBe(search)
  fireEvent.change(search, { target: { value: 'absent-model' } })
  expect(within(dialog).queryByRole('radio', { name: /DeepSeek-V4-Flash/ })).toBeNull()
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
