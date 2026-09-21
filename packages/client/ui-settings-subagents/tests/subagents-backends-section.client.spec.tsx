// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommandCodeCatalog,
  CommandCodeHealth,
  ModelCatalog,
  SubagentAutomaticRouting,
  SubagentDefinition,
  SubagentRoleView,
  SubagentSettings,
  SubagentStoredRoster,
  SubagentWorkspaceRoster,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SubagentsSection } from '../src/client/SubagentsSection.tsx'
import type { SubagentBackendProbe, SubagentsOperations, SubagentsSectionProps } from '../src/client/SubagentsSection.tsx'
import { createSubagentsSectionStore } from '../src/client/section-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { vi.restoreAllMocks() })

const WORKSPACE = 'a:\\work'
/** Revision the mirrored snapshot reports, and the fence every settled write carries. */
const REVISION = 7
const BACKEND = 'commandcode'

const RUNTIME_CATALOG: ModelCatalog = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
      ],
    },
  ],
  failures: [],
}

const COMMAND_CODE_CATALOG: CommandCodeCatalog = {
  models: [
    { id: 'deepseek/deepseek-v4.1-flash', description: 'fast' },
    { id: 'local-model', description: 'local' },
  ],
}
const FLASH = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }
/** One route the backend-owned listing advertises, so its levels apply to it. */
const LOCAL = { provider: BACKEND, model: 'local-model' }
const CHAT = { provider: 'deepseek', model: 'deepseek-chat' }
const GHOST = { provider: 'ghost', model: 'gone' }

/** Translate one dictionary entry the way the locale service does, placeholders included. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template: string = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in params ? String(params[name]) : whole)
}

/** One dictionary entry with its single `{backend}` placeholder resolved. */
function backendText(key: keyof typeof en, backend: string): string {
  return translate(key, { backend })
}

function definition(id: string, overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id,
    name: id === 'code' ? 'Code' : id,
    enabled: true,
    purpose: `${id} purpose`,
    whenToUse: '',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'workspace-write',
    instructions: '',
    execution: { backend: 'spawn', background: 'auto' },
    ...overrides,
  }
}

function settings(overrides: Partial<SubagentSettings> = {}): SubagentSettings {
  return {
    subagents: [definition('code')],
    overrides: {},
    automaticRouting: { enabled: false, allowedModels: [] },
    limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 },
    ...overrides,
  }
}

/** Resolve one workspace's roles the way the Host does. */
function resolvedRoles(value: SubagentSettings, workspace: string | null): SubagentWorkspaceRoster {
  return {
    workspaceKey: workspace,
    subagents: value.subagents
      .filter(stored => stored.enabled)
      .map((stored): SubagentRoleView => ({
        id: stored.id,
        name: stored.name,
        purpose: stored.purpose,
        whenToUse: stored.whenToUse,
        invocation: stored.invocation,
        model: stored.model,
        access: stored.access,
        execution: stored.execution,
        overrides: {
          name: false,
          purpose: false,
          whenToUse: false,
          invocation: false,
          model: false,
          access: false,
          tools: false,
          instructions: false,
          maxDepth: false,
          execution: false,
          enabled: false,
        },
      })),
  }
}

/** The reads one probe answers, as the mount's options supply them. */
interface ProbeOptions {
  readonly health?: (signal: AbortSignal) => Promise<CommandCodeHealth>
  readonly catalog?: (signal: AbortSignal) => Promise<CommandCodeCatalog>
}

interface MountOptions {
  readonly value?: SubagentSettings
  /** The composed probe: omitted for the shipped reads, `null` for a deployment that composes none. */
  readonly probe?: ProbeOptions | null
  readonly catalog?: ModelCatalog
}

