/**
 * The model list of one pi-ai provider profile, plus the action that asks the
 * provider what it serves.
 *
 * The list is the profile's `models` array as the card holds it: an empty list
 * means "serve this route's built-in catalog", and any entry replaces that
 * catalog, so a row is only ever added deliberately. Fetching asks the endpoint
 * **the form currently shows** — including a key typed but not yet saved — so
 * adding a provider is one pass instead of save-then-return; the reply is
 * candidates the user picks from, never configuration written behind them.
 *
 * A provider that cannot be interrogated (an unreachable endpoint, a protocol
 * with no readable listing) is not a dead end: the failure is shown next to the
 * rows the user can still fill in by hand.
 *
 * A row's disclosure also carries its declared capabilities. Reasoning is the
 * one that changes what the rest of Harnessy offers, and it belongs here rather
 * than on the provider card because the models under one route disagree about
 * it: the composer's effort pane offers exactly the levels the selected row
 * declares, so a provider-scoped control could only name a set some of its
 * models reject.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel, ModelCapabilityInspectionView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  declaredCapability, declaredDefaultReasoningEffort, declaredReasoningEfforts, formatCapacity,
  modelReasoningMode, parseCapacity, reasoningEffortsMap,
} from './DeepSeekModelsEditor.tsx'
import type { ModelReasoningMode } from './DeepSeekModelsEditor.tsx'
import type { ModelsOperations } from './operations.ts'
import { capabilityProvenance } from './capability.ts'
import { CapabilityProvenance } from './CapabilityProvenance.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Copy lookup a row renders with, including the params its provenance needs. */
type Translate = (key: keyof typeof en, params?: Record<string, unknown>) => string

/**
 * One configured model row. Fields this card does not edit must survive an
 * edit rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

/**
 * Display copy for each normalized effort level, keyed by the level id the
 * adapter declares. A level this build has no copy for still renders — from
 * its id — rather than disappearing from the row that declared it.
 */
const EFFORT_LABEL_KEYS: Readonly<Record<string, keyof typeof en>> = {
  off: 'effortOff',
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortExtraHigh',
  max: 'effortMax',
}

/**
 * Name one declared effort level for a person.
 * @param level - normalized level id from the adapter's vocabulary.
 * @param t - section copy.
 * @returns the level's display name, falling back to the id itself for a level
 *   this build carries no copy for.
 */
export function effortLabel(level: string, t: (key: keyof typeof en) => string): string {
  const key = EFFORT_LABEL_KEYS[level]
  return key === undefined ? `${level.charAt(0).toUpperCase()}${level.slice(1)}` : t(key)
}

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

/** What an interrogation needs, taken from the live form. */
export interface ProbeTarget {
  /** Settings namespace whose adapter family answers. */
  settingsNs: string
  /**
   * Route being edited, when the card edits one. An adapter that already
   * describes it answers from its own registry, so such a card can ask without
   * an endpoint at all.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Wire protocol the form names, when it names one. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  /** Endpoint facts for the fetch action. */
  probe: ProbeTarget
  /**
   * Copy key naming why the fetch action is unavailable, or `undefined` when
   * it is. The card owns this because the key it would send is judged there:
   * asking with a key the form has already refused spends a round trip to be
   * told what the field already says.
   */
  probeBlocked?: keyof typeof en | undefined
  /** The Host operations whose interrogation answers the fetch action. */
  operations: ModelsOperations
  /**
   * Reasoning-effort levels the owning adapter accepts, in dispatch order.
   * Empty when that adapter declares no such vocabulary, in which case a row
   * offers no reasoning control rather than one that could store a level the
   * adapter refuses.
   */
  efforts: readonly string[]
  /**
   * Whether the route being edited is one the adapter ships a catalog for.
   * The fetch action answers such a route from that catalog, so the picker
   * names it as the origin of the capability metadata it shows rather than
   * attributing it to the endpoint.
   */
  catalogServed: boolean
  /**
   * What the Host resolves for this route's models, by model id. Absent on a
   * card that is adding a route, which has no configured model to explain.
   */
  capability?: ReadonlyMap<string, ModelCapabilityInspectionView>
  /** Section copy. */
  t: Translate
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
}

