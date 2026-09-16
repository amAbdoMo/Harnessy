/** Harnessy Delegation settings section: CLI state, run limits, lanes, and workspace overrides. */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CommandCodeCatalog,
  CommandCodeDelegationView,
  CommandCodeHealth,
  ResolvedCommandCodeLane,
} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: declares the root-scope standard props (`useSessions`) this
// section reads, and the module-table row the built bundle resolves.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  COMMAND_CODE_ACCESS_MODES,
  COMMAND_CODE_EFFORTS,
  DEFAULT_COMMAND_CODE_MODEL,
  type CommandCodeAccess,
  type CommandCodeDelegationSettings,
  type CommandCodeEffort,
  type CommandCodeLaneSetting,
} from './contract.ts'
import {
  COMMAND_CODE_OVERRIDE_FIELDS,
  deriveLaneId,
  resetProjectField,
  resetProjectLane,
  withLaneField,
  withNewLane,
  withProjectField,
  withoutLane,
  type CommandCodeOverrideField,
} from './edit.ts'
import type { createDelegationSectionStore, DelegationSectionState } from './delegation-section-store.ts'
import type { DelegationKey } from './locales.ts'
import css from './DelegationSection.module.css'

/** What one delegation section read or write may return. */
export interface DelegationOperations {
  /** Read the mirrored settings snapshot. */
  snapshot: () => DelegationSectionState
  /** Observe settings snapshot replacements. */
  subscribe: (listener: () => void) => () => void
  /** Atomically persist one partial section. */
  write: (patch: Partial<CommandCodeDelegationSettings>) => Promise<void>
  /**
   * Read installation and authentication facts from the Host.
   * @param signal - this read's lifetime; the section aborts a superseded one.
   */
  health: (signal: AbortSignal) => Promise<CommandCodeHealth>
  /**
   * Read the local CLI's advisory model catalog.
   * @param signal - this read's lifetime; the section aborts a superseded one.
   */
  catalog: (signal: AbortSignal) => Promise<CommandCodeCatalog>
  /**
   * Resolve one workspace's lanes and bounds on the Host.
   * @param workspace - the Session's workspace, or null without one.
   * @param signal - this read's lifetime; the section aborts a superseded one.
   */
  view: (workspace: string | null, signal: AbortSignal) => Promise<CommandCodeDelegationView>
}

/** Registration-side data supplied to the Delegation section. */
export interface DelegationSectionInjected {
  readonly operations: DelegationOperations
}

/** Complete slot-composed Delegation section props. */
export type DelegationSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'commandCodeDelegation'>
  & PropsStore<ReturnType<typeof createDelegationSectionStore>>
  & InjectFace<DelegationSectionInjected>

const EFFORT_LABEL: Readonly<Record<CommandCodeEffort, DelegationKey>> = {
  default: 'effortDefault',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
}

const ACCESS_LABEL: Readonly<Record<CommandCodeAccess, DelegationKey>> = {
  'read-only': 'accessReadOnly',
  'full-access': 'accessFullAccess',
}

/** Replace the `{name}` placeholders one dictionary entry carries. */
function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/gu, (whole, key: string) => values[key] ?? whole)
}

/** Minutes rendered for a millisecond timeout, rounded to one decimal. */
function minutesOf(timeoutMs: number): string {
  return String(Math.round((timeoutMs / 60_000) * 10) / 10)
}

/**
 * The top-level fields one edit changed, so a write carries only what moved.
 *
 * Lane edits and workspace-override edits therefore travel as separate writes
 * and cannot overwrite each other even when both are in flight.
 * @param base - the section the edit started from.
 * @param next - the section the edit produced.
 * @returns the changed top-level fields.
 */
