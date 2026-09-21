// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelCatalog,
  SubagentAutomaticRouting,
  SubagentDefinition,
  SubagentRoleView,
  SubagentSettings,
  SubagentStoredRoster,
  SubagentWorkspaceRoster,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SubagentsSection } from '../src/client/SubagentsSection.tsx'
import type { SubagentsOperations, SubagentsSectionProps } from '../src/client/SubagentsSection.tsx'
import { createSubagentsSectionStore } from '../src/client/section-store.ts'
import { SUBAGENT_OVERRIDE_FIELDS } from '../src/client/edit.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { vi.restoreAllMocks() })

const WORKSPACE = 'a:\\work'
/** Revision the mirrored snapshot reports, and the fence every settled write carries. */
const REVISION = 7

const CATALOG: ModelCatalog = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  routableProviders: ['deepseek', 'openai'],
  groups: [
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
        { id: 'gpt-sol', name: 'GPT-5.6 Sol', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] } },
      ],
    },
  ],
  failures: [],
}

const SOL_HIGH = { provider: 'openai', model: 'gpt-sol', reasoningEffort: 'high' }
const SOL_MEDIUM = { provider: 'openai', model: 'gpt-sol', reasoningEffort: 'medium' }
const CHAT = { provider: 'deepseek', model: 'deepseek-chat' }
const GHOST = { provider: 'ghost', model: 'gone' }

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
    subagents: [definition('code'), definition('review', { access: 'read-only' })],
    overrides: {},
    automaticRouting: { enabled: false, allowedModels: [] },
    limits: { maxConcurrentRuns: 2, defaultTimeoutMs: 3_600_000 },
    ...overrides,
  }
}

/** Translate one dictionary entry the way the locale service does, placeholders included. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template: string = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in params ? String(params[name]) : whole)
}

/** Resolve one workspace's roles the way the Host does, provenance included. */
function resolvedRoles(value: SubagentSettings, workspace: string | null): SubagentWorkspaceRoster {
  const project = workspace === null ? undefined : value.overrides[workspace]
  const removed = new Set(project?.removed ?? [])
  return {
    workspaceKey: workspace,
    subagents: value.subagents
      .filter(stored => stored.enabled && !removed.has(stored.id))
      .map((stored): SubagentRoleView => {
        const override = project?.subagents[stored.id]
        return {
          id: stored.id,
          name: override?.name ?? stored.name,
          purpose: override?.purpose ?? stored.purpose,
          whenToUse: override?.whenToUse ?? stored.whenToUse,
          invocation: override?.invocation ?? stored.invocation,
          model: override?.model ?? stored.model,
          access: override?.access ?? stored.access,
          execution: override?.execution ?? stored.execution,
          overrides: {
            name: override?.name !== undefined,
            purpose: override?.purpose !== undefined,
            whenToUse: override?.whenToUse !== undefined,
            invocation: override?.invocation !== undefined,
            model: override?.model !== undefined,
            access: override?.access !== undefined,
            tools: override?.tools !== undefined,
            instructions: override?.instructions !== undefined,
            maxDepth: override?.maxDepth !== undefined,
            execution: override?.execution !== undefined,
            enabled: override?.enabled !== undefined,
          },
        }
      }),
  }
}

interface MountOptions {
  readonly value?: SubagentSettings
  readonly writable?: boolean
  /** The Session's workspace; `null` stands in for a Session that has none. */
  readonly workspace?: string | null
  readonly catalog?: ModelCatalog
  readonly writeGate?: Promise<void>
}