/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them. They are a hint, not a mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT: Readonly<Record<CapacityField, string>> = {
  contextWindow: '256K',
  maxTokens: '32K',
}

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** Adopt a candidate, keeping whatever capacities and capability it disclosed. */
function adopt(candidate: LlmDiscoveredModel): ModelDraft {
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    // Only a source that stated the levels gets a declaration: a candidate
    // with none leaves the row undeclared, exactly as the endpoint left it.
    ...declaredCapability(candidate.reasoningEfforts, candidate.defaultReasoningEffort),
  }
}

/**
 * The row one adopted candidate should leave behind when the row already
 * exists: itself, unless it declares no reasoning capability and the candidate
 * states one. A row that declares `false` has answered the question, so it is
 * left alone.
 * @param candidate - the adopted candidate, as the answering source stated it.
 * @param existing - the row already configured under that id.
 * @returns the replacement row, or undefined when the existing row stands.
 */
function undeclared(candidate: LlmDiscoveredModel, existing: ModelDraft): ModelDraft | undefined {
  if (modelReasoningMode(existing) !== 'inherit') return undefined
  const capability = declaredCapability(candidate.reasoningEfforts, candidate.defaultReasoningEffort)
  return Object.keys(capability).length === 0 ? undefined : { ...existing, ...capability }
}

/** Props of {@link CapabilityFields}. */
interface CapabilityFieldsProps {
  /** The row being declared. */
  model: ModelDraft
  /** Zero-based row position, used in every control's accessible name. */
  index: number
  /** Reasoning-effort levels the adapter accepts, in dispatch order. */
  efforts: readonly string[]
  /** Section copy. */
  t: Translate
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
  /** Add or drop one offered level. */
  onToggleLevel: (level: string) => void
  /** Set, or clear, the level the row's requests default to. */
  onDefaultLevel: (level: string) => void
}

/**
 * One row's declared reasoning: the levels it offers and the one its requests
 * dispatch when they name none. The caller renders this only for a row that
 * declares support, because an undeclared or explicitly non-reasoning model
 * has no level set for either control to edit.
 * @param props - the row, the adapter's level vocabulary, and the row's writes.
 * @returns the level checks and the default picker.
 */