function changedFields(
  base: CommandCodeDelegationSettings,
  next: CommandCodeDelegationSettings,
): Partial<CommandCodeDelegationSettings> {
  const patch: Partial<CommandCodeDelegationSettings> = {}
  if (next.lanes !== base.lanes) patch.lanes = next.lanes
  if (next.projects !== base.projects) patch.projects = next.projects
  if (next.maxConcurrentRuns !== base.maxConcurrentRuns) patch.maxConcurrentRuns = next.maxConcurrentRuns
  if (next.timeoutMs !== base.timeoutMs) patch.timeoutMs = next.timeoutMs
  if (next.maxTurns !== base.maxTurns) patch.maxTurns = next.maxTurns
  return patch
}

/**
 * Local draft that adopts external changes without fighting its own writes.
 *
 * A settings write reaches the mirrored snapshot one round-trip after the
 * keystroke, and an earlier keystroke's response can land after a later one. A
 * control bound straight to the snapshot is therefore reset mid-typing; this
 * keeps the user's text and applies only a value this control did not write.
 * @param value - the committed value from the snapshot.
 * @param commit - persists one draft value.
 * @returns the value the control renders and the setter that writes it.
 */
function useDraft<T>(value: T, commit: (next: T) => void): { value: T; set: (next: T) => void } {
  const [draft, setDraft] = useState(value)
  const adopted = useRef(value)
  const written = useRef<T | undefined>(undefined)
  if (!Object.is(adopted.current, value)) {
    adopted.current = value
    // A stored value this control wrote is already what the user sees; only a
    // change from somewhere else replaces the draft.
    if (!Object.is(written.current, value)) setDraft(value)
  }
  return {
    value: draft,
    set: (next: T) => {
      written.current = next
      setDraft(next)
      commit(next)
    },
  }
}

/** Single-line text control whose draft survives the settings round-trip. */
function DraftInput({
  id, value, disabled, list, onChange,
}: {
  readonly id: string
  readonly value: string
  readonly disabled: boolean
  readonly list?: string
  readonly onChange: (next: string) => void
}) {
  const draft = useDraft(value, onChange)
  return (
    <input
      id={id}
      className={css.input}
      list={list}
      value={draft.value}
      disabled={disabled}
      onChange={(event) => { draft.set(event.target.value) }}
    />
  )
}

/** Multi-line text control whose draft survives the settings round-trip. */
function DraftTextarea({
  id, value, disabled, rows, onChange,
}: {
  readonly id: string
  readonly value: string
  readonly disabled: boolean
  readonly rows: number
  readonly onChange: (next: string) => void
}) {
  const draft = useDraft(value, onChange)
  return (
    <textarea
      id={id}
      className={css.textarea}
      rows={rows}
      value={draft.value}
      disabled={disabled}
      onChange={(event) => { draft.set(event.target.value) }}
    />
  )
}

/**
 * One numeric run bound, named by its own label and described by its hint.
 * @param label - the visible field name.
 * @param hint - the description wired through `aria-describedby`.
 * @param value - the bound as the editor renders it.
 * @param disabled - whether the settings document accepts writes.
 * @param min - the smallest accepted value.
 * @param max - the largest accepted value, when the bound has one.
 * @param step - the accepted increment, when the bound has one.
 * @param onChange - receives each parsed value the user types.
 * @returns the labelled control.
 */
function LimitField({
  label, hint, value, disabled, min, max, step, onChange,
}: {
  readonly label: string
  readonly hint: string
  readonly value: string
  readonly disabled: boolean
  readonly min: number
  readonly max?: number
  readonly step?: number
  readonly onChange: (next: number) => void
}) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{label}</label>
      <input
        id={id}
        className={css.input}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
      />
      <span className={css.hint} id={hintId}>{hint}</span>
    </div>
  )
}

/** The editor control one override field value requires. */
type OverrideFieldKind = 'text' | 'long' | 'boolean' | 'effort' | 'access'

const OVERRIDE_FIELD_KIND: Readonly<Record<CommandCodeOverrideField, OverrideFieldKind>> = {
  name: 'text',
  purpose: 'text',
  model: 'text',
  instructions: 'long',
  effort: 'effort',
  access: 'access',
  enabled: 'boolean',
}