function mount(options: MountOptions = {}) {
  let current = options.value ?? settings()
  const store = createSubagentsSectionStore().create()
  const listeners = new Set<() => void>()
  const publish = (): void => {
    store.actions.sync({ status: 'ready', writable: true, revision: REVISION, value: current })
    for (const listener of [...listeners]) listener()
  }
  const useStore = <Selected,>(
    selector: (state: ReturnType<typeof store.getSnapshot>) => Selected,
  ): Selected => selector(useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => store.getSnapshot(),
  ))
  publish()

  const write = vi.fn<SubagentsOperations['write']>(async (patch) => {
    current = { ...current, ...patch }
    publish()
  })
  const probe: SubagentBackendProbe | undefined = options.probe === null
    ? undefined
    : {
      backend: BACKEND,
      health: options.probe?.health ?? (async () => ({ command: 'cmdc', installed: true, authenticated: true })),
      catalog: options.probe?.catalog ?? (async () => COMMAND_CODE_CATALOG),
    }
  const operations: SubagentsOperations = {
    snapshot: () => ({ status: 'ready', writable: true, revision: REVISION, value: current }),
    subscribe: () => () => {},
    write,
    storedRoster: async (): Promise<SubagentStoredRoster> => ({
      subagents: current.subagents.map(stored => structuredClone(stored)),
      limits: { ...current.limits },
    }),
    resolvedRoster: async (target): Promise<SubagentWorkspaceRoster> => resolvedRoles(current, target),
    automaticRouting: async (): Promise<SubagentAutomaticRouting> => ({
      enabled: current.automaticRouting.enabled,
      allowedModels: current.automaticRouting.allowedModels.map(route => ({ ...route })),
    }),
    modelCatalog: async (): Promise<ModelCatalog> => options.catalog ?? RUNTIME_CATALOG,
    backendProbe: probe,
  }

  const useSessions = <Selected,>(selector: (state: {
    current: string | undefined
    byId: Record<string, { cwd?: string }>
  }) => Selected): Selected => selector({
    current: 'session-1',
    byId: { 'session-1': { cwd: WORKSPACE } },
  })

  const props = {
    useStore,
    useSessions,
    close: () => {},
    presentModal: () => () => {},
    t: translate,
    operations,
  } as unknown as SubagentsSectionProps
  render(<SubagentsSection {...props} />)
  return { write }
}

/** One definition's card. */
function card(name: string): HTMLElement {
  return screen.getByRole('article', { name })
}

/** Expand one definition's card. */
function expand(name: string): void {
  fireEvent.click(within(card(name)).getByRole('button', { name: en.cardExpand }))
}

/** One card's model control. */
function modelControl(name: string): HTMLElement {
  return within(card(name)).getByLabelText(en.fieldModel)
}

/** The label one control currently shows on its trigger. */
function shownValue(control: HTMLElement): string {
  return control.textContent ?? ''
}

/** The option labels one control offers, read from its opened popup. */
function optionsOf(control: HTMLElement): string[] {
  fireEvent.click(control)
  const labels = screen.getAllByRole('option').map(option => option.textContent ?? '')
  fireEvent.keyDown(control, { key: 'Escape' })
  return labels
}

/** Pick the option whose visible label is `label`. */
function pick(control: HTMLElement, label: string): void {
  fireEvent.click(control)
  fireEvent.click(screen.getByRole('option', { name: label }))
}

/** The Backends block's region. */
function block(): HTMLElement {
  return screen.getByRole('region', { name: en.backendsTitle })
}

/** The definitions the last write stored. */
function written(write: ReturnType<typeof mount>['write']): SubagentDefinition[] {
  return write.mock.calls.at(-1)?.[0].subagents ?? []
}

/** A read this test settles by hand, with the signal the page handed it. */
function deferredRead<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