function mount(options: MountOptions = {}) {
  const writable = options.writable ?? true
  let current = options.value ?? settings()
  const workspace = options.workspace === undefined ? WORKSPACE : options.workspace
  const store = createSubagentsSectionStore().create()
  // The engine batches subscriber notification to the next animation frame; a
  // test renders the same section state without waiting a frame for it.
  const listeners = new Set<() => void>()
  const publish = (): void => {
    store.actions.sync({ status: 'ready', writable, revision: REVISION, value: current })
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

  // Models the settings scope: a write folds into the mirrored document before
  // it settles, which is what makes the page re-read the rosters afterwards.
  const write = vi.fn<SubagentsOperations['write']>(async (patch) => {
    await options.writeGate
    current = { ...current, ...patch }
    publish()
  })
  const operations: SubagentsOperations = {
    snapshot: () => ({ status: 'ready', writable, revision: REVISION, value: current }),
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
    modelCatalog: async (): Promise<ModelCatalog> => options.catalog ?? CATALOG,
    backendProbe: undefined,
  }

  const useSessions = <Selected,>(selector: (state: {
    current: string | undefined
    byId: Record<string, { cwd?: string }>
  }) => Selected): Selected => selector({
    current: workspace === null ? undefined : 'session-1',
    byId: workspace === null ? {} : { 'session-1': { cwd: workspace } },
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

/** The card one definition renders as. */
function card(name: string): HTMLElement {
  return screen.getByRole('article', { name })
}

/** Expand one definition's card. */
function expand(name: string): void {
  fireEvent.click(within(card(name)).getByRole('button', { name: en.cardExpand }))
}

/** Save one expanded stored-role editor. */
function save(group: HTMLElement): void {
  fireEvent.click(within(group).getByRole('button', { name: en.cardSaveChanges }))
}

/** The override editor one definition owns, opened, once the roster has resolved. */
async function editor(name: string): Promise<HTMLElement> {
  const summary = await screen.findByText(
    new RegExp(`^${name} — \\d+ of ${String(SUBAGENT_OVERRIDE_FIELDS.length)} fields overridden$`, 'u'),
  )
  const details = summary.closest('details')
  if (details === null) throw new Error(`${name} has no override editor`)
  if (!details.open) fireEvent.click(summary)
  return details
}

/** Reveal every field one override editor can edit. */
function showAll(group: HTMLElement): void {
  fireEvent.click(within(group).getByLabelText(en.overrideShowAll))
}

/** The option labels one control offers, read from its opened popup. */
function optionsOf(control: HTMLElement): string[] {
  fireEvent.click(control)
  const labels = screen.getAllByRole('option').map(option => option.textContent ?? '')
  fireEvent.keyDown(control, { key: 'Escape' })
  return labels
}

/** The label one control currently shows on its trigger. */
function shownValue(control: HTMLElement): string {
  return control.textContent ?? ''
}

/** Pick the option whose visible label is `label`. */
function pick(control: HTMLElement, label: string): void {
  fireEvent.click(control)
  fireEvent.click(screen.getByRole('option', { name: label }))
}

/** Wait until the model picker inside one scope has read the Host catalog. */
async function catalogLoaded(scope: HTMLElement): Promise<HTMLElement> {
  const control = within(scope).getAllByLabelText(en.fieldModel)[0]
  if (control === undefined) throw new Error('the scope has no model control')
  await waitFor(() => { expect(optionsOf(control)).toContain('GPT-5.6 Sol') })
  return control
}

/** The last patch one write received. */
function lastPatch(write: ReturnType<typeof mount>['write']): Partial<SubagentSettings> {
  return write.mock.calls.at(-1)?.[0] ?? {}
}

/** The definitions the last write stored. */
function written(write: ReturnType<typeof mount>['write']): SubagentDefinition[] {
  return lastPatch(write).subagents as SubagentDefinition[]
}

/** The revision the last write carried as its fence. */
function lastRevision(write: ReturnType<typeof mount>['write']): number | undefined {
  return write.mock.calls.at(-1)?.[1]
}

describe('Subagents section', () => {
  it('shows and edits the shared delegation limits', async () => {
    const { write } = mount()
    const summary = await screen.findByText('2 at a time · 60 minute timeout')
    fireEvent.click(summary)
    fireEvent.change(screen.getByLabelText(en.limitsConcurrency), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(en.limitsTimeout), { target: { value: '45' } })
    await waitFor(() => {
      expect(lastPatch(write).limits).toEqual({ maxConcurrentRuns: 3, defaultTimeoutMs: 2_700_000 })
    })
  })

  it('lets the parent choose an adaptive batch or a manual safety cap', async () => {
    const { write } = mount()
    fireEvent.click(await screen.findByText('2 at a time · 60 minute timeout'))

    const mode = screen.getByLabelText(en.limitsConcurrencyMode)
    pick(mode, en.limitsConcurrencyAdaptive)
    await waitFor(() => {
      expect(lastPatch(write).limits).toEqual({
        maxConcurrentRuns: 'adaptive',
        defaultTimeoutMs: 3_600_000,
      })
    })
    expect(screen.queryByLabelText(en.limitsConcurrency)).toBeNull()

    pick(mode, en.limitsConcurrencyManual)
    await waitFor(() => {
      expect(lastPatch(write).limits).toEqual({
        maxConcurrentRuns: 4,
        defaultTimeoutMs: 3_600_000,
      })
    })
    expect(screen.getByLabelText(en.limitsConcurrency)).toHaveProperty('value', '4')
  })

  it('caps concurrent delegations at the Host ceiling', async () => {
    const { write } = mount()
    fireEvent.click(await screen.findByText('2 at a time · 60 minute timeout'))
    const concurrency = screen.getByLabelText(en.limitsConcurrency)
    expect(concurrency.getAttribute('max')).toBe('16')
    fireEvent.change(concurrency, { target: { value: '28' } })
    await waitFor(() => {
      expect(lastPatch(write).limits).toEqual({ maxConcurrentRuns: 16, defaultTimeoutMs: 3_600_000 })
    })
    expect(concurrency).toHaveProperty('value', '16')
  })

  it('reports the resolved values on a collapsed card', async () => {
    mount({
      value: settings({
        subagents: [
          definition('code', { model: { mode: 'fixed', route: SOL_HIGH } }),
          definition('review', { access: 'read-only' }),
        ],
      }),
    })
    // The catalog read lands after the first paint, so the model name resolves
    // from its display name only once that read is in.
    const code = card('Code')
    expect(await within(code).findByText('GPT-5.6 Sol')).toBeTruthy()
    expect(within(code).getByText('High')).toBeTruthy()
    expect(within(code).getByText(en.accessWorkspaceWrite)).toBeTruthy()
    expect(within(code).getByText(en.invocationAutomatic)).toBeTruthy()
    expect(within(code).getByText(en.cardWorkspaceInherited)).toBeTruthy()
    // A definition that pins no route reports the parent's own model as inherited.
    const review = card('review')
    expect(within(review).getByText(en.modelInherit)).toBeTruthy()
    expect(within(review).getByText(en.accessReadOnly)).toBeTruthy()
  })

  it('reports a role the agent chooses a model for', async () => {
    mount({ value: settings({ subagents: [definition('code', { model: { mode: 'automatic' } })] }) })
    const code = card('Code')
    expect(within(code).getByText(en.modelAutomatic)).toBeTruthy()
    expect(within(code).getByText(en.invocationAutomatic)).toBeTruthy()
  })

  it('marks a workspace-customized role on its collapsed card', async () => {
    mount({
      value: settings({ overrides: { [WORKSPACE]: { subagents: { code: { purpose: 'Workspace code' } } } } }),
    })
    expect(await within(card('Code')).findByText(en.cardWorkspaceCustom)).toBeTruthy()
  })

  it('warns when automatic roles use substantially overlapping routing guidance', () => {
    mount({
      value: settings({
        subagents: [
          definition('code', { purpose: 'Implement scoped workspace code changes', whenToUse: 'Implement scoped code changes' }),
          definition('review', { purpose: 'Review scoped workspace code changes', whenToUse: 'Review scoped code changes' }),
        ],
      }),
    })
    expect(screen.getByText(/Code \/ review use similar automatic criteria/u)).toBeTruthy()
  })

  it('expands a card to its labelled fields, with the hints described rather than named', () => {
    mount()
    expand('Code')
    const expanded = card('Code')
    for (const [label, hint] of [
      [en.fieldName, en.fieldNameHint],
      [en.fieldPurpose, en.fieldPurposeHint],
      [en.fieldModel, en.fieldModelHint],
      [en.fieldToolsAllow, en.fieldToolsAllowHint],
      [en.fieldBackend, en.fieldBackendHint],
    ] as const) {
      const control = within(expanded).getByLabelText(label)
      const describedBy = control.getAttribute('aria-describedby')
      expect(describedBy).not.toBeNull()
      expect(document.getElementById(describedBy!)?.textContent).toBe(hint)
    }
  })

  it('shows the definition id as a read-only control', () => {
    mount()
    expand('Code')
    const id = within(card('Code')).getByLabelText(en.fieldId)
    expect(id).toHaveProperty('readOnly', true)
    expect(id).toHaveProperty('value', 'code')
  })

  it('writes the text fields the user edits', async () => {
    const { write } = mount()
    expand('Code')
    // The card's accessible name follows the definition name this edit changes,
    // so the element is resolved once and reused.
    const expanded = card('Code')
    fireEvent.change(within(expanded).getByLabelText(en.fieldName), { target: { value: 'Primary' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldPurpose), { target: { value: 'Ship it' } })
    fireEvent.click(within(expanded).getByText(en.cardRoutingTitle))
    fireEvent.change(within(expanded).getByLabelText(en.fieldWhenToUse), { target: { value: 'For edits' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldInstructions), { target: { value: 'Be terse.' } })
    expect(write).not.toHaveBeenCalled()
    save(expanded)

    await waitFor(() => {
      const stored = written(write)[0]
      expect(stored?.name).toBe('Primary')
      expect(stored?.purpose).toBe('Ship it')
      expect(stored?.whenToUse).toBe('For edits')
      expect(stored?.instructions).toBe('Be terse.')
      expect(written(write)[1]?.name).toBe('review')
    })
  })

  it('carries the revision the edit was computed from as the write fence', async () => {
    const { write } = mount()
    expand('Code')
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldName), { target: { value: 'Primary' } })
    save(screen.getByRole('article', { name: 'Primary' }))
    await waitFor(() => { expect(write).toHaveBeenCalled() })
    expect(lastRevision(write)).toBe(REVISION)
    expect(lastPatch(write).overrides).toBeUndefined()
  })

  it('writes the enabled switch', async () => {
    const { write } = mount()
    expand('Code')
    const toggle = within(card('Code')).getByRole('switch', { name: en.fieldEnabled })
    expect(toggle).toHaveProperty('checked', true)
    fireEvent.click(toggle)
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.enabled).toBe(false) })
    expect(within(card('Code')).getByRole('switch', { name: en.cardDisabled })).toHaveProperty('checked', false)
    expect(within(card('Code')).queryByText(en.fieldEnabled)).toBeNull()
  })

  it('saves a rapid disable then enable edit as one complete role write', async () => {
    let releaseWrite: (() => void) | undefined
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const { write } = mount({ writeGate })
    expand('Code')

    fireEvent.click(within(card('Code')).getByRole('switch', { name: en.fieldEnabled }))
    fireEvent.click(within(card('Code')).getByRole('switch', { name: en.cardDisabled }))
    save(card('Code'))

    expect(written(write)[0]?.enabled).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[1]).toBe(REVISION)
    releaseWrite?.()
    await waitFor(() => {
      expect(within(card('Code')).getByRole('switch', { name: en.fieldEnabled })).toHaveProperty('checked', true)
    })
  })

  it('keeps a collapsed disable then re-enable while the first write is pending', async () => {
    let releaseWrite: (() => void) | undefined
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const { write } = mount({ writeGate })

    fireEvent.click(within(card('Code')).getByRole('switch', { name: en.fieldEnabled }))
    fireEvent.click(within(card('Code')).getByRole('switch', { name: en.cardDisabled }))

    expect(written(write)[0]?.enabled).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0]?.[1]).toBe(REVISION)
    expect(write.mock.calls[1]?.[1]).toBeUndefined()
    releaseWrite?.()
    await waitFor(() => {
      expect(within(card('Code')).getByRole('switch', { name: en.fieldEnabled })).toHaveProperty('checked', true)
    })
  })

  it('writes the access level and states the full-access consequence', async () => {
    const { write } = mount()
    expand('Code')
    expect(within(card('Code')).queryByText(en.accessFullAccessWarning)).toBeNull()
    pick(within(card('Code')).getByLabelText(en.fieldAccess), en.accessFullAccess)
    await waitFor(() => {
      expect(within(card('Code')).getByText(en.accessFullAccessWarning)).toBeTruthy()
    })
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.access).toBe('danger-full-access') })
  })

  it('writes the invocation policy from its own labelled option', async () => {
    const { write } = mount()
    expand('Code')
    pick(within(card('Code')).getByLabelText(en.fieldInvocation), en.invocationAskFirst)
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.invocation).toBe('ask-first') })
  })

  it('offers every invocation policy in one concise control', () => {
    mount()
    expand('Code')
    const control = within(card('Code')).getByLabelText(en.fieldInvocation)
    expect(optionsOf(control)).toEqual([
      en.invocationAutomatic,
      en.invocationAskFirst,
      en.invocationManual,
    ])
    const describedBy = control.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toBe(en.fieldInvocationHint)
  })

  it('checks a complete role without writing settings or starting a model call', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { whenToUse: 'Use for bounded code changes.' })] }),
    })
    expand('Code')

    fireEvent.click(within(card('Code')).getByRole('button', { name: en.setupCheck }))

    await waitFor(() => { expect(within(card('Code')).getByText(en.setupReady)).toBeTruthy() })
    expect(within(card('Code')).getByText(en.setupReadyDescription)).toBeTruthy()
    expect(within(card('Code')).getByText(en.setupNoModelCall)).toBeTruthy()
    expect(write).not.toHaveBeenCalled()
  })

  it('points out missing routing guidance in the setup check', async () => {
    mount()
    expand('Code')

    fireEvent.click(within(card('Code')).getByRole('button', { name: en.setupCheck }))

    await waitFor(() => { expect(within(card('Code')).getByText(en.setupAttention)).toBeTruthy() })
    expect(within(card('Code')).getByText(en.setupGuidanceAttention)).toBeTruthy()
  })

  it('writes the tool restriction, and clears it when both lists are emptied', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code'), definition('review')] }),
    })
    expand('Code')
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsAllow), { target: { value: 'read, edit' } })
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsDeny), { target: { value: 'bash' } })
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsAllow), { target: { value: '' } })
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsDeny), { target: { value: '' } })
    save(card('Code'))
    await waitFor(() => {
      expect(Object.hasOwn(written(write)[0] ?? {}, 'tools')).toBe(false)
    })
  })

  it('writes the advanced execution fields', async () => {
    const { write } = mount()
    expand('Code')
    const expanded = card('Code')
    fireEvent.change(within(expanded).getByLabelText(en.fieldBackend), { target: { value: 'fork' } })
    pick(within(expanded).getByLabelText(en.fieldBackground), en.backgroundBackground)
    fireEvent.change(within(expanded).getByLabelText(en.fieldTimeout), { target: { value: '90' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldMaxDepth), { target: { value: '3' } })
    save(expanded)

    await waitFor(() => {
      const stored = written(write)[0]
      expect(stored?.execution).toEqual({ backend: 'fork', background: 'background', timeoutMs: 90_000 })
      expect(stored?.maxDepth).toBe(3)
    })
  })
})