const OVERRIDE_FIELD_LABEL: Readonly<Record<CommandCodeOverrideField, DelegationKey>> = {
  name: 'laneName',
  purpose: 'lanePurpose',
  model: 'laneModel',
  instructions: 'laneInstructions',
  effort: 'laneEffort',
  access: 'laneAccess',
  enabled: 'laneEnabled',
}

/**
 * Render the control kind one override field needs, so a boolean is a checkbox
 * and an enum is a select rather than a stringified text box.
 * @param kind - the control kind for this field.
 * @param args - the field's identity, current draft value, and write path.
 * @returns the control element.
 */
function overrideControl(kind: OverrideFieldKind, args: {
  readonly id: string
  readonly value: string | boolean
  readonly disabled: boolean
  readonly t: (key: DelegationKey) => string
  readonly set: (next: string | boolean) => void
}): ReactNode {
  const { id, value, disabled, t, set } = args
  switch (kind) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => { set(event.target.checked) }}
        />
      )
    case 'effort':
      return (
        <select
          id={id}
          className={css.select}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => { set(event.target.value) }}
        >
          {COMMAND_CODE_EFFORTS.map(effort => (
            <option key={effort} value={effort}>{t(EFFORT_LABEL[effort])}</option>
          ))}
        </select>
      )
    case 'access':
      return (
        <select
          id={id}
          className={css.select}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => { set(event.target.value) }}
        >
          {COMMAND_CODE_ACCESS_MODES.map(access => (
            <option key={access} value={access}>{t(ACCESS_LABEL[access])}</option>
          ))}
        </select>
      )
    case 'long':
      return (
        <textarea
          id={id}
          className={css.textarea}
          rows={2}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => { set(event.target.value) }}
        />
      )
    default:
      return (
        <input
          id={id}
          className={css.input}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => { set(event.target.value) }}
        />
      )
  }
}

/** One lane field in the current workspace's override editor. */
function ProjectFieldRow({
  laneId, field, value, overridden, disabled, t, onEdit, onReset,
}: {
  readonly laneId: string
  readonly field: CommandCodeOverrideField
  readonly value: string | boolean
  readonly overridden: boolean
  readonly disabled: boolean
  readonly t: (key: DelegationKey) => string
  readonly onEdit: (field: CommandCodeOverrideField, value: string | boolean) => void
  readonly onReset: (field: CommandCodeOverrideField) => void
}) {
  const id = `${laneId}-${field}`
  const draft = useDraft(value, (next) => { onEdit(field, next) })
  return (
    <li className={css.overrideRow}>
      <label className={css.overrideLabel} htmlFor={id}>
        {t(OVERRIDE_FIELD_LABEL[field])}
      </label>
      <span className={overridden ? css.overrideStateOn : css.overrideStateOff}>
        {overridden ? t('projectOverridden') : t('projectInherited')}
      </span>
      <div className={css.overrideControl}>
        {overrideControl(OVERRIDE_FIELD_KIND[field], {
          id,
          value: draft.value,
          disabled,
          t,
          set: draft.set,
        })}
      </div>
      {overridden && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { onReset(field) }}>
          {t('projectReset')}
        </Button>
      )}
    </li>
  )
}

