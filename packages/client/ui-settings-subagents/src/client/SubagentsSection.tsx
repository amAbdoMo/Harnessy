/** Harnessy Subagents settings page: the stored role directory, workspace overrides, and automatic routing. */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandCodeCatalog,
  CommandCodeHealth,
  ModelCatalog,
  ModelProviderGroup,
  SubagentAutomaticRouting,
  SubagentDefinition,
  SubagentModelRoute,
  SubagentSettings,
  SubagentStoredRoster,
  SubagentWorkspaceRoster,
} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: declares the root-scope standard props (`useSessions`) this
// section reads, and the module-table row the built bundle resolves.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { subagentBackendRows } from './backends.ts'
import {
  commandCodeModelGroups,
  subagentCatalogOwner,
  subagentModelChoices,
  subagentModelDirectory,
} from './catalog.ts'
import type {
  SubagentCatalogState,
  SubagentModelChoice,
  SubagentModelDirectory,
  SubagentModelSource,
} from './catalog.ts'
import { SUBAGENT_DEFAULT_BACKEND } from './contract.ts'
import { DefinitionCard } from './DefinitionCard.tsx'
import { RoutingBlock } from './RoutingBlock.tsx'
import { WorkspaceOverrideEditor } from './WorkspaceOverrideEditor.tsx'
import { DraftInput, Field } from './fields.tsx'
import {
  changedFields,
  deriveSubagentId,
  effectiveDefinition,
  overriddenFields,
  resetWorkspace,
  resetWorkspaceDefinition,
  resetWorkspaceField,
  withAutomaticRouting,
  withDefinition,
  withNewDefinition,
  withWorkspaceField,
  withoutDefinition,
  duplicateDefinition,
} from './edit.ts'
import type { createSubagentsSectionStore, SubagentsSectionState } from './section-store.ts'
import css from './SubagentsSection.module.css'

/**
 * One backend that reports for itself, and the two reads it answers.
 *
 * The readiness and catalog facts are the ones a backend that owns its own
 * model space can state about itself; `commandcode` is the backend that does
 * today. A backend with no probe either resolves its routes through Harnessy or
 * has no readiness surface at all, and the block says so rather than guessing.
 */
export interface SubagentBackendProbe {
  /** Backend name, as a role's `execution.backend` stores it. */
  readonly backend: string
  /**
   * Read the backend's own installation and sign-in state.
   * @param signal - this read's lifetime; the page aborts a superseded one.
   */
  readonly health: (signal: AbortSignal) => Promise<CommandCodeHealth>
  /**
   * Read the model catalog the backend's own model space offers.
   * @param signal - this read's lifetime; the page aborts a superseded one.
   */
  readonly catalog: (signal: AbortSignal) => Promise<CommandCodeCatalog>
}

/** What the Subagents page reads and writes through the registrant's ctx. */
export interface SubagentsOperations {
  /** Read the mirrored settings snapshot. */
  snapshot: () => SubagentsSectionState
  /** Observe settings snapshot replacements. */
  subscribe: (listener: () => void) => () => void
  /** Atomically persist one partial section. */
  write: (patch: Partial<SubagentSettings>, expectedRevision: number | undefined) => Promise<void>
  /**
   * Read the stored document: every definition plus the run bounds.
   * @param signal - this read's lifetime; the page aborts a superseded one.
   */
  storedRoster: (signal: AbortSignal) => Promise<SubagentStoredRoster>
  /**
   * Resolve one workspace's enabled roles with per-field override provenance.
   * @param workspace - the Session's workspace, or null without one.
   * @param signal - this read's lifetime; the page aborts a superseded one.
   */
  resolvedRoster: (workspace: string | null, signal: AbortSignal) => Promise<SubagentWorkspaceRoster>
  /**
   * Read the automatic-routing authority the Host holds.
   * @param signal - this read's lifetime; the page aborts a superseded one.
   */
  automaticRouting: (signal: AbortSignal) => Promise<SubagentAutomaticRouting>
  /**
   * Read the Host's global model catalog.
   * @returns the catalog the model picker and the routing block draw from.
   */
  modelCatalog: () => Promise<ModelCatalog>
  /**
   * The backend this deployment answers for, absent when it composes none.
   *
   * Optional rather than required: a Harnessy build without the Command Code
   * package must still mount this page, so a backend probe is a surface the
   * page reads when it is composed instead of an injected service.
   */
  readonly backendProbe?: SubagentBackendProbe
}

