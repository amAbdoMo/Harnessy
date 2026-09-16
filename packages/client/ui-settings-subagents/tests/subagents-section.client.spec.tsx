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

/** The override editor one definition owns, once the Host roster has resolved. */
async function editor(name: string): Promise<HTMLElement> {
  const legend = await screen.findByText(
    new RegExp(`^${name} — \\d+ of ${String(SUBAGENT_OVERRIDE_FIELDS.length)} fields overridden$`, 'u'),
  )
  const fieldset = legend.closest('fieldset')
  if (fieldset === null) throw new Error(`${name} has no override editor`)
  return fieldset
}

/** The option texts one select renders, in order. */
function optionsOf(select: HTMLElement): (string | null)[] {
  return [...select.querySelectorAll('option')].map(option => option.textContent)
}

/** Wait until the model picker inside one scope has read the Host catalog. */
async function catalogLoaded(scope: HTMLElement): Promise<HTMLSelectElement> {
  const select = within(scope).getAllByLabelText(en.fieldModel)[0] as HTMLSelectElement | undefined
  if (select === undefined) throw new Error('the scope has no model control')
  await waitFor(() => { expect(optionsOf(select)).toContain('GPT-5.6 Sol') })
  return select
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
  it('reports the run bounds the Host stores', async () => {
    mount()
    await waitFor(() => {
      expect(screen.getByText(/Run limits: 2 delegations at a time/u)).toBeTruthy()
    })
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
    expect(await screen.findByText('Code · GPT-5.6 Sol · High · Workspace write · Automatic')).toBeTruthy()
    // A definition that pins no route reports the parent's own model as inherited.
    expect(screen.getByText('review · inherit · Read only · Automatic')).toBeTruthy()
  })

  it('reports a role the agent chooses a model for', async () => {
    mount({ value: settings({ subagents: [definition('code', { model: { mode: 'automatic' } })] }) })
    expect(screen.getByText('Code · agent chooses · Workspace write · Automatic')).toBeTruthy()
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
    fireEvent.change(within(expanded).getByLabelText(en.fieldWhenToUse), { target: { value: 'For edits' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldInstructions), { target: { value: 'Be terse.' } })

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
    await waitFor(() => { expect(written(write)[0]?.enabled).toBe(false) })
  })

  it('writes the access level and states the full-access consequence', async () => {
    const { write } = mount()
    expand('Code')
    expect(within(card('Code')).queryByText(en.accessFullAccessWarning)).toBeNull()
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldAccess), { target: { value: 'danger-full-access' } })
    await waitFor(() => { expect(written(write)[0]?.access).toBe('danger-full-access') })
    await waitFor(() => {
      expect(within(card('Code')).getByText(en.accessFullAccessWarning)).toBeTruthy()
    })
  })

  it('writes the invocation policy from its own labelled option', async () => {
    const { write } = mount()
    expand('Code')
    fireEvent.click(within(card('Code')).getByLabelText(en.invocationAskFirst))
    await waitFor(() => { expect(written(write)[0]?.invocation).toBe('ask-first') })
  })

  it('offers every invocation policy with its own explanation', () => {
    mount()
    expand('Code')
    const group = within(card('Code')).getByRole('group', { name: en.fieldInvocation })
    for (const [label, hint] of [
      [en.invocationAutomatic, en.invocationAutomaticHint],
      [en.invocationAskFirst, en.invocationAskFirstHint],
      [en.invocationManual, en.invocationManualHint],
    ] as const) {
      expect(within(group).getByLabelText(label)).toBeTruthy()
      expect(within(group).getByText(hint)).toBeTruthy()
    }
  })

  it('writes the tool restriction, and clears it when both lists are emptied', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code'), definition('review')] }),
    })
    expand('Code')
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsAllow), { target: { value: 'read, edit' } })
    await waitFor(() => { expect(written(write)[0]?.tools).toEqual({ allow: ['read', 'edit'] }) })

    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsDeny), { target: { value: 'bash' } })
    await waitFor(() => {
      expect(written(write)[0]?.tools).toEqual({ allow: ['read', 'edit'], deny: ['bash'] })
    })

    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsAllow), { target: { value: '' } })
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldToolsDeny), { target: { value: '' } })
    await waitFor(() => {
      expect(Object.hasOwn(written(write)[0] ?? {}, 'tools')).toBe(false)
    })
  })

  it('writes the advanced execution fields', async () => {
    const { write } = mount()
    expand('Code')
    const expanded = card('Code')
    fireEvent.change(within(expanded).getByLabelText(en.fieldBackend), { target: { value: 'fork' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldBackground), { target: { value: 'background' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldTimeout), { target: { value: '90' } })
    fireEvent.change(within(expanded).getByLabelText(en.fieldMaxDepth), { target: { value: '3' } })

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

    fireEvent.change(within(card('Code')).getByLabelText(en.fieldModel), {
      target: { value: 'deepseek\u0000deepseek-chat' },
    })
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
    fireEvent.change(model, { target: { value: 'deepseek\u0000deepseek-chat' } })
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
    fireEvent.change(model, { target: { value: 'deepseek\u0000deepseek-chat' } })
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'fixed', route: CHAT }) })
  })

  it('hides the effort control, with an explanation, for a model that advertises none', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: SOL_HIGH } })] }),
    })
    expand('Code')
    const model = await catalogLoaded(card('Code'))
    fireEvent.change(model, { target: { value: 'deepseek\u0000deepseek-plain' } })
    await waitFor(() => {
      const expanded = card('Code')
      expect(within(expanded).queryByLabelText(en.fieldEffort)).toBeNull()
      expect(within(expanded).getByText(en.effortNotAdvertised)).toBeTruthy()
    })
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
    fireEvent.change(within(card('Code')).getByLabelText(en.fieldModel), {
      target: { value: 'automatic' },
    })
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'automatic' }) })
    await waitFor(() => { expect(within(card('Code')).getByText(en.modelAutomaticNote)).toBeTruthy() })
  })

  it('keeps a configured model the catalog no longer advertises, and lets it go', async () => {
    const { write } = mount({
      value: settings({ subagents: [definition('code', { model: { mode: 'fixed', route: GHOST } })] }),
    })
    expand('Code')
    const model = within(card('Code')).getByLabelText(en.fieldModel)
    expect((model as HTMLSelectElement).value).toBe('ghost\u0000gone')
    expect(optionsOf(model)).toContain(`gone ${en.modelUnavailableSuffix}`)

    fireEvent.change(model, { target: { value: '' } })
    await waitFor(() => { expect(written(write)[0]?.model).toEqual({ mode: 'fixed' }) })
  })
})