describe('Subagents Backends block', () => {
  it('keeps runtime diagnostics collapsed until the summary is opened', () => {
    mount()
    const details = block().querySelector('details')
    if (details === null) throw new Error('runtime status has no disclosure')
    expect(details.open).toBe(false)

    fireEvent.click(within(block()).getByText(en.backendsTitle))
    expect(details.open).toBe(true)
    expect(within(block()).getByText(en.backendsDescription)).toBeTruthy()
  })

  it('reports the backend a role runs on and its detected version and sign-in state', async () => {
    mount({
      value: settings({ subagents: [definition('code', { execution: { backend: BACKEND, background: 'auto' } })] }),
      probe: { health: async () => ({ command: 'cmdc', installed: true, authenticated: true, version: '1.54.0' }) },
    })

    expect(within(block()).getByText(BACKEND)).toBeTruthy()
    await waitFor(() => {
      expect(within(block()).getByText(`${en.backendDetected} · ${en.backendVersionLead} 1.54.0 · ${en.backendAuthenticated}`))
        .toBeTruthy()
    })
  })

  it('reports a detected backend that reports no version', async () => {
    mount({ probe: { health: async () => ({ command: 'cmdc', installed: true, authenticated: true }) } })
    await waitFor(() => {
      expect(within(block()).getByText(`${en.backendDetected} · ${en.backendAuthenticated}`)).toBeTruthy()
    })
  })

  it('reports runtime authentication failure in a role setup check', async () => {
    mount({
      probe: { health: async () => ({ command: 'cmdc', installed: true, authenticated: false }) },
      value: settings({
        subagents: [definition('code', {
          whenToUse: 'Use for code changes.',
          execution: { backend: BACKEND, background: 'auto' },
        })],
      }),
    })
    expand('Code')

    fireEvent.click(within(card('Code')).getByRole('button', { name: en.setupCheck }))

    await waitFor(() => { expect(within(card('Code')).getByText(en.setupRuntimeAttention)).toBeTruthy() })
    expect(within(card('Code')).getByText(en.setupAttention)).toBeTruthy()
  })

  it('names the login command instead of a version when the backend is not signed in', async () => {
    mount({ probe: { health: async () => ({ command: 'cmdc', installed: true, authenticated: false }) } })

    await waitFor(() => {
      expect(within(block()).getByText(`${en.backendDetected} · ${en.backendNotAuthenticated}`)).toBeTruthy()
    })
    expect(within(block()).getByText(translate('backendLoginHint', { command: 'cmdc' }))).toBeTruthy()
  })

  it('reports an absent backend with the executable it looked for, and its own explanation', async () => {
    mount({ probe: { health: async () => ({ command: 'cmdc', installed: false, authenticated: false, detail: 'Install it.' }) } })

    await waitFor(() => { expect(within(block()).getByText(`${en.backendMissing} · cmdc`)).toBeTruthy() })
    expect(within(block()).getByText('Install it.')).toBeTruthy()
  })

  it('falls back to the login command when an absent backend carries no explanation', async () => {
    mount({ probe: { health: async () => ({ command: 'cmdc', installed: false, authenticated: false }) } })

    await waitFor(() => {
      expect(within(block()).getByText(translate('backendLoginHint', { command: 'cmdc' }))).toBeTruthy()
    })
  })

  it('reports a failed read as an unknown backend rather than as an absent one', async () => {
    mount({ probe: { health: async () => { throw new Error('probe unavailable') } } })

    await waitFor(() => { expect(within(block()).getByText(en.backendCheckFailed)).toBeTruthy() })
    // A backend that could not be asked is never presented as one that answered.
    expect(within(block()).queryByText(new RegExp(en.backendMissing, 'u'))).toBeNull()
    expect(within(block()).queryByText(new RegExp(en.backendDetected, 'u'))).toBeNull()
  })

  it('reports every backend a role names, saying which ones can answer for themselves', async () => {
    mount({
      value: settings({
        subagents: [
          definition('code'),
          definition('review', { execution: { backend: BACKEND, background: 'auto' } }),
        ],
      }),
    })

    const rows = within(block()).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toHaveLength(2)
    expect(within(rows[0]!).getByText(BACKEND)).toBeTruthy()
    expect(within(rows[1]!).getByText('spawn')).toBeTruthy()
    // The backend with no readiness surface reports exactly that, and nothing about itself.
    expect(within(rows[1]!).getByText(en.backendSilent)).toBeTruthy()
    expect(within(rows[1]!).queryByRole('button', { name: en.backendRefresh })).toBeNull()
  })

  it('renders without the Command Code Remote namespace, inventing no state for any backend', () => {
    mount({
      probe: null,
      value: settings({ subagents: [definition('code', { execution: { backend: BACKEND, background: 'auto' } })] }),
    })

    expect(within(block()).getByText(BACKEND)).toBeTruthy()
    expect(within(block()).getByText(en.backendSilent)).toBeTruthy()
    expect(within(block()).queryByText(en.backendChecking)).toBeNull()
    expect(within(block()).queryByRole('button', { name: en.backendRefresh })).toBeNull()
    expect(within(block()).queryByText(new RegExp(`${en.backendDetected}|${en.backendMissing}`, 'u'))).toBeNull()
  })

  it('has nothing to report while no role names a backend and none is probed', () => {
    mount({ probe: null, value: settings({ subagents: [] }) })
    expect(within(block()).getByText(en.backendsEmpty)).toBeTruthy()
  })

  it('aborts the in-flight readiness read when the page unmounts', async () => {
    const pending = deferredRead<CommandCodeHealth>()
    const signals: AbortSignal[] = []
    mount({
      probe: {
        health: (signal) => {
          signals.push(signal)
          return pending.promise
        },
      },
    })

    await waitFor(() => { expect(signals).toHaveLength(1) })
    cleanup()
    expect(signals[0]?.aborted).toBe(true)
  })

  it('aborts a superseded readiness read and lets the newer one answer', async () => {
    const first = deferredRead<CommandCodeHealth>()
    const second = deferredRead<CommandCodeHealth>()
    const signals: AbortSignal[] = []
    mount({
      probe: {
        health: (signal) => {
          signals.push(signal)
          return signals.length === 1 ? first.promise : second.promise
        },
      },
    })

    await waitFor(() => { expect(signals).toHaveLength(1) })
    expect(within(block()).getByRole('button', { name: en.backendRefreshing })).toBeTruthy()
    fireEvent.click(within(block()).getByRole('button', { name: en.backendRefreshing }))
    await waitFor(() => { expect(signals).toHaveLength(2) })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    // The read the refresh superseded must not land on top of the newer one.
    first.settle({ command: 'cmdc', installed: false, authenticated: false })
    await waitFor(() => {
      expect(within(block()).queryByText(`${en.backendMissing} · cmdc`)).toBeNull()
    })
    second.settle({ command: 'cmdc', installed: true, authenticated: true, version: '1.54.0' })
    await waitFor(() => {
      expect(within(block()).getByText(`${en.backendDetected} · ${en.backendVersionLead} 1.54.0 · ${en.backendAuthenticated}`))
        .toBeTruthy()
    })
  })
})