/** Registration-side data supplied to the Subagents page. */
export interface SubagentsSectionInjected {
  readonly operations: SubagentsOperations
}

/** Complete slot-composed Subagents page props. */
export type SubagentsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.subagents'>
  & PropsStore<ReturnType<typeof createSubagentsSectionStore>>
  & InjectFace<SubagentsSectionInjected>

/** Read state a probed backend's readiness is in, as the Backends block renders it. */
type BackendHealthState =
  | { readonly status: 'checking' }
  | { readonly status: 'ready'; readonly health: CommandCodeHealth }
  | { readonly status: 'error' }

/** Everything one backend probe has reported so far. */
interface BackendProbeState {
  /** The probed backend's readiness. */
  readonly health: BackendHealthState
  /** How far the probed backend's own catalog read has got. */
  readonly catalog: SubagentCatalogState
  /** The catalog that read produced, once one answered. */
  readonly models: CommandCodeCatalog | undefined
}

/** The catalog source and route rows one model picker renders from. */
interface SubagentPickerSource {
  /** Which catalog those rows came from, and how far that read has got. */
  readonly source: SubagentModelSource
  /** Every route the picker offers: the source's own rows plus the stored leftovers. */
  readonly choices: SubagentModelChoice[]
  /** The same rows split into advertised groups and removable leftovers. */
  readonly directory: SubagentModelDirectory
}

/** The state one probe read starts from, before anything has answered. */
const UNREAD_PROBE: BackendProbeState = {
  health: { status: 'checking' },
  catalog: 'loading',
  models: undefined,
}

/** Minutes rendered for a millisecond bound, rounded to one decimal. */
function minutesOf(timeoutMs: number): string {
  return String(Math.round((timeoutMs / 60_000) * 10) / 10)
}

/**
 * Render the Subagents settings page.
 * @param props - locale copy, the settings mirror, the session workspace, and the Remote reads.
 * @returns the page element.
 */