describe('Subagents card actions', () => {
  it('adds a subagent under an id derived from its name', async () => {
    const { write } = mount()
    fireEvent.change(screen.getByLabelText(en.cardAddTitle), { target: { value: 'Security Audit' } })
    fireEvent.click(screen.getByRole('button', { name: en.cardCreate }))

    await waitFor(() => {
      const added = written(write).at(-1)
      expect(added?.id).toBe('security-audit')
      expect(added?.name).toBe('Security Audit')
      expect(added?.enabled).toBe(true)
      expect(added?.access).toBe('inherit')
      expect(added?.execution.backend).toBe('spawn')
    })
  })

  it('duplicates a definition as a disabled copy under a fresh id', async () => {
    const { write } = mount()
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDuplicate }))
    await waitFor(() => {
      const copy = written(write).at(-1)
      expect(copy?.id).toBe('code-copy')
      expect(copy?.enabled).toBe(false)
      expect(written(write)).toHaveLength(3)
    })
  })

  it('deletes a definition and its workspace overrides once the user confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { write } = mount({
      value: settings({
        subagents: [definition('code'), definition('review')],
        overrides: { [WORKSPACE]: { subagents: { code: { name: 'Patched' } } } },
      }),
    })
    fireEvent.click(within(card('Code')).getByRole('button', { name: en.cardDelete }))
    await waitFor(() => {
      expect(written(write).map(entry => entry.id)).toEqual(['review'])
      expect(lastPatch(write).overrides).toEqual({})
    })
  })

  it('leaves the document alone when the user cancels the delete', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { write } = mount()
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

  it('shows every field as inherited until one is edited', async () => {
    mount()
    const group = await editor('Code')
    expect(within(group).getAllByText(en.overrideInherited)).toHaveLength(SUBAGENT_OVERRIDE_FIELDS.length)
    expect(within(group).queryAllByText(en.overrideOverridden)).toHaveLength(0)
  })

  it('records one field override and leaves its neighbours inherited', async () => {
    const { write } = mount()
    const group = await editor('Code')
    fireEvent.change(within(group).getByLabelText(en.fieldPurpose), { target: { value: 'Local purpose' } })

    await waitFor(() => {
      expect(lastPatch(write).overrides).toEqual({ [WORKSPACE]: { subagents: { code: { purpose: 'Local purpose' } } } })
    })
    await waitFor(() => {
      const updated = screen.getByRole('group', { name: /^Code — 1 of /u })
      expect(within(updated).getAllByText(en.overrideOverridden)).toHaveLength(1)
      expect(within(updated).getAllByText(en.overrideInherited)).toHaveLength(SUBAGENT_OVERRIDE_FIELDS.length - 1)
    })
  })

  it('keeps a workspace edit to its own top-level field', async () => {
    const { write } = mount()
    const group = await editor('Code')
    fireEvent.change(within(group).getByLabelText(en.fieldAccess), { target: { value: 'read-only' } })
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