describe('Subagents picker catalog source', () => {
  it('sources a runtime-resolvable role from the global catalog', async () => {
    mount({ catalog: RUNTIME_CATALOG })
    expand('Code')

    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('DeepSeek Chat') })
    expect(optionsOf(modelControl('Code'))).not.toContain('deepseek/deepseek-v4.1-flash')
    expect(within(card('Code')).queryByText(en.modelSourceRuntime)).toBeNull()
  })

  it('sources a role whose backend owns its model space from that backend\'s catalog', async () => {
    mount({
      value: settings({
        subagents: [definition('code', {
          execution: { backend: BACKEND, background: 'auto' },
          model: { mode: 'fixed', route: FLASH },
        })],
      }),
    })
    expand('Code')

    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('deepseek/deepseek-v4.1-flash') })
    expect(optionsOf(modelControl('Code'))).not.toContain('DeepSeek Chat')
    expect(shownValue(modelControl('Code'))).toBe(`deepseek-v4.1-flash ${en.modelUnavailableSuffix}`)
    expect(within(card('Code')).queryByText(backendText('modelSourceBackend', BACKEND))).toBeNull()
    expect(within(card('Code')).queryByText(en.modelSourceRuntime)).toBeNull()
  })

  it('reports a setup check as pending while a backend-owned catalog read is in flight', () => {
    const pending = deferredRead<CommandCodeCatalog>()
    mount({
      probe: { catalog: () => pending.promise },
      value: settings({
        subagents: [definition('code', { execution: { backend: BACKEND, background: 'auto' } })],
      }),
    })
    expand('Code')
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.setupCheck }))

    expect(within(card('Code')).getByText(en.setupChecking)).toBeTruthy()
    expect(within(card('Code')).getByText(en.setupCheckingDescription)).toBeTruthy()
  })

  it('switches the catalog source when the role\'s backend changes', async () => {
    mount({ catalog: RUNTIME_CATALOG })
    expand('Code')
    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('DeepSeek Chat') })

    fireEvent.change(within(card('Code')).getByLabelText(en.fieldBackend), { target: { value: BACKEND } })

    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('deepseek/deepseek-v4.1-flash') })
    expect(optionsOf(modelControl('Code'))).not.toContain('DeepSeek Chat')
    expect(within(card('Code')).queryByText(en.modelSourceRuntime)).toBeNull()
  })

  it('keeps a saved route the new source cannot advertise, and lets it go', async () => {
    const { write } = mount({
      value: settings({
        subagents: [definition('code', {
          execution: { backend: BACKEND, background: 'auto' },
          model: { mode: 'fixed', route: GHOST },
        })],
      }),
    })
    expand('Code')

    const model = modelControl('Code')
    await waitFor(() => { expect(optionsOf(model)).toContain(`gone ${en.modelUnavailableSuffix}`) })
    expect(shownValue(model)).toBe(`gone ${en.modelUnavailableSuffix}`)

    pick(model, en.modelInheritOption)
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'fixed' }) })
  })

  it('degrades a failed backend catalog read to the saved model, with a notice', async () => {
    mount({
      probe: { catalog: async () => { throw new Error('catalog unavailable') } },
      value: settings({
        subagents: [definition('code', {
          execution: { backend: BACKEND, background: 'auto' },
          model: { mode: 'fixed', route: FLASH },
        })],
      }),
    })
    expand('Code')

    await waitFor(() => {
      expect(within(card('Code')).getByText(backendText('modelSourceFailed', BACKEND))).toBeTruthy()
    })
    // The saved route stays selected and removable rather than the picker emptying.
    expect(shownValue(modelControl('Code'))).toBe(`deepseek-v4.1-flash ${en.modelUnavailableSuffix}`)
    expect(optionsOf(modelControl('Code'))).toContain(`deepseek-v4.1-flash ${en.modelUnavailableSuffix}`)
  })

  it('keeps a saved model on a backend-owned role with no probe composed at all', () => {
    mount({
      probe: null,
      value: settings({
        subagents: [definition('code', {
          execution: { backend: BACKEND, background: 'auto' },
          model: { mode: 'fixed', route: FLASH },
        })],
      }),
    })
    expand('Code')

    expect(shownValue(modelControl('Code'))).toBe(`deepseek-v4.1-flash ${en.modelUnavailableSuffix}`)
    expect(within(card('Code')).getByText(backendText('modelSourceFailed', BACKEND))).toBeTruthy()
  })
})