describe('Subagents model and effort picker', () => {
  it('offers only the levels the selected model advertises', async () => {
    mount({ value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_HIGH } })] }) })
    expand('Code')
    await waitFor(() => {
      const effort = within(card('Code')).getByLabelText(en.fieldEffort)
      expect(optionsOf(effort)).toEqual([en.effortDefault, 'Medium', 'High'])
    })
  })

  it('re-narrows the effort list when the model changes', async () => {
    mount({ value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_HIGH } })] }) })
    expand('Code')
    await waitFor(() => {
      expect(optionsOf(within(card('Code')).getByLabelText(en.fieldEffort))).toContain('Medium')
    })

    pick(within(card('Code')).getByLabelText(en.fieldModel), 'DeepSeek Chat')
    await waitFor(() => {
      const effort = within(card('Code')).getByLabelText(en.fieldEffort)
      expect(optionsOf(effort)).toEqual([en.effortDefault, 'Low', 'High'])
    })
  })

  it('carries an effort the newly selected model still advertises', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_HIGH } })] }),
    })
    expand('Code')
    const model = await catalogLoaded(card('Code'))
    pick(model, 'DeepSeek Chat')
    save(card('Code'))
    await waitFor(() => {
      expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: { ...CHAT, reasoningEffort: 'high' } })
    })
  })

  it('clears an effort the newly selected model does not advertise', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_MEDIUM } })] }),
    })
    expand('Code')
    const model = await catalogLoaded(card('Code'))
    pick(model, 'DeepSeek Chat')
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: CHAT }) })
  })

  it('hides the effort control, with an explanation, for a model that advertises none', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_HIGH } })] }),
    })
    expand('Code')
    const model = await catalogLoaded(card('Code'))
    pick(model, 'DeepSeek Plain')
    await waitFor(() => {
      const expanded = card('Code')
      expect(within(expanded).queryByLabelText(en.fieldEffort)).toBeNull()
      expect(within(expanded).getByText(en.effortNotAdvertised)).toBeTruthy()
    })
    save(card('Code'))
    // The route is stored without an effort rather than with a fabricated one.
    expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: { provider: 'deepseek', model: 'deepseek-plain' } })
  })

  it('explains that no effort can be chosen without a pinned model', () => {
    mount()
    expand('Code')
    expect(within(card('Code')).queryByLabelText(en.fieldEffort)).toBeNull()
    expect(within(card('Code')).getByText(en.effortNoRoute)).toBeTruthy()
  })

  it('writes the automatic mode instead of a route', async () => {
    const { write } = mount()
    expand('Code')
    pick(within(card('Code')).getByLabelText(en.fieldModel), en.modelAutomaticOption)
    await waitFor(() => { expect(within(card('Code')).getByText(en.modelAutomaticNote)).toBeTruthy() })
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'automatic' }) })
  })

  it('keeps a configured model the catalog no longer advertises, and lets it go', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: GHOST } })] }),
    })
    expand('Code')
    const model = within(card('Code')).getByLabelText(en.fieldModel)
    expect(shownValue(model)).toBe(`gone ${en.modelUnavailableSuffix}`)
    expect(optionsOf(model)).toContain(`gone ${en.modelUnavailableSuffix}`)

    pick(model, en.modelInheritOption)
    save(card('Code'))
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'fixed' }) })
  })
})

