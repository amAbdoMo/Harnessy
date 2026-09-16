// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandCodeDelegationView, ResolvedCommandCodeLane } from '@deepseek-ai/dsh-api-remotes/client'
import { DelegationSection, type DelegationOperations, type DelegationSectionProps } from '../src/client/DelegationSection.tsx'
import { createDelegationSectionStore } from '../src/client/delegation-section-store.ts'
import { COMMAND_CODE_OVERRIDE_FIELDS } from '../src/client/edit.ts'
import { DEFAULT_COMMAND_CODE_MODEL } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import type { CommandCodeDelegationSettings, CommandCodeLaneSetting } from '../src/client/contract.ts'

afterEach(cleanup)
beforeEach(() => { vi.restoreAllMocks() })

const WORKSPACE = 'a:\\work'

function lane(id: string, overrides: Partial<CommandCodeLaneSetting> = {}): CommandCodeLaneSetting {
  return {
    id, name: id, purpose: `${id} purpose`, instructions: '', model: 'deepseek/deepseek-v4.1-flash',
    effort: 'default', access: 'read-only', enabled: true, ...overrides,
  }
}

function settings(overrides: Partial<CommandCodeDelegationSettings> = {}): CommandCodeDelegationSettings {
  return {
    maxConcurrentRuns: 2,
    timeoutMs: 3_600_000,
    maxTurns: 60,
    lanes: [lane('code', { access: 'full-access' }), lane('review')],
    projects: {},
    ...overrides,
  }
}

/** Resolve one section the way the Host does, including per-field provenance. */
function resolvedLanes(value: CommandCodeDelegationSettings): ResolvedCommandCodeLane[] {
  const project = value.projects[WORKSPACE]
  return value.lanes.map((stored) => {
    const override = project?.lanes[stored.id]
    return {
      id: stored.id,
      name: override?.name ?? stored.name,
      purpose: override?.purpose ?? stored.purpose,
      instructions: override?.instructions ?? stored.instructions,
      model: override?.model ?? stored.model,
      effort: override?.effort ?? stored.effort,
      access: override?.access ?? stored.access,
      enabled: override?.enabled ?? stored.enabled,
      overrides: {
        name: override?.name !== undefined,
        purpose: override?.purpose !== undefined,
        instructions: override?.instructions !== undefined,
        model: override?.model !== undefined,
        effort: override?.effort !== undefined,
        access: override?.access !== undefined,
        enabled: override?.enabled !== undefined,
      },
    }
  })
}

function view(value: CommandCodeDelegationSettings): CommandCodeDelegationView {
  return {
    workspaceKey: WORKSPACE,
    maxConcurrentRuns: value.maxConcurrentRuns,
    timeoutMs: value.timeoutMs,
    maxTurns: value.maxTurns,
    lanes: resolvedLanes(value),
  }
}

interface MountOptions {
  readonly value?: CommandCodeDelegationSettings
  readonly writable?: boolean
  /** The Session's workspace; `null` stands in for a Session that has none. */
  readonly workspace?: string | null
  readonly health?: { installed: boolean; authenticated: boolean; version?: string; command?: string; detail?: string }
  readonly delegation?: CommandCodeDelegationView
  readonly catalog?: { models: Array<{ id: string; description: string }> }
}