export function SubagentsSection({ t, useStore, useSessions, operations }: SubagentsSectionProps) {
  const state = useStore(value => value)
  const workspace = useSessions((sessions) => {
    const current = sessions.current
    return current === undefined ? undefined : sessions.byId[current]?.cwd
  })
  const [stored, setStored] = useState<SubagentStoredRoster | undefined>(undefined)
  const [resolved, setResolved] = useState<SubagentWorkspaceRoster | undefined>(undefined)
  const [authority, setAuthority] = useState<SubagentAutomaticRouting | undefined>(undefined)
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>(undefined)
  const [catalogStatus, setCatalogStatus] = useState<SubagentCatalogState>('loading')
  const [probeState, setProbeState] = useState<BackendProbeState>(UNREAD_PROBE)
  const [error, setError] = useState<string | undefined>(undefined)
  const [draftName, setDraftName] = useState('')
  const newNameId = `${useId()}-new-subagent`

  /**
   * The section the user is editing, kept while writes it started are in
   * flight. A settings write only reaches the mirrored snapshot a round-trip
   * later, and two edits made inside one round-trip would otherwise both read
   * the same stale document and overwrite each other's fields.
   */
  const [optimistic, setOptimistic] = useState<SubagentSettings | undefined>(undefined)
  const pendingWrites = useRef(0)

  /** One abort controller per Remote read, so a superseded read never lands. */
  const storedRequest = useRef<AbortController | undefined>(undefined)
  const resolvedRequest = useRef<AbortController | undefined>(undefined)
  const authorityRequest = useRef<AbortController | undefined>(undefined)
  const catalogRequest = useRef<AbortController | undefined>(undefined)
  const probeRequest = useRef<AbortController | undefined>(undefined)
  const resolvedGeneration = useRef(0)

  const committed = state.value
  const document = optimistic ?? committed
  const disabled = state.status !== 'ready' || !state.writable
  const probe = operations.backendProbe

  // A superseded or unmounted page must not keep a Host request alive.
  useEffect(() => () => {
    storedRequest.current?.abort()
    resolvedRequest.current?.abort()
    authorityRequest.current?.abort()
    catalogRequest.current?.abort()
    probeRequest.current?.abort()
  }, [])

  const loadStored = useCallback(async (): Promise<void> => {
    storedRequest.current?.abort()
    const controller = new AbortController()
    storedRequest.current = controller
    try {
      const next = await operations.storedRoster(controller.signal)
      if (!controller.signal.aborted) setStored(next)
    } catch {
      if (!controller.signal.aborted) setStored(undefined)
    }
  }, [operations])

  const loadResolved = useCallback(async (target: string | null): Promise<void> => {
    resolvedRequest.current?.abort()
    const controller = new AbortController()
    resolvedRequest.current = controller
    // Generation fencing as well as aborting: a response that was already in
    // flight when this read started must not overwrite the newer roster.
    const generation = ++resolvedGeneration.current
    try {
      const next = await operations.resolvedRoster(target, controller.signal)
      if (generation === resolvedGeneration.current) setResolved(next)
    } catch {
      if (generation === resolvedGeneration.current) setResolved(undefined)
    }
  }, [operations])

  const loadAuthority = useCallback(async (): Promise<void> => {
    authorityRequest.current?.abort()
    const controller = new AbortController()
    authorityRequest.current = controller
    try {
      const next = await operations.automaticRouting(controller.signal)
      if (!controller.signal.aborted) setAuthority(next)
    } catch {
      if (!controller.signal.aborted) setAuthority(undefined)
    }
  }, [operations])

  const loadCatalog = useCallback(async (): Promise<void> => {
    catalogRequest.current?.abort()
    const controller = new AbortController()
    catalogRequest.current = controller
    setCatalogStatus('loading')
    try {
      const next = await operations.modelCatalog()
      if (controller.signal.aborted) return
      setCatalog(next)
      setCatalogStatus('ready')
    } catch {
      if (!controller.signal.aborted) setCatalogStatus('error')
    }
  }, [operations])

  /**
   * Read the composed backend's own readiness and catalog together.
   *
   * A probe that is not composed leaves every state at "unread", which is what
   * the block reports for a backend Harnessy cannot ask. Both reads fail into
   * the state they belong to rather than into a value: a failed readiness read
   * is an unknown backend, never a healthy or an absent one, and a failed
   * catalog read leaves the picker on the stored model alone.
   */
  const loadProbe = useCallback(async (): Promise<void> => {
    const probe = operations.backendProbe
    if (probe === undefined) return
    probeRequest.current?.abort()
    const controller = new AbortController()
    probeRequest.current = controller
    setProbeState(UNREAD_PROBE)
    const [health, catalogRead] = await Promise.all([
      probe.health(controller.signal).then(
        (next): BackendHealthState => ({ status: 'ready', health: next }),
        (): BackendHealthState => ({ status: 'error' }),
      ),
      probe.catalog(controller.signal).then(
        (next): Omit<BackendProbeState, 'health'> => ({ catalog: 'ready', models: next }),
        (): Omit<BackendProbeState, 'health'> => ({ catalog: 'error', models: undefined }),
      ),
    ])
    // A read that was superseded while it was in flight must not land on top of
    // the newer one, exactly as this page's other reads are fenced.
    if (!controller.signal.aborted) setProbeState({ health, ...catalogRead })
  }, [operations])

  useEffect(() => { void loadStored() }, [loadStored, committed])
  useEffect(() => { void loadAuthority() }, [loadAuthority, committed])
  useEffect(() => { void loadResolved(workspace ?? null) }, [loadResolved, workspace, committed])
  useEffect(() => { void loadCatalog() }, [loadCatalog])
  useEffect(() => { void loadProbe() }, [loadProbe])

  /**
   * Apply one pure edit to the editor's latest section and persist only the
   * top-level fields it changed, so two edits made inside one settings
   * round-trip compose instead of overwriting each other.
   */
  const commit = useCallback((
    apply: (current: SubagentSettings) => SubagentSettings,
  ): void => {
    const base = optimistic ?? committed
    if (base === undefined) return
    const next = apply(base)
    setOptimistic(next)
    setError(undefined)
    pendingWrites.current += 1
    // The fence is the revision the edit was computed from, so a document that
    // moved under this page is refused instead of overwritten. While this page
    // is still composing over its own edits, the scope's queue owns the fence.
    void operations.write(changedFields(base, next), optimistic === undefined ? state.revision : undefined)
      .catch((cause: unknown) => {
        // Abandon the optimistic value: the stored document is the truth.
        setError(cause instanceof Error ? cause.message : t('writeFailed'))
        setOptimistic(undefined)
      })
      .finally(() => {
        pendingWrites.current -= 1
        if (pendingWrites.current === 0) setOptimistic(undefined)
      })
  }, [operations, optimistic, committed, state.revision, t])

  if (document === undefined) {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.status}>{state.status === 'unavailable' ? t('unavailable') : t('loading')}</p>
      </div>
    )
  }

  const groups: readonly ModelProviderGroup[] = catalog?.groups ?? []
  const roles = document.subagents
  const resolvedById = new Map((resolved?.subagents ?? []).map(role => [role.id, role]))
  const workspaceKey = resolved?.workspaceKey ?? null

  /**
   * Every route the document stores on a role that runs on this backend, so a
   * saved route stays listed and removable for the source it belongs to rather
   * than for a catalog that never advertised it.
   */
  const storedRoutes = (backend: string): SubagentModelRoute[] => roles.flatMap(role =>
    role.execution.backend === backend && role.model.route !== undefined ? [role.model.route] : [])

  /** Which catalog one backend's routes come from, and how far that read has got. */
  const sourceOf = (backend: string): SubagentModelSource => {
    const owner = subagentCatalogOwner(backend)
    if (owner === 'runtime') return { backend, owner, state: catalogStatus }
    // A backend-owned model space with no probe composed has no catalog this
    // browser can read; the picker keeps the stored model and says so.
    return { backend, owner, state: probe === undefined ? 'error' : probeState.catalog }
  }

  /** The rows, the split, and the source one model picker renders from. */
  const pickerFor = (backend: string, route: SubagentModelRoute | undefined): SubagentPickerSource => {
    const groupsForBackend = subagentCatalogOwner(backend) === 'runtime'
      ? groups
      : commandCodeModelGroups(probeState.models ?? { models: [] }, backend)
    const choices = subagentModelChoices(groupsForBackend, [
      ...storedRoutes(backend),
      ...route === undefined ? [] : [route],
    ])
    return { source: sourceOf(backend), choices, directory: subagentModelDirectory(choices) }
  }

  const edit = (id: string, next: SubagentDefinition): void => {
    commit(current => withDefinition(current, id, next))
  }

  const overriddenCount = workspaceKey === null
    ? 0
    : roles.reduce(
      (total, role) => total + overriddenFields(document, workspaceKey, role.id).length,
      0,
    )

  const backendRows = subagentBackendRows(
    roles.map(role => role.execution.backend),
    probe === undefined ? [] : [probe.backend],
  )

  /** The readiness line one probed backend renders in the Backends block. */
  const backendReadiness = (): ReactNode => {
    const reading = probeState.health
    if (reading.status === 'checking') {
      return <p className={css.status} aria-live="polite">{t('backendChecking')}</p>
    }
    if (reading.status === 'error') {
      return <p className={css.error} role="alert">{t('backendCheckFailed')}</p>
    }
    const health = reading.health
    const version = health.version === undefined ? '' : ` · ${t('backendVersionLead')} ${health.version}`
    return (
      <>
        <p className={css.status} aria-live="polite">
          {health.installed
            ? `${t('backendDetected')}${version} · ${health.authenticated ? t('backendAuthenticated') : t('backendNotAuthenticated')}`
            : `${t('backendMissing')} · ${health.command}`}
        </p>
        {health.installed && health.authenticated
          ? null
          : (
            <p className={css.hint}>
              {health.installed
                ? t('backendLoginHint', { command: health.command })
                : health.detail ?? t('backendLoginHint', { command: health.command })}
            </p>
          )}
      </>
    )
  }

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.description}>{t('description')}</p>
      </header>

      {state.status !== 'ready' || state.writable ? null : <p className={css.notice}>{t('readOnly')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}

      <section className={css.block} aria-label={t('backendsTitle')}>
        <h3 className={css.blockTitle}>{t('backendsTitle')}</h3>
        <p className={css.description}>{t('backendsDescription')}</p>
        {backendRows.length === 0
          ? <p className={css.status}>{t('backendsEmpty')}</p>
          : (
            <ul className={css.backends}>
              {backendRows.map(row => (
                <li key={row.backend} className={css.backend}>
                  <div className={css.backendHead}>
                    <code className={css.backendName}>{row.backend}</code>
                    {row.probed
                      ? (
                        <Button size="sm" variant="outline" onClick={() => { void loadProbe() }}>
                          {probeState.health.status === 'checking' ? t('backendRefreshing') : t('backendRefresh')}
                        </Button>
                      )
                      : null}
                  </div>
                  {row.probed ? backendReadiness() : <p className={css.hint}>{t('backendSilent')}</p>}
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className={css.block} aria-label={t('cardsTitle')}>
        <h3 className={css.blockTitle}>{t('cardsTitle')}</h3>
        {stored === undefined
          ? null
          : (
            <p className={css.hint}>
              {`${t('limitsTitle')}: ${t('limitsValue', {
                concurrency: String(stored.limits.maxConcurrentRuns),
                timeout: minutesOf(stored.limits.defaultTimeoutMs),
              })}`}
            </p>
          )}
        {roles.length === 0
          ? <p className={css.status}>{t('cardEmpty')}</p>
          : (
            <ul className={css.cards}>
              {roles.map((role) => {
                const picker = pickerFor(role.execution.backend, role.model.route)
                return (
                  <li key={role.id}>
                    <DefinitionCard
                      definition={role}
                      resolved={resolvedById.get(role.id)}
                      choices={picker.choices}
                      directory={picker.directory}
                      source={picker.source}
                      disabled={disabled}
                      t={t}
                      onEdit={(next) => { edit(role.id, next) }}
                      onDuplicate={() => { commit(current => duplicateDefinition(current, role.id)) }}
                      onDelete={() => {
                        if (!window.confirm(t('cardDeleteConfirm', { name: role.name }))) return
                        commit(current => withoutDefinition(current, role.id))
                      }}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        <div className={css.addRow}>
          <Field id={newNameId} label={t('cardAddTitle')} hint={t('cardAddHint')}>
            <DraftInput id={newNameId} value={draftName} disabled={disabled} onChange={setDraftName} />
          </Field>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || draftName.trim().length === 0}
            onClick={() => {
              const name = draftName.trim()
              if (name.length === 0) return
              setDraftName('')
              commit(current => withNewDefinition(current, {
                id: deriveSubagentId(current, name),
                name,
                enabled: true,
                purpose: '',
                whenToUse: '',
                invocation: 'automatic',
                // The picker may not have read the catalog yet, so a new role
                // starts on the backend every deployment composes and inherits
                // the calling agent's route rather than naming one.
                model: { mode: 'fixed' },
                access: 'inherit',
                instructions: '',
                execution: { backend: SUBAGENT_DEFAULT_BACKEND, background: 'auto' },
              }))
            }}
          >
            {t('cardCreate')}
          </Button>
        </div>
      </section>

      <section className={css.block} aria-label={t('overrideTitle')}>
        <h3 className={css.blockTitle}>{t('overrideTitle')}</h3>
        <p className={css.description}>{t('overrideDescription')}</p>
        {workspaceKey === null
          ? <p className={css.status}>{t('overrideNoWorkspace')}</p>
          : (
            <>
              <p className={css.hint}>{t('overrideWorkspace')}: <code>{workspaceKey}</code></p>
              {overriddenCount === 0
                ? null
                : (
                  <div className={css.actions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => { commit(current => resetWorkspace(current, workspaceKey)) }}
                    >
                      {t('overrideResetWorkspace')}
                    </Button>
                  </div>
                )}
              {roles.map((role) => {
                const effective = effectiveDefinition(document, workspaceKey, role.id) ?? role
                const picker = pickerFor(effective.execution.backend, effective.model.route)
                return (
                  <WorkspaceOverrideEditor
                    key={role.id}
                    definition={role}
                    effective={effective}
                    overridden={overriddenFields(document, workspaceKey, role.id)}
                    choices={picker.choices}
                    directory={picker.directory}
                    source={picker.source}
                    disabled={disabled}
                    t={t}
                    onField={(field, value) => {
                      commit(current => withWorkspaceField(current, workspaceKey, role.id, field, value))
                    }}
                    onResetField={(field) => {
                      commit(current => resetWorkspaceField(current, workspaceKey, role.id, field))
                    }}
                    onResetAll={() => {
                      commit(current => resetWorkspaceDefinition(current, workspaceKey, role.id))
                    }}
                  />
                )
              })}
            </>
          )}
      </section>

      <RoutingBlock
        routing={document.automaticRouting}
        authority={authority}
        groups={groups}
        disabled={disabled}
        catalogStatus={catalogStatus}
        catalogPartial={(catalog?.failures.length ?? 0) > 0}
        t={t}
        onRetry={() => { void loadCatalog() }}
        onChange={(next) => { commit(current => withAutomaticRouting(current, next)) }}
      />
    </div>
  )
}