/** One lane's complete workspace override editor. */
function ProjectLaneEditor({
  lane, resolved, disabled, t, onEdit, onResetField, onResetAll,
}: {
  readonly lane: CommandCodeLaneSetting
  readonly resolved: ResolvedCommandCodeLane | undefined
  readonly disabled: boolean
  readonly t: (key: DelegationKey) => string
  readonly onEdit: (field: CommandCodeOverrideField, value: string | boolean) => void
  readonly onResetField: (field: CommandCodeOverrideField) => void
  readonly onResetAll: () => void
}) {
  const overridden = COMMAND_CODE_OVERRIDE_FIELDS.filter(field => resolved?.overrides[field] === true)
  return (
    <fieldset className={css.projectLane}>
      <legend className={css.projectLegend}>
        {fill(t('projectOverriddenCount'), {
          name: resolved?.name ?? lane.name,
          count: String(overridden.length),
          total: String(COMMAND_CODE_OVERRIDE_FIELDS.length),
        })}
      </legend>
      <ul className={css.overrideList}>
        {COMMAND_CODE_OVERRIDE_FIELDS.map(field => (
          <ProjectFieldRow
            key={field}
            laneId={lane.id}
            field={field}
            value={resolved === undefined ? lane[field] : resolved[field]}
            overridden={resolved?.overrides[field] === true}
            disabled={disabled}
            t={t}
            onEdit={onEdit}
            onReset={onResetField}
          />
        ))}
      </ul>
      {overridden.length > 0 && (
        <div className={css.projectHeader}>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onResetAll}>
            {t('projectResetAll')}
          </Button>
        </div>
      )}
    </fieldset>
  )
}

/** One lane's editable card. These edit the lane itself, for every workspace. */
function LaneCard({
  lane, disabled, t, catalog, onChange, onDelete,
}: {
  readonly lane: CommandCodeLaneSetting
  readonly disabled: boolean
  readonly t: (key: DelegationKey) => string
  readonly catalog: CommandCodeCatalog | undefined
  readonly onChange: (field: keyof CommandCodeLaneSetting, value: string | boolean) => void
  readonly onDelete: () => void
}) {
  const fieldId = useId()
  const [search, setSearch] = useState('')
  const models = catalog?.models ?? []
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle.length === 0) return models
    return models.filter(model =>
      model.id.toLowerCase().includes(needle) || model.description.toLowerCase().includes(needle))
  }, [models, search])
  const listId = `${fieldId}-models`

  return (
    <article className={css.lane} aria-label={lane.name}>
      <header className={css.laneHeader}>
        <label className={css.laneToggle}>
          <input
            type="checkbox"
            checked={lane.enabled}
            disabled={disabled}
            onChange={(event) => { onChange('enabled', event.target.checked) }}
          />
          <span>{t('laneEnabled')}</span>
        </label>
        <code className={css.laneId}>{lane.id}</code>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
          {t('laneDelete')}
        </Button>
      </header>

      <Field id={`${fieldId}-name`} label={t('laneName')}>
        <DraftInput
          id={`${fieldId}-name`}
          value={lane.name}
          disabled={disabled}
          onChange={(next) => { onChange('name', next) }}
        />
      </Field>

      <Field id={`${fieldId}-purpose`} label={t('lanePurpose')} hint={t('lanePurposeHint')}>
        <DraftInput
          id={`${fieldId}-purpose`}
          value={lane.purpose}
          disabled={disabled}
          onChange={(next) => { onChange('purpose', next) }}
        />
      </Field>

      <Field
        id={`${fieldId}-instructions`}
        label={t('laneInstructions')}
        hint={t('laneInstructionsHint')}
      >
        <DraftTextarea
          id={`${fieldId}-instructions`}
          rows={3}
          value={lane.instructions}
          disabled={disabled}
          onChange={(next) => { onChange('instructions', next) }}
        />
      </Field>

      <div className={css.row}>
        <div className={css.grow}>
          <Field id={`${fieldId}-model`} label={t('laneModelManual')}>
            <DraftInput
              id={`${fieldId}-model`}
              list={listId}
              value={lane.model}
              disabled={disabled}
              onChange={(next) => { onChange('model', next) }}
            />
          </Field>
          <div className={css.subField}>
            <label className={css.subLabel} htmlFor={`${fieldId}-search`}>{t('laneModelSearch')}</label>
            <input
              id={`${fieldId}-search`}
              className={css.input}
              value={search}
              placeholder={t('laneModelCatalog')}
              onChange={(event) => { setSearch(event.target.value) }}
            />
          </div>
          <datalist id={listId}>
            {filtered.map(model => <option key={model.id} value={model.id}>{model.description}</option>)}
          </datalist>
          <p className={css.hint}>
            {catalog === undefined ? t('laneModelCatalogLoading') : catalog.models.length === 0 ? t('laneModelCatalogEmpty') : ''}
          </p>
        </div>

        <label className={css.field}>
          <span className={css.label}>{t('laneEffort')}</span>
          <select
            className={css.select}
            value={lane.effort}
            disabled={disabled}
            onChange={(event) => { onChange('effort', event.target.value) }}
          >
            {COMMAND_CODE_EFFORTS.map(effort => (
              <option key={effort} value={effort}>{t(EFFORT_LABEL[effort])}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.label}>{t('laneAccess')}</span>
          <select
            className={css.select}
            value={lane.access}
            disabled={disabled}
            onChange={(event) => { onChange('access', event.target.value) }}
          >
            {COMMAND_CODE_ACCESS_MODES.map(access => (
              <option key={access} value={access}>{t(ACCESS_LABEL[access])}</option>
            ))}
          </select>
        </label>
      </div>

      {lane.access === 'full-access' && (
        <p className={css.danger} role="note">{t('accessFullAccessWarning')}</p>
      )}
    </article>
  )
}

/** One labelled editor row: its own label, its control, and a described hint. */
function Field({
  id, label, hint, children,
}: {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && hint.length > 0 && <p className={css.hint}>{hint}</p>}
    </div>
  )
}