function mount(options: MountOptions = {}) {
  const writable = options.writable ?? true
  let current = options.value ?? settings()
  const store = createDelegationSectionStore().create()
  // The engine batches subscriber notification to the next animation frame; a
  // test renders the same section state without waiting a frame for it.
  const listeners = new Set<() => void>()
  const publish = (): void => {
    store.actions.sync({ status: 'ready', writable, value: current })
    for (const listener of [...listeners]) listener()
  }
  const useStore = <Selected,>(selector: (state: ReturnType<typeof store.getSnapshot>) => Selected): Selected =>
    selector(useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      () => store.getSnapshot(),
    ))
  publish()

  let viewCalls = 0
  // Models the settings scope: a write folds into the mirrored document before
  // it settles, which is what makes the section re-resolve its view afterwards.
  const write = vi.fn<DelegationOperations['write']>(async (patch) => {
    current = { ...current, ...patch }
    publish()
  })
  const operations: DelegationOperations = {
    snapshot: () => ({ status: 'ready', writable, value: current }),
    subscribe: () => () => {},
    write,
    health: async () => ({
      command: options.health?.command ?? 'cmdc',
      installed: options.health?.installed ?? true,
      authenticated: options.health?.authenticated ?? true,
      ...options.health?.version === undefined ? {} : { version: options.health.version },
      ...options.health?.detail === undefined ? {} : { detail: options.health.detail },
    }),
    catalog: async () => options.catalog ?? { models: [{ id: 'deepseek/deepseek-v4.1-flash', description: 'flash' }] },
    view: async (workspace) => {
      viewCalls += 1
      const resolved = options.delegation ?? view(current)
      return workspace === null ? { ...resolved, workspaceKey: null } : resolved
    },
  }

  const useSessions = <Selected,>(selector: (state: {
    current: string | undefined
    byId: Record<string, { cwd?: string }>
  }) => Selected): Selected => {
    const workspace = options.workspace === undefined ? WORKSPACE : options.workspace
    return selector({
      current: workspace === null ? undefined : 'session-1',
      byId: workspace === null ? {} : { 'session-1': { cwd: workspace } },
    })
  }

  const props = {
    useStore,
    useSessions,
    close: () => {},
    presentModal: () => () => {},
    t: (key: keyof typeof en) => en[key],
    operations,
  } as unknown as DelegationSectionProps
  render(<DelegationSection {...props} />)
  return { write, viewCalls: () => viewCalls }
}

/** The override editor fieldset one lane owns, once the Host view has resolved. */
async function laneEditor(laneId: string): Promise<HTMLElement> {
  const legend = await screen.findByText(
    new RegExp(`^${laneId} — \\d+ of ${String(COMMAND_CODE_OVERRIDE_FIELDS.length)} fields overridden$`, 'u'),
  )
  const fieldset = legend.closest('fieldset')
  if (fieldset === null) throw new Error(`lane ${laneId} has no override editor`)
  return fieldset
}

/** The last patch one write received. */
function lastPatch(write: ReturnType<typeof mount>['write']): Partial<CommandCodeDelegationSettings> {
  return write.mock.calls.at(-1)?.[0] ?? {}
}