describe('Subagents card actions', () => {
  it('keeps a new subagent local until its required purpose is saved', async () => {
    const { write } = mount()
    fireEvent.change(screen.getByLabelText(en.cardAddTitle), { target: { value: 'Security Audit' } })
    fireEvent.click(screen.getByRole('button', { name: en.cardCreate }))
    const draft = card('Security Audit')
    expect(write).not.toHaveBeenCalled()
    expect(within(draft).getByLabelText(en.fieldId)).toHaveProperty('readOnly', false)
    fireEvent.click(within(draft).getByRole('button', { name: en.cardSaveRole }))
    expect(within(draft).getByText(en.validationMissingPurpose)).toBeTruthy()
    fireEvent.change(within(draft).getByLabelText(en.fieldPurpose), { target: { value: 'Audit security risks.' } })
    fireEvent.click(within(draft).getByRole('button', { name: en.cardSaveRole }))
    await waitFor(() => {
      const added = written(write).at(-1)
      expect(added?.id).toBe('security-audit')
      expect(added?.name).toBe('Security Audit')
      expect(added?.enabled).toBe(false)
      expect(added?.purpose).toBe('Audit security risks.')
      expect(added?.access).toBe('inherit')
      expect(added?.execution.backend).toBe('spawn')
    })
  })

  it('opens a disabled duplicate as an editable draft and writes it only on save', async () => {
    const { write } = mount()
    expand('Code')
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDuplicate }))
    const copy = card('Code copy')
    expect(write).not.toHaveBeenCalled()
    fireEvent.change(within(copy).getByLabelText(en.fieldName), { target: { value: 'Secure Code' } })
    fireEvent.change(within(copy).getByLabelText(en.fieldId), { target: { value: 'secure-code' } })
    fireEvent.click(within(copy).getByRole('button', { name: en.cardSaveRole }))
    await waitFor(() => {
      const savedCopy = written(write).at(-1)
      expect(savedCopy?.id).toBe('secure-code')
      expect(savedCopy?.name).toBe('Secure Code')
      expect(savedCopy?.enabled).toBe(false)
      expect(written(write)).toHaveLength(3)
    })
  })

  it('cancels a duplicate without changing stored roles', () => {
    const { write } = mount()
    expand('Code')
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDuplicate }))
    fireEvent.click(within(card('Code copy')).getByRole('button', { name: en.cardCancel }))
    expect(write).not.toHaveBeenCalled()
    expect(screen.queryByRole('article', { name: 'Code copy' })).toBeNull()
  })

  it('deletes a definition and its workspace overrides once the user confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { write } = mount({
      value: settings({
        subagents: [definition('code'), definition('review')],
        overrides: { [WORKSPACE]: { subagents: { code: { name: 'Patched' } } } },
      }),
    })
    expand('Code')
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDelete }))
    await waitFor(() => {
      expect(written(write).map(entry => entry.id)).toEqual(['review'])
      expect(lastPatch(write).overrides).toEqual({})
    })
  })

  it('leaves the document alone when the user cancels the delete', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { write } = mount()
    expand('Code')
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDelete }))
    expect(write).not.toHaveBeenCalled()
  })
})