/** Render the Delegation settings section. */
export function DelegationSection({ t, useStore, useSessions, operations }: DelegationSectionProps) {
  const state = useStore(value => value)
  const workspace = useSessions((sessions) => {
    const current = sessions.current
    return current === undefined ? undefined : sessions.byId[current]?.cwd
  })
  const [health, setHealth] = useState<CommandCodeHealth | undefined>()
  const [catalog, setCatalog] = useState<CommandCodeCatalog | undefined>()
  const [view, setView] = useState<CommandCodeDelegationView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [draftName, setDraftName] = useState('')

  /**
   * The section the user is editing, kept while writes it started are in
   * flight. A settings write only reaches the mirrored snapshot a round-trip
   * later, and two edits made inside one round-trip would otherwise both read
   * the same stale document and overwrite each other's fields.
   */
  const [optimistic, setOptimistic] = useState<CommandCodeDelegationSettings | undefined>(undefined)
  const pendingWrites = useRef(0)

  /** One abort controller per Remote read, so a superseded read never lands. */
  const healthRequest = useRef<AbortController | undefined>(undefined)
  const catalogRequest = useRef<AbortController | undefined>(undefined)
  const viewRequest = useRef<AbortController | undefined>(undefined)
  const viewGeneration = useRef(0)

  const stored = state.value
  const section = optimistic ?? stored
  const disabled = state.status !== 'ready' || !state.writable

  // A superseded or unmounted section must not keep a Host request alive.
  useEffect(() => () => {
    healthRequest.current?.abort()
    catalogRequest.current?.abort()
    viewRequest.current?.abort()
  }, [])

  const refreshHealth = useCallback(async (): Promise<void> => {
    healthRequest.current?.abort()
    const controller = new AbortController()
    healthRequest.current = controller
    setBusy(true)
    try {
      const next = await operations.health(controller.signal)
      if (!controller.signal.aborted) setHealth(next)
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t('cliCheckFailed'))
      }
    } finally {
      if (healthRequest.current === controller) {
        healthRequest.current = undefined
        setBusy(false)
      }
    }
  }, [operations, t])

  const loadCatalog = useCallback(async (): Promise<void> => {
    catalogRequest.current?.abort()
    const controller = new AbortController()
    catalogRequest.current = controller
    try {
      const next = await operations.catalog(controller.signal)
      if (!controller.signal.aborted) setCatalog(next)
    } catch {
      if (!controller.signal.aborted) setCatalog({ models: [] })
    }
  }, [operations])

  const loadView = useCallback(async (target: string | null): Promise<void> => {
    viewRequest.current?.abort()
    const controller = new AbortController()
    viewRequest.current = controller
    // Generation fencing as well as aborting: a response that was already in
    // flight when this read started must not overwrite the newer view.
    const generation = ++viewGeneration.current
    try {
      const next = await operations.view(target, controller.signal)
      if (generation === viewGeneration.current) setView(next)
    } catch {
      if (generation === viewGeneration.current) setView(undefined)
    }
  }, [operations])

  useEffect(() => { void refreshHealth() }, [refreshHealth])
  useEffect(() => { void loadCatalog() }, [loadCatalog])
  // `stored` is a dependency so the resolved view — and with it every
  // inherited/overridden state — converges after each accepted write, whether
  // this section wrote it or another window did.
  useEffect(() => { void loadView(workspace ?? null) }, [loadView, workspace, stored])

  /**
   * Apply one pure edit to the editor's latest section and persist only the
   * top-level fields it changed, so two edits made inside one settings
   * round-trip compose instead of overwriting each other.
   */
  const commit = useCallback((
    apply: (current: CommandCodeDelegationSettings) => CommandCodeDelegationSettings,
  ): void => {
    const base = optimistic ?? stored
    if (base === undefined) return
    const next = apply(base)
    setOptimistic(next)
    setError(undefined)
    pendingWrites.current += 1
    void operations.write(changedFields(base, next))
      .catch((cause: unknown) => {
        // Abandon the optimistic value: the stored document is the truth.
        setError(cause instanceof Error ? cause.message : t('writeFailed'))
        setOptimistic(undefined)
      })
      .finally(() => {
        pendingWrites.current -= 1
        if (pendingWrites.current === 0) setOptimistic(undefined)
      })
  }, [operations, optimistic, stored, t])

  if (section === undefined) {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.status}>{state.status === 'unavailable' ? t('unavailable') : t('loading')}</p>
      </div>
    )
  }

  const workspaceKey = view?.workspaceKey ?? null
  const resolvedById = new Map((view?.lanes ?? []).map(lane => [lane.id, lane]))
  const resolvedOf = (laneId: string): ResolvedCommandCodeLane | undefined => resolvedById.get(laneId)

  const addLane = (): void => {
    const name = draftName.trim()
    if (name.length === 0) return
    setDraftName('')
    commit(current => withNewLane(current, {
      id: deriveLaneId(current, name),
      name,
      purpose: '',
      instructions: '',
      // The advisory catalog may not have been read, so a new lane starts on
      // the documented default rather than on a model id the Host would reject.
      model: catalog?.models[0]?.id ?? DEFAULT_COMMAND_CODE_MODEL,
      effort: 'default',
      access: 'read-only',
      enabled: true,
    }))
  }

  const newLaneId = `${useId()}-new-lane`

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.description}>{t('description')}</p>
      </header>

      {state.status !== 'ready' || state.writable ? null : <p className={css.notice}>{t('readOnly')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}

      <section className={css.block} aria-label={t('cliTitle')}>
        <h3 className={css.blockTitle}>{t('cliTitle')}</h3>
        <p className={css.description}>{t('cliDescription')}</p>
        <div className={css.cliRow}>
          <p className={css.status} aria-live="polite">
            {health === undefined
              ? t('cliChecking')
              : health.installed
                ? `${t('cliDetected')}${health.version === undefined ? '' : ` · ${t('cliVersionLead')} ${health.version}`} · ${health.authenticated ? t('cliAuthenticated') : t('cliNotAuthenticated')}`
                : `${t('cliMissing')} · ${health.command}`}
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refreshHealth() }}>
            {busy ? t('cliRefreshing') : t('cliRefresh')}
          </Button>
        </div>
        {health !== undefined && (!health.installed || !health.authenticated) && (
          <p className={css.hint}>
            {health.installed
              ? fill(t('cliLoginHint'), { command: health.command })
              : health.detail ?? fill(t('cliLoginHint'), { command: health.command })}
          </p>
        )}
      </section>

      <section className={css.block} aria-label={t('limitsTitle')}>
        <h3 className={css.blockTitle}>{t('limitsTitle')}</h3>
        <p className={css.description}>{t('limitsDescription')}</p>
        <div className={css.row}>
          <LimitField
            label={t('concurrency')}
            hint={t('concurrencyHint')}
            min={1}
            max={16}
            value={String(section.maxConcurrentRuns)}
            disabled={disabled}
            onChange={(parsed) => {
              const whole = Math.trunc(parsed)
              if (Number.isSafeInteger(whole) && whole >= 1 && whole <= 16) {
                commit(current => ({ ...current, maxConcurrentRuns: whole }))
              }
            }}
          />
          <LimitField
            label={t('timeout')}
            hint={t('timeoutHint')}
            min={1}
            step={1}
            value={minutesOf(section.timeoutMs)}
            disabled={disabled}
            onChange={(parsed) => {
              if (parsed >= 1) {
                commit(current => ({ ...current, timeoutMs: Math.round(parsed * 60_000) }))
              }
            }}
          />
          <LimitField
            label={t('turns')}
            hint={t('turnsHint')}
            min={1}
            max={1_000}
            value={String(section.maxTurns)}
            disabled={disabled}
            onChange={(parsed) => {
              const whole = Math.trunc(parsed)
              if (Number.isSafeInteger(whole) && whole >= 1 && whole <= 1_000) {
                commit(current => ({ ...current, maxTurns: whole }))
              }
            }}
          />
        </div>
      </section>

      <section className={css.block} aria-label={t('lanesTitle')}>
        <h3 className={css.blockTitle}>{t('lanesTitle')}</h3>
        <p className={css.description}>{t('lanesDescription')}</p>
        {section.lanes.length === 0 && <p className={css.status}>{t('lanesEmpty')}</p>}
        {section.lanes.map(lane => (
          <LaneCard
            key={lane.id}
            lane={lane}
            disabled={disabled}
            t={t}
            catalog={catalog}
            onChange={(field, value) => {
              commit(current => withLaneField(current, lane.id, field, value as never))
            }}
            onDelete={() => {
              if (!window.confirm(fill(t('laneDeleteConfirm'), { name: lane.name }))) return
              commit(current => withoutLane(current, lane.id))
            }}
          />
        ))}

        <div className={css.addRow}>
          <div className={css.field}>
            <label className={css.label} htmlFor={newLaneId}>{t('laneAddTitle')}</label>
            <input
              id={newLaneId}
              className={css.input}
              value={draftName}
              placeholder={t('laneName')}
              disabled={disabled}
              onChange={(event) => { setDraftName(event.target.value) }}
            />
          </div>
          <Button size="sm" variant="outline" disabled={disabled || draftName.trim().length === 0} onClick={addLane}>
            {t('laneCreate')}
          </Button>
        </div>
      </section>

      <section className={css.block} aria-label={t('projectTitle')}>
        <h3 className={css.blockTitle}>{t('projectTitle')}</h3>
        <p className={css.description}>{t('projectDescription')}</p>
        {workspaceKey === null
          ? <p className={css.status}>{t('projectNoWorkspace')}</p>
          : (
            <>
              <p className={css.hint}>{t('projectWorkspace')}: <code>{workspaceKey}</code></p>
              <p className={css.hint}>{t('projectEditorHint')}</p>
              {section.lanes.map(lane => (
                <ProjectLaneEditor
                  key={lane.id}
                  lane={lane}
                  resolved={resolvedOf(lane.id)}
                  disabled={disabled}
                  t={t}
                  onEdit={(field, value) => {
                    commit(current => withProjectField(current, workspaceKey, lane.id, field, value))
                  }}
                  onResetField={(field) => {
                    commit(current => resetProjectField(current, workspaceKey, lane.id, field))
                  }}
                  onResetAll={() => {
                    commit(current => resetProjectLane(current, workspaceKey, lane.id))
                  }}
                />
              ))}
            </>
          )}
      </section>
    </div>
  )
}