describe('Subagents picker reasoning levels', () => {
  /** The role card's reasoning-effort control. */
  function effortControl(name: string): HTMLElement {
    return within(card(name)).getByLabelText(en.fieldEffort)
  }

  /** Mount one role on the Command Code backend, pinned to its advertised route. */
  function mountBackendRole(route: { reasoningEffort?: string } = {}): ReturnType<typeof mount> {
    const subject = mount({
      value: settings({
        subagents: [definition('code', {
          execution: { backend: BACKEND, background: 'auto' },
          model: { mode: 'fixed', route: { ...LOCAL, ...route } },
        })],
      }),
    })
    expand('Code')
    return subject
  }

  it('offers a backend-owned role the levels that backend accepts', async () => {
    mountBackendRole()

    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('local-model') })
    expect(optionsOf(effortControl('Code')))
      .toEqual([en.effortDefault, en.effortLow, en.effortMedium, en.effortHigh])
    expect(shownValue(effortControl('Code'))).toBe(en.effortDefault)
  })

  it('describes a backend-owned effort control with the backend\'s own rule', async () => {
    mountBackendRole()

    await waitFor(() => {
      const describedBy = effortControl('Code').getAttribute('aria-describedby')
      expect(describedBy).not.toBeNull()
      expect(document.getElementById(describedBy!)?.textContent).toBe(en.fieldEffortBackendHint)
    })
  })

  it('shows a stored level again after a reload, as one of the levels on offer', async () => {
    mountBackendRole({ reasoningEffort: 'medium' })

    await waitFor(() => { expect(shownValue(effortControl('Code'))).toBe(en.effortMedium) })
    expect(optionsOf(effortControl('Code'))).toContain(en.effortMedium)
    expect(within(card('Code')).getByText(/^Code · local-model · Medium/u)).toBeTruthy()
  })

  it('stores the level a backend-owned role is given', async () => {
    const { write } = mountBackendRole({ reasoningEffort: 'high' })

    await waitFor(() => { expect(shownValue(effortControl('Code'))).toBe(en.effortHigh) })
    pick(effortControl('Code'), en.effortMedium)
    await waitFor(() => {
      expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: { ...LOCAL, reasoningEffort: 'medium' } })
    })
  })

  it('stores no effort when the model default is chosen', async () => {
    const { write } = mountBackendRole({ reasoningEffort: 'high' })

    await waitFor(() => { expect(shownValue(effortControl('Code'))).toBe(en.effortHigh) })
    pick(effortControl('Code'), en.effortDefault)
    await waitFor(() => {
      expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: LOCAL })
    })
  })

  it('still offers a global-catalog model only the levels it advertises', async () => {
    mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: CHAT } })] }),
    })
    expand('Code')

    await waitFor(() => { expect(optionsOf(modelControl('Code'))).toContain('DeepSeek Chat') })
    // The runtime catalog advertises low and high for this model; the backend
    // vocabulary neither adds to that list nor describes it.
    expect(optionsOf(effortControl('Code'))).toEqual([en.effortDefault, en.effortLow, en.effortHigh])
    const describedBy = effortControl('Code').getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toBe(en.fieldEffortHint)
  })
})