describe('Subagents workspace overrides', () => {
  it('invites a workspace before offering overrides', async () => {
    mount({ workspace: null })
    await waitFor(() => { expect(screen.getByText(en.overrideNoWorkspace)).toBeTruthy() })
  })

  it('names the workspace being overridden', async () => {
    mount()
    await waitFor(() => { expect(screen.getByText(WORKSPACE)).toBeTruthy() })
  })

  it('shows every field as inherited, on request, until one is edited', async () => {
    mount()
    const group = await editor('Code')
    expect(within(group).getByText(en.overrideNone)).toBeTruthy()
    expect(within(group).queryAllByText(en.overrideInherited)).toHaveLength(0)

    showAll(group)
    expect(within(group).getAllByText(en.overrideInherited)).toHaveLength(SUBAGENT_OVERRIDE_FIELDS.length)
    expect(within(group).queryAllByText(en.overrideOverridden)).toHaveLength(0)
  })

  it('records one field override and leaves its neighbours inherited', async () => {
    const { write } = mount()
    const group = await editor('Code')
    showAll(group)
    fireEvent.change(within(group).getByLabelText(en.fieldPurpose), { target: { value: 'Local purpose' } })

    await waitFor(() => {
      expect(lastPatch(write).overrides).toEqual({ [WORKSPACE]: { subagents: { code: { purpose: 'Local purpose' } } } })
    })
    await waitFor(() => {
      const updated = screen.getByText(/^Code — 1 of /u).closest('details')
      if (updated === null) throw new Error('the Code editor is missing')
      showAll(updated)
      expect(within(updated).getAllByText(en.overrideOverridden)).toHaveLength(1)
      expect(within(updated).getAllByText(en.overrideInherited)).toHaveLength(SUBAGENT_OVERRIDE_FIELDS.length - 1)
    })
  })

  it('lists only the fields this workspace replaces until the rest is asked for', async () => {
    mount({
      value: settings({
        overrides: { [WORKSPACE]: { subagents: { code: { name: 'Patched' } } } },
      }),
    })
    const group = await editor('Code')
    expect(within(group).getAllByText(en.overrideOverridden)).toHaveLength(1)
    expect(within(group).getByLabelText(en.fieldName)).toBeTruthy()
    expect(within(group).queryByLabelText(en.fieldPurpose)).toBeNull()

    showAll(group)
    expect(within(group).getByLabelText(en.fieldPurpose)).toBeTruthy()
  })

  it('keeps a workspace edit to its own top-level field', async () => {
    const { write } = mount()
    const group = await editor('Code')
    showAll(group)
    pick(within(group).getByLabelText(en.fieldAccess), en.accessReadOnly)
    await waitFor(() => {
      const patch = lastPatch(write)
      expect(patch.overrides).toBeDefined()
      expect(patch.subagents).toBeUndefined()
    })
  })

  it('resets one field back to inherited without touching the others', async () => {
    const { write } = mount({
      value: settings({
        overrides: { [WORKSPACE]: { subagents: { code: { name: 'Patched', purpose: 'Local' } } } },
      }),
    })
    const group = await editor('Code')
    expect(within(group).getAllByText(en.overrideOverridden)).toHaveLength(2)

    const nameRow = within(group).getByLabelText(en.fieldName).closest('li')
    if (nameRow === null) throw new Error('the name row is missing')
    fireEvent.click(within(nameRow).getByRole('button', { name: en.overrideReset }))

    await waitFor(() => {
      expect(lastPatch(write).overrides).toEqual({ [WORKSPACE]: { subagents: { code: { purpose: 'Local' } } } })
    })
  })

  it('prunes the override entry once its last field is reset', async () => {
    const { write } = mount({
      value: settings({ overrides: { [WORKSPACE]: { subagents: { code: { purpose: 'Local' } } } } }),
    })
    const group = await editor('Code')
    const row = within(group).getByLabelText(en.fieldPurpose).closest('li')
    if (row === null) throw new Error('the purpose row is missing')
    fireEvent.click(within(row).getByRole('button', { name: en.overrideReset }))

    await waitFor(() => { expect(lastPatch(write).overrides).toEqual({}) })
  })

  it('resets every override one definition carries', async () => {
    const { write } = mount({
      value: settings({
        overrides: { [WORKSPACE]: { subagents: { code: { name: 'Patched', purpose: 'Local' } } } },
      }),
    })
    const group = await editor('Code')
    fireEvent.click(within(group).getByRole('button', { name: en.overrideResetAll }))
    // The workspace entry disappears with its last override, so the write is an
    // empty map rather than a layer that records nothing.
    await waitFor(() => { expect(lastPatch(write).overrides).toEqual({}) })
  })

  it('resets every override the workspace carries', async () => {
    const { write } = mount({
      value: settings({
        overrides: {
          [WORKSPACE]: { subagents: { code: { name: 'Patched' }, review: { purpose: 'Local' } } },
        },
      }),
    })
    const reset = await screen.findByRole('button', { name: en.overrideResetWorkspace })
    fireEvent.click(reset)
    await waitFor(() => { expect(lastPatch(write).overrides).toEqual({}) })
  })
})