function CapabilityFields({
  model, index, efforts, t, disabled, onToggleLevel, onDefaultLevel,
}: CapabilityFieldsProps): ReactNode {
  const declared = declaredReasoningEfforts(model, efforts)
  return (
    <>
      <div className={styles['modelCapability']}>
        <span className={styles['modelFieldLabel']}>{t('modelReasoningEfforts')}</span>
        <div className={styles['effortGrid']} role="group" aria-label={`${t('modelReasoningEfforts')} ${index + 1}`}>
          {efforts.map(level => (
            <label className={styles['effortOption']} key={level}>
              <input
                type="checkbox"
                checked={declared.includes(level)}
                disabled={disabled}
                onChange={() => { onToggleLevel(level) }}
              />
              <span>{effortLabel(level, t)}</span>
            </label>
          ))}
        </div>
      </div>
      <label className={styles['modelField']}>
        <span className={styles['modelFieldLabel']}>{t('modelReasoningDefault')}</span>
        <Select
          className={styles['select']}
          value={declaredDefaultReasoningEffort(model) ?? ''}
          label={`${t('modelReasoningDefault')} ${String(index + 1)}`}
          disabled={disabled}
          options={[
            { value: '', label: t('modelReasoningDefaultNone') },
            ...declared.map(level => ({ value: level, label: effortLabel(level, t) })),
          ]}
          onChange={onDefaultLevel}
        />
      </label>
    </>
  )
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, operations, efforts, capability, t, disabled } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly LlmDiscoveredModel[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [candidateQuery, setCandidateQuery] = useState('')
  // Rows carry an id and a name; capacities are the exception, so they stay
  // folded until asked for rather than crowding every row with four inputs.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field))

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, unknown>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Rebuilt rather than spread over: an emptied optional field has to leave
      // the profile, not be stored as a value its schema would reject.
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  /**
   * Declare, or stop declaring, reasoning for one row. Each declaration is
   * written whole: a level map with no level yet, which
   * {@link validateDeepSeekModels} refuses until one is picked, so the row
   * cannot leave the editor half-declared.
   */
  const setReasoningMode = (index: number, mode: ModelReasoningMode): void => {
    patch(index, {
      ...mode === 'supported' ? { reasoningEfforts: {} } : {},
      ...mode === 'disabled' ? { reasoningEfforts: false } : {},
      ...mode === 'inherit' ? { reasoningEfforts: undefined } : {},
      // Neither a disabled nor an undeclared model can carry a default.
      ...mode === 'supported' ? {} : { defaultReasoningEffort: undefined },
    })
  }

  /**
   * Add or drop one offered level. The map is rebuilt in the adapter's own
   * level order, so the same set of checks always stores the same object
   * however it was clicked; `off` is the one level whose wire spelling is the
   * parameter's absence, which is what a null value means here.
   */
  const toggleEffort = (index: number, model: ModelDraft, level: string): void => {
    const declared = declaredReasoningEfforts(model, efforts)
    const next = declared.includes(level)
      ? declared.filter(entry => entry !== level)
      : [...declared, level]
    // Rebuilt in the adapter's level order, through the same conversion an
    // adopted provider declaration uses, so a set declared by hand and the
    // same set imported from a provider store identically.
    const map = reasoningEffortsMap(efforts.filter(entry => next.includes(entry)))
    const currentDefault = declaredDefaultReasoningEffort(model)
    patch(index, {
      reasoningEfforts: map,
      // Dropping the level a row defaults to would leave a default the
      // adapter refuses; the safest reading of the gesture is the default it
      // no longer offers.
      ...currentDefault !== undefined && !next.includes(currentDefault)
        ? { defaultReasoningEffort: undefined }
        : {},
    })
  }

  /** Set, or clear, one row's default effort. */
  const setDefaultEffort = (index: number, level: string): void => {
    patch(index, { defaultReasoningEffort: level === '' ? undefined : level })
  }

  const fetchModels = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const answer = await operations.discoverModels(probe.settingsNs, {
        ...probe.provider === undefined ? {} : { provider: probe.provider },
        ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
        ...probe.api === undefined ? {} : { api: probe.api },
        ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
      })
      if (answer.kind === 'refused') {
        setFailure(answer.message)
        return
      }
      const found = answer.models
      if (found.length === 0) {
        setFailure(t('fetchEmpty'))
        return
      }
      // Everything already configured starts unchecked, so adopting a
      // selection never silently rewrites a capacity the user corrected.
      const known = new Set(models.map(model => textOf(model, 'id')))
      setCandidateQuery('')
      setCandidates(found)
      setPicked(new Set(found.filter(model => !known.has(model.id)).map(model => model.id)))
    } finally {
      setBusy(false)
    }
  }

  const closePicker = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
    setCandidateQuery('')
  }

  const adoptPicked = (): void => {
    /* v8 ignore next -- the dialog only renders with candidates loaded */
    if (candidates === undefined) return
    const byId = new Map(models.map(model => [textOf(model, 'id'), model]))
    for (const candidate of candidates) {
      if (!picked.has(candidate.id)) continue
      // A row the user already tuned wins over the provider's own numbers.
      // Keyed by id, so a half-typed row whose id is still empty is not a
      // match and the candidate joins as its own row — correct, since a row
      // without an id is not yet a model and the create/apply gates refuse it.
      //
      // A capability the row never declared is the one exception: the row is
      // not a value to preserve but an absence, so an imported level set fills
      // it. Everything the row did declare — capacities included, and a
      // reasoning declaration the user made or refused — still wins.
      const existing = byId.get(candidate.id)
      byId.set(candidate.id, existing === undefined
        ? adopt(candidate)
        : undeclared(candidate, existing) ?? existing)
    }
    onChange([...byId.values()])
    closePicker()
  }

  const toggle = (id: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const activeCandidates = candidates ?? []
  const normalizedCandidateQuery = candidateQuery.trim().toLowerCase()
  const visibleCandidates = normalizedCandidateQuery.length === 0
    ? activeCandidates
    : activeCandidates.filter(candidate => candidate.id.toLowerCase().includes(normalizedCandidateQuery)
      || candidate.name?.toLowerCase().includes(normalizedCandidateQuery) === true)
  const allVisibleCandidatesPicked = visibleCandidates.length > 0
    && visibleCandidates.every(candidate => picked.has(candidate.id))

  const toggleVisibleCandidates = (): void => {
    setPicked((current) => {
      if (visibleCandidates.every(candidate => current.has(candidate.id))) {
        return new Set()
      }
      const next = new Set(current)
      for (const candidate of visibleCandidates) next.add(candidate.id)
      return next
    })
  }

  // A route the adapter already describes answers without an endpoint; only a
  // draft with neither has nothing to ask about.
  const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('models')}</span>
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <button
              type="button"
              className={styles['linkButton']}
              disabled={disabled}
              onClick={props.onReset}
            >
              {t('resetModels')}
            </button>
          )
          : null}
        <button
          type="button"
          className={styles['linkButton']}
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={props.probeBlocked !== undefined
            ? t(props.probeBlocked)
            : askable ? undefined : t('fetchNeedsBaseUrl')}
          onClick={() => { void fetchModels() }}
        >
          {busy ? t('fetching') : t('fetchModels')}
        </button>
      </div>
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.map((model, index) => (
        <div key={index} className={styles['modelEntry']}>
          <div className={styles['modelRow']}>
            <input
              className={styles['input']}
              type="text"
              value={textOf(model, 'id')}
              placeholder={t('modelId')}
              aria-label={`${t('modelId')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { id: event.target.value }) }}
            />
            <input
              className={styles['input']}
              type="text"
              value={textOf(model, 'name')}
              placeholder={t('modelName')}
              aria-label={`${t('modelName')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
            />
            <button
              type="button"
              className={styles['iconButton']}
              aria-label={`${t('modelAdvanced')} ${index + 1}`}
              aria-expanded={expanded.has(index)}
              title={t('modelAdvanced')}
              onClick={() => { toggleExpanded(index) }}
            >
              <IconChevron open={expanded.has(index)} />
            </button>
            <button
              type="button"
              className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
              aria-label={`${t('removeModel')} ${index + 1}`}
              title={t('removeModel')}
              disabled={disabled}
              onClick={() => {
                onChange(models.filter((_model, at) => at !== index))
                // Both stores are keyed by position, so every row after this
                // one shifts down and would otherwise inherit its neighbour's
                // state — a different row's capacities popping open, or its
                // half-typed text appearing in another row's field.
                setExpanded((current) => {
                  const next = new Set<number>()
                  for (const at of current) {
                    if (at < index) next.add(at)
                    else if (at > index) next.add(at - 1)
                  }
                  return next
                })
                setEditing(current => reindexOnRemove(current, index))
              }}
            >
              <IconTrash />
            </button>
          </div>
          {expanded.has(index)
            ? (
              <div className={styles['modelAdvanced']}>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'contextWindow')}
                    placeholder={CAPACITY_HINT.contextWindow}
                    aria-label={`${t('modelContextWindow')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                  <input
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'maxTokens')}
                    placeholder={CAPACITY_HINT.maxTokens}
                    aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
                  />
                </label>
                {/* The declared levels the adapter offers for this exact model.
                    A schema that names none (an adapter family with no
                    reasoning vocabulary) renders no control at all rather than
                    one that could only store what the adapter refuses. */}
                {efforts.length === 0
                  ? null
                  : (
                    <label className={styles['modelField']}>
                      <span className={styles['modelFieldLabel']}>{t('modelReasoning')}</span>
                      <Select
                        className={styles['select']}
                        value={modelReasoningMode(model)}
                        label={`${t('modelReasoning')} ${String(index + 1)}`}
                        disabled={disabled}
                        options={[
                          { value: 'inherit', label: t('modelReasoningInherit') },
                          { value: 'supported', label: t('modelReasoningSupported') },
                          { value: 'disabled', label: t('modelReasoningDisabled') },
                        ]}
                        onChange={(next) => { setReasoningMode(index, next) }}
                      />
                    </label>
                  )}
                {/* What an undeclared row can do about it, said where the
                    control is: the levels are never completed for the model. */}
                {efforts.length === 0 || modelReasoningMode(model) !== 'inherit'
                  ? null
                  : (
                    <p className={styles['modelCapabilityHint']}>
                      {t(props.catalogServed ? 'modelReasoningCatalogHint' : 'modelReasoningUndeclaredHint')}
                    </p>
                  )}
                <CapabilityProvenance
                  state={capabilityProvenance(capability?.get(textOf(model, 'id')), {
                    declaresNoReasoning: modelReasoningMode(model) === 'disabled',
                    ...modelReasoningMode(model) === 'supported'
                      ? { efforts: Object.keys(declaredReasoningEfforts(model, efforts)) }
                      : {},
                  })}
                  t={t}
                />
                {efforts.length === 0 || modelReasoningMode(model) !== 'supported'
                  ? null
                  : (
                    <CapabilityFields
                      model={model}
                      index={index}
                      efforts={efforts}
                      t={t}
                      disabled={disabled}
                      onToggleLevel={(level) => { toggleEffort(index, model, level) }}
                      onDefaultLevel={(level) => { setDefaultEffort(index, level) }}
                    />
                  )}
              </div>
            )
            : null}
        </div>
      ))}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, { id: '' }]) }}
      >
        {t('addModel')}
      </button>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <Modal
        open={candidates !== undefined}
        onClose={closePicker}
        title={t('fetchTitle')}
        closeLabel={t('close')}
        description={t('fetchDescription')}
        className={styles['fetchDialog'] as string}
        footer={(
          <>
            <Button variant="outline" onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="outline" onClick={adoptPicked}>{t('fetchAdopt')}</Button>
          </>
        )}
      >
        <div className={styles['candidateToolbar']}>
          <input
            className={`${styles['input']} ${styles['candidateSearch']}`}
            type="search"
            value={candidateQuery}
            placeholder={t('fetchSearch')}
            aria-label={t('fetchSearch')}
            onChange={(event) => { setCandidateQuery(event.target.value) }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={visibleCandidates.length === 0}
            onClick={toggleVisibleCandidates}
          >
            {t(allVisibleCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll')}
          </Button>
        </div>
        {/* Where the metadata below came from. A route the adapter ships is
            answered from its installed catalog; every other one is asked over
            the wire, so the same list means different things. */}
        <p className={styles['candidateSource']}>
          {t(props.catalogServed ? 'fetchSourceBuiltIn' : 'fetchSourceProvider')}
        </p>
        {visibleCandidates.length === 0
          ? <p className={styles['candidateEmpty']} role="status">{t('fetchNoMatches')}</p>
          : (
            <ul className={styles['candidateList']}>
              {visibleCandidates.map(candidate => (
                <li key={candidate.id} className={styles['candidate']}>
                  <label className={styles['candidateLabel']}>
                    <input
                      type="checkbox"
                      checked={picked.has(candidate.id)}
                      onChange={() => { toggle(candidate.id) }}
                    />
                    {/* The id alone: it is the string adoption writes, and the
                        capacities and capability the source stated are adopted
                        with it and editable in the row that appears. */}
                    <span className={styles['candidateId']}>{candidate.id}</span>
                  </label>
                  {/* The exact levels this candidate stated, named the way the
                      composer will name them. A candidate that stated none says
                      so instead of showing a default set. */}
                  <span className={styles['candidateCapability']}>
                    {candidate.reasoningEfforts === undefined
                      ? t('fetchEffortsNone')
                      : candidate.reasoningEfforts.map(level => effortLabel(level, t)).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </Modal>
    </section>
  )
}