describe('Harnessy Delegation section', () => {
  it('reports the installed CLI, its version, and its sign-in state', async () => {
    mount({ health: { installed: true, authenticated: true, version: '1.54.0' } })
    await waitFor(() => {
      expect(screen.getByText(/Detected · Version 1\.54\.0 · Signed in/u)).toBeTruthy()
    })
  })

  it('shows login guidance instead of a fallback when no CLI is installed', async () => {
    mount({ health: { installed: false, authenticated: false, detail: 'Install it.' } })
    await waitFor(() => {
      expect(screen.getByText(/Install it\./u)).toBeTruthy()
    })
  })

  it('labels the dangerous full-access consequence on the access control', () => {
    mount()
    expect(screen.getAllByText(en.accessFullAccessWarning).length).toBeGreaterThan(0)
  })

  it('names each run limit exactly, with its hint described rather than labelled', () => {
    mount()
    for (const [label, hint] of [
      [en.concurrency, en.concurrencyHint],
      [en.timeout, en.timeoutHint],
      [en.turns, en.turnsHint],
    ] as const) {
      const control = screen.getByLabelText(label)
      expect(control).toHaveProperty('type', 'number')
      // The hint is an accessible description, never part of the visible name.
      const describedBy = control.getAttribute('aria-describedby')
      expect(describedBy).not.toBeNull()
      expect(document.getElementById(describedBy!)?.textContent).toBe(hint)
    }
  })

  it('saves the limits the user edits', async () => {
    const { write } = mount()
    fireEvent.change(screen.getByLabelText(en.concurrency), { target: { value: '4' } })
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({ maxConcurrentRuns: 4 })
    })
  })

  it('saves a renamed global lane', async () => {
    const { write } = mount()
    fireEvent.change(screen.getAllByLabelText(en.laneName)[0]!, { target: { value: 'Reviewer' } })
    await waitFor(() => {
      const lanes = lastPatch(write).lanes as CommandCodeLaneSetting[]
      expect(lanes[0]?.name).toBe('Reviewer')
      expect(lanes[1]?.name).toBe('review')
    })
  })

  it('adds a lane under a derived id', async () => {
    const { write } = mount()
    fireEvent.change(screen.getByLabelText(en.laneAddTitle), { target: { value: 'Security' } })
    fireEvent.click(screen.getByRole('button', { name: en.laneCreate }))
    await waitFor(() => {
      const lanes = lastPatch(write).lanes as CommandCodeLaneSetting[]
      expect(lanes.map(entry => entry.id)).toEqual(['code', 'review', 'security'])
    })
  })

  it('creates a usable lane when the advisory model catalog could not be read', async () => {
    const { write } = mount({ catalog: { models: [] } })
    fireEvent.change(screen.getByLabelText(en.laneAddTitle), { target: { value: 'Security' } })
    fireEvent.click(screen.getByRole('button', { name: en.laneCreate }))
    await waitFor(() => { expect(write).toHaveBeenCalled() })

    const lanes = lastPatch(write).lanes as CommandCodeLaneSetting[]
    const created = lanes.find(entry => entry.id === 'security')
    // Without a catalog the lane still starts on a model the Host accepts, so
    // the documented manual exact-id fallback is reachable.
    expect(created?.model).toBe(DEFAULT_COMMAND_CODE_MODEL)
    expect(created?.model.trim().length).toBeGreaterThan(0)
  })

  it('deletes a lane and its overrides once the user confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { write } = mount({
      value: settings({ projects: { [WORKSPACE]: { lanes: { code: { model: 'local/model' } } } } }),
    })
    fireEvent.click(screen.getAllByRole('button', { name: en.laneDelete })[0]!)
    await waitFor(() => {
      const patch = lastPatch(write)
      expect((patch.lanes as CommandCodeLaneSetting[]).map(entry => entry.id)).toEqual(['review'])
      expect(patch.projects).toEqual({})
    })
  })

  it('leaves the section alone when the user cancels the delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { write } = mount()
    fireEvent.click(screen.getAllByRole('button', { name: en.laneDelete })[0]!)
    expect(write).not.toHaveBeenCalled()
  })

  it('disables every editor when the settings document is read-only', async () => {
    mount({ writable: false })
    expect(screen.getByLabelText(en.concurrency)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.laneCreate })).toHaveProperty('disabled', true)
    expect(within(await laneEditor('code')).getByLabelText(en.laneEnabled)).toHaveProperty('disabled', true)
    await waitFor(() => { expect(screen.getByText(en.readOnly)).toBeTruthy() })
  })

  it('invites a workspace before offering project overrides', async () => {
    mount({ workspace: null })
    await waitFor(() => {
      expect(screen.getByText(en.projectNoWorkspace)).toBeTruthy()
    })
  })

  it('groups every lane override editor under its own legend', async () => {
    mount()
    const groups = await screen.findAllByRole('group')
    expect(groups).toHaveLength(2)
    const legend = `code — 0 of ${String(COMMAND_CODE_OVERRIDE_FIELDS.length)} fields overridden`
    expect(within(groups[0]!).getByText(legend).tagName).toBe('LEGEND')
  })

  it('creates the first workspace override from a field that had none', async () => {
    const { write } = mount()
    const editor = await laneEditor('code')

    fireEvent.change(within(editor).getByLabelText(en.laneModel), {
      target: { value: 'local/model' },
    })
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({
        projects: { [WORKSPACE]: { lanes: { code: { model: 'local/model' } } } },
      })
    })
  })

  it('records a boolean override through the checkbox', async () => {
    const { write } = mount()
    const control = within(await laneEditor('review')).getByLabelText(en.laneEnabled)
    expect(control).toHaveProperty('type', 'checkbox')
    expect(control).toHaveProperty('checked', true)

    fireEvent.click(control)
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({
        projects: { [WORKSPACE]: { lanes: { review: { enabled: false } } } },
      })
    })
  })

  it('records enum overrides through their selects', async () => {
    const { write } = mount()
    const editor = await laneEditor('review')

    fireEvent.change(within(editor).getByLabelText(en.laneEffort), { target: { value: 'high' } })
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({
        projects: { [WORKSPACE]: { lanes: { review: { effort: 'high' } } } },
      })
    })

    fireEvent.change(within(editor).getByLabelText(en.laneAccess), { target: { value: 'full-access' } })
    await waitFor(() => {
      // The second choice is computed from the first, so it carries both.
      expect(lastPatch(write).projects).toEqual({
        [WORKSPACE]: { lanes: { review: { effort: 'high', access: 'full-access' } } },
      })
    })
  })

  it('records a long-form instructions override through a textarea', async () => {
    const { write } = mount()
    const control = within(await laneEditor('code')).getByLabelText(en.laneInstructions)
    expect(control.tagName).toBe('TEXTAREA')

    fireEvent.change(control, { target: { value: 'Be terse.' } })
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({
        projects: { [WORKSPACE]: { lanes: { code: { instructions: 'Be terse.' } } } },
      })
    })
  })

  it('composes two edits made before the first write lands', async () => {
    const { write } = mount()
    const editor = await laneEditor('code')

    fireEvent.change(within(editor).getByLabelText(en.laneName), { target: { value: 'Primary' } })
    fireEvent.change(within(editor).getByLabelText(en.lanePurpose), { target: { value: 'Ship it' } })

    await waitFor(() => { expect(write).toHaveBeenCalledTimes(2) })
    // The second edit is computed from the section the first edit produced, so
    // it carries both fields instead of only the later one.
    expect(lastPatch(write).projects).toEqual({
      [WORKSPACE]: { lanes: { code: { name: 'Primary', purpose: 'Ship it' } } },
    })
  })

  it('writes only the top-level field an edit moved', async () => {
    const { write } = mount()
    const editor = await laneEditor('code')

    // A workspace override is a projects edit; it must not carry `lanes`.
    fireEvent.change(within(editor).getByLabelText(en.laneModel), { target: { value: 'local/model' } })
    await waitFor(() => { expect(write).toHaveBeenCalled() })
    const patch = lastPatch(write)
    expect(patch.projects).toBeDefined()
    expect(patch.lanes).toBeUndefined()
  })

  it('marks an overridden field and its neighbours as inherited', async () => {
    mount({ value: settings({ projects: { [WORKSPACE]: { lanes: { code: { model: 'local/model' } } } } }) })
    const editor = await laneEditor('code')
    expect(within(editor).getAllByText(en.projectOverridden)).toHaveLength(1)
    expect(within(editor).getAllByText(en.projectInherited))
      .toHaveLength(COMMAND_CODE_OVERRIDE_FIELDS.length - 1)
  })

  it('resets one overridden field and prunes the empty lane entry', async () => {
    const { write } = mount({
      value: settings({ projects: { [WORKSPACE]: { lanes: { code: { model: 'local/model' } } } } }),
    })
    fireEvent.click(within(await laneEditor('code')).getByRole('button', { name: en.projectReset }))
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({ projects: {} })
    })
  })

  it('resets every override one lane carries', async () => {
    const { write } = mount({
      value: settings({
        projects: { [WORKSPACE]: { lanes: { code: { model: 'local/model', enabled: false } } } },
      }),
    })
    fireEvent.click(within(await laneEditor('code')).getByRole('button', { name: en.projectResetAll }))
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith({ projects: {} })
    })
  })

  it('re-resolves the workspace view after a settings write', async () => {
    const target = mount()
    const editor = await laneEditor('code')
    const before = target.viewCalls()

    fireEvent.change(within(editor).getByLabelText(en.laneModel), { target: { value: 'local/model' } })
    await waitFor(() => { expect(target.write).toHaveBeenCalled() })

    // The resolved view — and with it every overridden/inherited state — must
    // converge on the document the write committed rather than stay stale.
    await waitFor(() => { expect(target.viewCalls()).toBeGreaterThan(before) })
    await waitFor(() => {
      expect(within(screen.getByRole('group', { name: /^code —/u })).getAllByText(en.projectOverridden))
        .toHaveLength(1)
    })
  })
})
