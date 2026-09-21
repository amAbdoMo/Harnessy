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
  ModelReasoningEffort,
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
import { subagentBackendEfforts, subagentBackendRows } from './backends.ts'
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
import type { SubagentSetupRuntimeState } from './DefinitionCard.tsx'
import { RoutingBlock } from './RoutingBlock.tsx'
import { WorkspaceOverrideEditor } from './WorkspaceOverrideEditor.tsx'
import { DraftInput, DraftNumber, DraftSelect, Field } from './fields.tsx'
import {
  changedFields,
  deriveSubagentId,
  duplicateDefinitionDraft,
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
  subagentDefinitionError,
} from './edit.ts'
import type { SubagentDefinitionError } from './edit.ts'
import type { createSubagentsSectionStore, SubagentsSectionState } from './section-store.ts'
import { routingOverlaps } from './routing-overlap.ts'
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
   * The backend this deployment answers for, `undefined` when it composes none.
   *
   * Not a required dependency: a Harnessy build without the Command Code
   * package must still mount this page, so the backend's own Remote namespace
   * is injected by a scope that comes and goes with it, and this live read
   * reports whichever probe such a scope published.
   */
  readonly backendProbe: SubagentBackendProbe | undefined
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

/** Product ceiling shared with the Host roster schema. */
const MAX_CONCURRENT_DELEGATIONS = 16

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
  const [newRole, setNewRole] = useState<SubagentDefinition | undefined>(undefined)
  const newNameId = `${useId()}-new-subagent`
  const limitsId = useId()
  const concurrencyModeId = `${limitsId}-concurrency-mode`
  const concurrencyId = `${limitsId}-concurrency`
  const timeoutId = `${limitsId}-timeout`

  /**
   * The section the user is editing, kept while writes it started are in
   * flight. A settings write only reaches the mirrored snapshot a round-trip
   * later, and two edits made inside one round-trip would otherwise both read
   * the same stale document and overwrite each other's fields.
   */
  const [optimistic, setOptimistic] = useState<SubagentSettings | undefined>(undefined)
  const optimisticRef = useRef<SubagentSettings | undefined>(undefined)
  const committedRef = useRef<SubagentSettings | undefined>(undefined)
  const pendingWrites = useRef(0)

  /** One abort controller per Remote read, so a superseded read never lands. */
  const storedRequest = useRef<AbortController | undefined>(undefined)
  const resolvedRequest = useRef<AbortController | undefined>(undefined)
  const authorityRequest = useRef<AbortController | undefined>(undefined)
  const catalogRequest = useRef<AbortController | undefined>(undefined)
  const probeRequest = useRef<AbortController | undefined>(undefined)
  const resolvedGeneration = useRef(0)

  const committed = state.value
  committedRef.current = committed
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
    const composing = optimisticRef.current !== undefined
    const base = optimisticRef.current ?? committedRef.current
    if (base === undefined) return
    const next = apply(base)
    optimisticRef.current = next
    setOptimistic(next)
    setError(undefined)
    pendingWrites.current += 1
    // The fence is the revision the edit was computed from, so a document that
    // moved under this page is refused instead of overwritten. While this page
    // is still composing over its own edits, the scope's queue owns the fence.
    void operations.write(changedFields(base, next), composing ? undefined : state.revision)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : t('writeFailed'))
      })
      .finally(() => {
        pendingWrites.current -= 1
        if (pendingWrites.current === 0) {
          optimisticRef.current = undefined
          setOptimistic(undefined)
        }
      })
  }, [operations, state.revision, t])

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
  const visibleLimits = stored?.limits ?? document.limits
  const overlaps = routingOverlaps(roles)

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

  /**
   * The levels one backend's own model space accepts, as this page labels them.
   *
   * A backend-owned listing carries no reasoning metadata of its own, so the
   * picker's levels for those routes come from the backend rather than from the
   * catalog; a backend that resolves through Harnessy contributes nothing here.
   */
  const backendEfforts = (backend: string): readonly ModelReasoningEffort[] =>
    subagentBackendEfforts(backend).map(effort => ({ id: effort.id, name: t(effort.label) }))

  /** The rows, the split, and the source one model picker renders from. */
  const pickerFor = (backend: string, route: SubagentModelRoute | undefined): SubagentPickerSource => {
    const groupsForBackend = subagentCatalogOwner(backend) === 'runtime'
      ? groups
      : commandCodeModelGroups(probeState.models ?? { models: [] }, backend, backendEfforts(backend))
    const choices = subagentModelChoices(groupsForBackend, [
      ...storedRoutes(backend),
      ...route === undefined ? [] : [route],
    ])
    return { source: sourceOf(backend), choices, directory: subagentModelDirectory(choices) }
  }

  const edit = (id: string, next: SubagentDefinition): void => {
    commit(current => withDefinition(current, id, next))
  }

  /** Localized copy for one Host-compatible draft validation failure. */
  const validationMessage = (failure: SubagentDefinitionError): string => {
    const key = {
      'invalid-id': 'validationInvalidId',
      'duplicate-id': 'validationDuplicateId',
      'missing-name': 'validationMissingName',
      'missing-purpose': 'validationMissingPurpose',
      'missing-backend': 'validationMissingBackend',
      'missing-route-provider': 'validationMissingRouteProvider',
      'missing-route-model': 'validationMissingRouteModel',
    } as const
    return t(key[failure])
  }

  /** Validate and persist one stored role in a single write. */
  const saveRole = (id: string, next: SubagentDefinition): string | undefined => {
    const failure = subagentDefinitionError(document, next, id)
    if (failure !== undefined) return validationMessage(failure)
    edit(id, next)
    return undefined
  }

  /** Validate and append the unsaved Create or Duplicate draft. */
  const saveNewRole = (next: SubagentDefinition): string | undefined => {
    const failure = subagentDefinitionError(document, next)
    if (failure !== undefined) return validationMessage(failure)
    commit(current => withNewDefinition(current, next))
    setNewRole(undefined)
    return undefined
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

  /** Readiness used by a role's no-token setup check. */
  const setupRuntimeFor = (backend: string): SubagentSetupRuntimeState => {
    if (probe?.backend !== backend) return 'ready'
    if (probeState.health.status === 'checking') return 'checking'
    if (probeState.health.status === 'error') return 'attention'
    const health = probeState.health.health
    return health.installed && health.authenticated ? 'ready' : 'attention'
  }

  const probedRuntimeReady = probeState.health.status === 'ready'
    && probeState.health.health.installed
    && probeState.health.health.authenticated
  const runtimeSummary = probe === undefined
    ? t('backendSummaryCount', { count: String(backendRows.length) })
    : probeState.health.status === 'checking'
      ? t('backendChecking')
      : t(probedRuntimeReady ? 'backendSummaryReady' : 'backendSummaryAttention')

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

      <section className={css.block} aria-label={t('cardsTitle')}>
        <h3 className={css.blockTitle}>{t('cardsTitle')}</h3>
        <details className={css.limitsDetails}>
          <summary className={css.limitsSummary}>
            <span>{t('limitsTitle')}</span>
            <span>{visibleLimits.maxConcurrentRuns === 'adaptive'
              ? t('limitsAdaptiveValue', { timeout: minutesOf(visibleLimits.defaultTimeoutMs) })
              : t('limitsValue', {
                concurrency: String(visibleLimits.maxConcurrentRuns),
                timeout: minutesOf(visibleLimits.defaultTimeoutMs),
              })}</span>
          </summary>
          <div className={css.limitsBody}>
            <p className={css.description}>{t('limitsDescription')}</p>
            <div className={css.fieldGrid}>
              <Field
                id={concurrencyModeId}
                label={t('limitsConcurrencyMode')}
                hint={t('limitsConcurrencyModeHint')}
              >
                <DraftSelect
                  id={concurrencyModeId}
                  value={document.limits.maxConcurrentRuns === 'adaptive' ? 'adaptive' : 'manual'}
                  disabled={disabled}
                  onChange={(next) => {
                    commit(current => ({
                      ...current,
                      limits: {
                        ...current.limits,
                        maxConcurrentRuns: next === 'adaptive' ? 'adaptive' : 4,
                      },
                    }))
                  }}
                  options={[
                    { value: 'adaptive', label: t('limitsConcurrencyAdaptive') },
                    { value: 'manual', label: t('limitsConcurrencyManual') },
                  ]}
                />
              </Field>
              {document.limits.maxConcurrentRuns === 'adaptive'
                ? null
                : (
                  <Field id={concurrencyId} label={t('limitsConcurrency')} hint={t('limitsConcurrencyHint')}>
                    <DraftNumber
                      id={concurrencyId}
                      min={1}
                      max={MAX_CONCURRENT_DELEGATIONS}
                      value={document.limits.maxConcurrentRuns}
                      disabled={disabled}
                      onChange={(next) => {
                        if (next === undefined || next < 1) return
                        commit(current => ({
                          ...current,
                          limits: { ...current.limits, maxConcurrentRuns: Math.round(next) },
                        }))
                      }}
                    />
                  </Field>
                )}
              <Field id={timeoutId} label={t('limitsTimeout')} hint={t('limitsTimeoutHint')}>
                <DraftNumber
                  id={timeoutId}
                  min={1}
                  value={Number(minutesOf(document.limits.defaultTimeoutMs))}
                  disabled={disabled}
                  onChange={(next) => {
                    if (next === undefined || next < 1) return
                    commit(current => ({
                      ...current,
                      limits: { ...current.limits, defaultTimeoutMs: Math.round(next * 60_000) },
                    }))
                  }}
                />
              </Field>
            </div>
          </div>
        </details>
        {overlaps.length === 0
          ? null
          : (
            <p className={css.routingWarning} role="note">
              {t('routingOverlap', {
                roles: overlaps.map(pair => `${pair.first} / ${pair.second}`).join(', '),
              })}
            </p>
          )}
        {roles.length === 0 && newRole === undefined
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
                      setupRuntime={setupRuntimeFor(role.execution.backend)}
                      workspaceCustomized={workspaceKey === null
                        ? undefined
                        : overriddenFields(document, workspaceKey, role.id).length > 0}
                      disabled={disabled}
                      t={t}
                      onSave={next => saveRole(role.id, next)}
                      onDuplicate={() => {
                        const copy = duplicateDefinitionDraft(document, role.id)
                        if (copy !== undefined) setNewRole(copy)
                      }}
                      onDelete={() => {
                        if (!window.confirm(t('cardDeleteConfirm', { name: role.name }))) return
                        commit(current => withoutDefinition(current, role.id))
                      }}
                      onCheckSetup={() => {
                        if (probe?.backend === role.execution.backend) void loadProbe()
                        else void loadCatalog()
                      }}
                    />
                  </li>
                )
              })}
              {newRole === undefined
                ? null
                : (
                  <li key="new-role-draft">
                    {(() => {
                      const picker = pickerFor(newRole.execution.backend, newRole.model.route)
                      return (
                        <DefinitionCard
                          definition={newRole}
                          resolved={undefined}
                          choices={picker.choices}
                          directory={picker.directory}
                          source={picker.source}
                          setupRuntime={setupRuntimeFor(newRole.execution.backend)}
                          workspaceCustomized={undefined}
                          disabled={disabled}
                          newDraft
                          t={t}
                          onSave={saveNewRole}
                          onCancelDraft={() => { setNewRole(undefined) }}
                          onDuplicate={() => {}}
                          onDelete={() => {}}
                          onCheckSetup={() => {
                            if (probe?.backend === newRole.execution.backend) void loadProbe()
                            else void loadCatalog()
                          }}
                        />
                      )
                    })()}
                  </li>
                )}
            </ul>
          )}
        <div className={css.addRow}>
          <Field id={newNameId} label={t('cardAddTitle')} hint={t('cardAddHint')}>
            <DraftInput id={newNameId} value={draftName} disabled={disabled} onChange={setDraftName} />
          </Field>
          <Button
            size="sm"
            variant="outline"
            className={css.createButton}
            disabled={disabled || draftName.trim().length === 0 || newRole !== undefined}
            onClick={() => {
              const name = draftName.trim()
              if (name.length === 0) return
              setDraftName('')
              setNewRole({
                id: deriveSubagentId(document, name),
                name,
                enabled: false,
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
              })
            }}
          >
            {t('cardCreate')}
          </Button>
        </div>
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

      {/* Runtime readiness is diagnostic context, so it stays collapsed until
          the user needs to investigate a failed setup check. */}
      <section className={css.runtimeBlock} aria-label={t('backendsTitle')}>
        <details className={css.runtimeDetails}>
          <summary className={css.runtimeSummary}>
            <span className={css.blockTitle}>{t('backendsTitle')}</span>
            <span className={css.runtimeSummaryState}>{runtimeSummary}</span>
          </summary>
          <div className={css.runtimeBody}>
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
          </div>
        </details>
      </section>

      <section className={css.runtimeBlock} aria-label={t('overrideTitle')}>
        <details className={css.runtimeDetails}>
          <summary className={css.runtimeSummary}>
            <span className={css.blockTitle}>{t('overrideTitle')}</span>
            <span className={css.runtimeSummaryState}>
              {workspaceKey === null
                ? t('overrideNoWorkspace')
                : overriddenCount === 0
                  ? t('overrideUsingGlobal')
                  : t('overrideCustomCount', { count: String(overriddenCount) })}
            </span>
          </summary>
          <div className={css.runtimeBody}>
            <p className={css.description}>{t('overrideDescription')}</p>
            {workspaceKey === null
              ? null
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
          </div>
        </details>
      </section>
    </div>
  )
}
