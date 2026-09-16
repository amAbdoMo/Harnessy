// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

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
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', description: 'Fast', reasoning },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek-V4-Pro',
          reasoning: { ...reasoning, defaultEffort: 'off' },
        },
      ],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

function renderPicker(initial = state(), selectOverride?: (selection: ModelSelection) => Promise<boolean>) {
  const directory = createSnapshotStore<ModelDirectoryState>(initial)
  const select = vi.fn(selectOverride ?? (async (selection: ModelSelection) => {
    directory.set(state({ ...directory.getSnapshot(), current: selection, status: 'ready' }))
    return true
  }))
  const load = vi.fn()
  render(<ModelSelect locked={false} available directory={directory} load={load} select={select} t={t} />)
  const trigger = screen.getByRole('button', { name: /选择模型/ })
  fireEvent.click(trigger)
  return { directory, load, select, trigger }
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('ModelSelect dialog', () => {
  it('opens the two-column picker immediately from the resident catalog', () => {
    const { load } = renderPicker()
    expect(screen.getByRole('dialog', { name: '模型与推理等级' })).toBeTruthy()
    expect(screen.getByRole('listbox', { name: '可用模型' })).toBeTruthy()
    expect(within(screen.getByRole('listbox', { name: '推理等级' })).getAllByRole('option').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('stages a model, then submits it with a single-clicked effort and closes', async () => {
    vi.useFakeTimers()
    const { select } = renderPicker()
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek-V4-Pro/ }))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: 'Max' }))
    expect(select).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(230); await Promise.resolve() })
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('double-clicks a model to change only the model while preserving a supported effort', async () => {
    const { select } = renderPicker()
    fireEvent.doubleClick(screen.getByRole('option', { name: /DeepSeek-V4-Pro/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledTimes(1)
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high',
      })
    })
  })

  it('double-clicks an effort to change only the effort and cancels a pending pair', async () => {
    vi.useFakeTimers()
    const { select } = renderPicker()
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek-V4-Pro/ }))
    const max = screen.getByRole('option', { name: 'Max' })
    fireEvent.click(max)
    fireEvent.doubleClick(max)
    await act(async () => { vi.advanceTimersByTime(230); await Promise.resolve() })
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
  })

  it('filters model names, ids, and providers without requesting the catalog again', () => {
    const { load } = renderPicker()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索可用模型' }), { target: { value: 'v4-pro' } })
    expect(screen.queryByRole('option', { name: /DeepSeek-V4-Flash/ })).toBeNull()
    expect(screen.getByRole('option', { name: /DeepSeek-V4-Pro/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索可用模型' }), { target: { value: 'missing' } })
    expect(screen.getByText('没有匹配的模型。')).toBeTruthy()
    expect(load).not.toHaveBeenCalled()
  })

  it('offers provider default when the adapter does not define a model default', () => {
    renderPicker(state({
      current: { provider: 'provider', model: 'model' },
      groups: [{
        id: 'provider', name: 'Provider', models: [{
          id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
    }))
    expect(within(screen.getByRole('listbox', { name: '推理等级' })).getAllByRole('option').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('lists only the levels the staged model supports', () => {
    const { trigger } = renderPicker(state({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
          {
            id: 'narrow',
            name: 'Narrow',
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] },
          },
        ],
      }],
    }))
    const levels = () => within(screen.getByRole('listbox', { name: '推理等级' }))
      .getAllByRole('option').map(item => item.textContent)

    expect(levels()).toEqual(['Off', 'High', 'Max'])
    // Staging another model replaces the pane: the offer is that model's own
    // declared levels, plus the provider-default entry while it declares no
    // default of its own.
    fireEvent.click(screen.getByRole('option', { name: /Narrow/ }))
    expect(levels()).toEqual(['Default', 'Low', 'Medium'])
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek-V4-Flash/ }))
    expect(levels()).toEqual(['Off', 'High', 'Max'])
    expect(trigger).toBeTruthy()
  })

  it('resets an effort the newly chosen model does not support to its own default', async () => {
    const { select } = renderPicker(state({
      // The session is running the widest effort this route offers.
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
          {
            id: 'narrow',
            name: 'Narrow',
            reasoning: {
              efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
              defaultEffort: 'low',
            },
          },
        ],
      }],
    }))

    fireEvent.doubleClick(screen.getByRole('option', { name: /Narrow/ }))
    await waitFor(() => {
      // `max` is not one of the new model's levels, so carrying it over would
      // be a selection the adapter refuses; its own default answers instead.
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official', model: 'narrow', reasoningEffort: 'low',
      })
    })
  })

  it('discards staged values on close and restores focus to the trigger', async () => {
    const { select, trigger } = renderPicker()
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(screen.getByRole('button', { name: '关闭模型选择器' }))
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(select).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the dialog open and announces a rejected selection', async () => {
    const groups = [{
      id: 'deepseek-official', name: 'DeepSeek', models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'plain', name: 'Plain model' },
      ],
    }]
    const initial = state({ groups })
    const directory = createSnapshotStore<ModelDirectoryState>(initial)
    const select = vi.fn(async () => {
      directory.set({ ...initial, status: 'error', error: 'session/model-unavailable' })
      return false
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('option', { name: /Plain model/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('session/model-unavailable')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