describe('Subagents automatic routing', () => {
  /** The routing block's region. */
  function block(): HTMLElement {
    return screen.getByRole('region', { name: en.routingTitle })
  }

  /** Open the routing block. */
  function open(): void {
    fireEvent.click(within(block()).getByRole('button', { name: en.cardExpand }))
  }

  it('reports that explicit route selection is off', () => {
    mount()
    expect(within(block()).getByText(en.routingAuthorityOff)).toBeTruthy()
  })

  it('refuses to enable routing before any route is authorized', () => {
    mount()
    open()
    expect(within(block()).getByRole('switch', { name: en.routingToggle })).toHaveProperty('disabled', true)
    expect(within(block()).getByText(en.routingRequired)).toBeTruthy()
  })

  it('authorizes one exact route drawn from the catalog', async () => {
    const { write } = mount()
    open()
    const choice = await within(block()).findByRole('checkbox', { name: /DeepSeek Chat/u })
    fireEvent.click(choice)
    await waitFor(() => {
      expect(lastPatch(write).automaticRouting).toEqual({
        enabled: false,
        allowedModels: [{ provider: 'deepseek', model: 'deepseek-chat' }],
      })
    })
  })

  it('enables routing once a route is authorized', async () => {
    const { write } = mount({
      value: settings({ automaticRouting: { enabled: false, allowedModels: [CHAT] } }),
    })
    open()
    fireEvent.click(within(block()).getByRole('switch', { name: en.routingToggle }))
    await waitFor(() => {
      expect(lastPatch(write).automaticRouting).toEqual({ enabled: true, allowedModels: [CHAT] })
    })
  })

  it('reports the authority the Host holds while routing is on', async () => {
    mount({
      value: settings({ automaticRouting: { enabled: true, allowedModels: [CHAT, SOL_HIGH] } }),
    })
    await waitFor(() => {
      expect(within(block()).getByText(en.routingAuthority.replace('{count}', '2'))).toBeTruthy()
    })
  })

  it('keeps a saved route the catalog no longer advertises, and lets it go', async () => {
    const { write } = mount({
      value: settings({ automaticRouting: { enabled: true, allowedModels: [CHAT, GHOST] } }),
    })
    open()
    const stale = await within(block()).findByRole('checkbox', { name: /gone/u })
    expect(stale).toHaveProperty('checked', true)

    fireEvent.click(stale)
    await waitFor(() => {
      expect(lastPatch(write).automaticRouting).toEqual({ enabled: true, allowedModels: [CHAT] })
    })
  })

  it('does not let the last authorized route be removed while routing is on', async () => {
    mount({ value: settings({ automaticRouting: { enabled: true, allowedModels: [CHAT] } }) })
    open()
    const choice = await within(block()).findByRole('checkbox', { name: /DeepSeek Chat/u })
    expect(choice).toHaveProperty('disabled', true)
  })
})

describe('Subagents section storage states', () => {
  it('disables every editor when the settings document is read-only', async () => {
    mount({ writable: false })
    expect(screen.getByLabelText(en.cardAddTitle)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.cardCreate })).toHaveProperty('disabled', true)
    expand('Code')
    expect(within(card('Code')).getByLabelText(en.fieldName)).toHaveProperty('disabled', true)
    await waitFor(() => { expect(screen.getByText(en.readOnly)).toBeTruthy() })
  })
})
