/**
 * One stored subagent definition as an editable card.
 *
 * A card is the whole stored definition: collapsed it reports the one-line
 * summary a delegation would run with, expanded it edits every field. Nothing
 * here enforces role policy — the Host resolves and enforces it — so the card
 * stages a complete definition and submits it only when the user saves.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/definition-card
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentDefinition, SubagentRoleView } from '@deepseek-ai/dsh-api-remotes/client'
import { subagentEffortName, subagentModelName } from './catalog.ts'
import type { SubagentModelChoice, SubagentModelDirectory, SubagentModelSource } from './catalog.ts'
import {
  SUBAGENT_ACCESS_MODES,
  SUBAGENT_BACKGROUND_POLICIES,
  SUBAGENT_INVOCATION_POLICIES,
} from './contract.ts'
import type { SubagentAccessMode, SubagentBackgroundPolicy, SubagentInvocationPolicy } from './contract.ts'
import { DraftInput, DraftNumber, DraftSelect, DraftSwitch, DraftTextarea, Field, hintIdOf } from './fields.tsx'
import { ModelEffortPicker } from './ModelEffortPicker.tsx'
import type { SubagentsKey, SubagentsTranslate } from './locales.ts'
import { toolRestriction, withExecution } from './edit.ts'
import css from './SubagentsSection.module.css'

/** Visible label of each access level. */
export const ACCESS_LABEL: Readonly<Record<SubagentAccessMode, SubagentsKey>> = {
  inherit: 'accessInherit',
  'read-only': 'accessReadOnly',
  'workspace-write': 'accessWorkspaceWrite',
  'danger-full-access': 'accessFullAccess',
}

/** Visible label of each invocation policy. */
export const INVOCATION_LABEL: Readonly<Record<SubagentInvocationPolicy, SubagentsKey>> = {
  automatic: 'invocationAutomatic',
  'ask-first': 'invocationAskFirst',
  manual: 'invocationManual',
}

/** Visible label of each background policy. */
export const BACKGROUND_LABEL: Readonly<Record<SubagentBackgroundPolicy, SubagentsKey>> = {
  auto: 'backgroundAuto',
  foreground: 'backgroundForeground',
  background: 'backgroundBackground',
}

/**
 * Seconds rendered from a stored millisecond bound.
 * @param timeoutMs - the stored bound.
 * @returns the whole-second value the control shows, or undefined when none is stored.
 */
export function secondsOf(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : Math.round(timeoutMs / 1000)
}

/** Readiness of the runtime selected by one role. */
export type SubagentSetupRuntimeState = 'checking' | 'ready' | 'attention'

/** Result shown after a user checks one role without starting a model call. */
interface SubagentSetupResult {
  /** Visual state of the result. */
  readonly state: 'checking' | 'ready' | 'attention'
  /** Localized message key explaining the result. */
  readonly copyKey: SubagentsKey
}

/**
 * Assess whether a role has enough routing guidance and resolvable execution data.
 * @param definition - the role to inspect.
 * @param source - state of the catalog that owns the selected model space.
 * @param runtime - readiness of the selected subagent runtime.
 * @returns the status and explanation the card presents.
 */
function subagentSetupResult(
  definition: SubagentDefinition,
  source: SubagentModelSource,
  runtime: SubagentSetupRuntimeState,
): SubagentSetupResult {
  if (runtime === 'checking' || source.state === 'loading') {
    return { state: 'checking', copyKey: 'setupCheckingDescription' }
  }
  if (runtime === 'attention') {
    return { state: 'attention', copyKey: 'setupRuntimeAttention' }
  }
  if (source.state === 'error') {
    return { state: 'attention', copyKey: 'setupCatalogAttention' }
  }
  if (definition.purpose.trim().length === 0 || definition.whenToUse.trim().length === 0) {
    return { state: 'attention', copyKey: 'setupGuidanceAttention' }
  }
  return { state: 'ready', copyKey: 'setupReadyDescription' }
}

/** Visible model name for one stored model policy. */
function modelNameOf(
  model: SubagentDefinition['model'],
  choices: readonly SubagentModelChoice[],
  t: SubagentsTranslate,
): string {
  if (model.mode === 'automatic') return t('modelAutomatic')
  return model.route === undefined ? t('modelInherit') : subagentModelName(choices, model.route)
}

/** Props one definition card renders from. */
export interface DefinitionCardProps {
  /** The stored definition this card edits. */
  readonly definition: SubagentDefinition
  /**
   * The values this workspace resolves the role to, when it is active here. A
   * disabled or workspace-removed role is absent, and the card then reports the
   * stored values instead.
   */
  readonly resolved: SubagentRoleView | undefined
  /** Every route the model picker offers. */
  readonly choices: readonly SubagentModelChoice[]
  /** The same rows split into advertised groups and removable leftovers. */
  readonly directory: SubagentModelDirectory
  /** Which catalog those routes come from, chosen from this definition's backend. */
  readonly source: SubagentModelSource
  /** Whether the runtime selected by this role can currently accept work. */
  readonly setupRuntime: SubagentSetupRuntimeState
  /** Whether the current workspace customizes any field, or undefined without a workspace. */
  readonly workspaceCustomized: boolean | undefined
  /** Whether the settings document accepts writes. */
  readonly disabled: boolean
  /** Whether this is a not-yet-saved role draft. */
  readonly newDraft?: boolean
  /** The page's translate seat. */
  readonly t: SubagentsTranslate
  /** Persist one complete draft, or return the localized validation error to show. */
  readonly onSave: (next: SubagentDefinition) => string | undefined
  /** Discard a not-yet-saved role draft. */
  readonly onCancelDraft?: () => void
  /** Add a disabled copy of this definition under a fresh id. */
  readonly onDuplicate: () => void
  /** Delete this definition and every workspace override that named it. */
  readonly onDelete: () => void
  /** Refresh the catalogs and runtime status used by the local setup check. */
  readonly onCheckSetup: () => void
}

/**
 * Render one definition's card.
 * @param props - the stored definition, the resolved role, and the write paths.
 * @returns the card element.
 */
export function DefinitionCard(props: DefinitionCardProps): ReactNode {
  const {
    definition,
    resolved,
    choices,
    directory,
    source,
    setupRuntime,
    workspaceCustomized,
    disabled,
    newDraft = false,
    t,
    onSave,
    onCancelDraft,
    onDuplicate,
    onDelete,
    onCheckSetup,
  } = props
  const [expanded, setExpanded] = useState(newDraft)
  const [draft, setDraft] = useState(definition)
  const [validationError, setValidationError] = useState<string | undefined>(undefined)
  const [setupVisible, setSetupVisible] = useState(false)
  const fieldId = useId()
  useEffect(() => {
    if (!expanded) setDraft(definition)
  }, [definition, expanded])
  const shown = expanded ? draft : resolved ?? definition
  const shownEnabled = expanded ? draft.enabled : definition.enabled
  const route = shown.model.mode === 'fixed' ? shown.model.route : undefined
  const effort = subagentEffortName(choices, route)
  const summaryModelName = modelNameOf(shown.model, choices, t)
  const configurationModelName = modelNameOf(draft.model, choices, t)
  const accessBadge = shown.access === 'workspace-write'
    ? css.badgeAccessWrite
    : shown.access === 'danger-full-access'
      ? css.badgeAccessFull
      : css.badgeAccessRead
  const tools = draft.tools
  const allow = (tools?.allow ?? []).join(', ')
  const deny = (tools?.deny ?? []).join(', ')
  const execution = draft.execution
  // A card edit replaces the field on the definition it shows; the settings edit
  // module normalizes the result on its way to the document, so a cleared
  // optional field is stored as an absent key rather than an empty value.
  const set = <K extends keyof SubagentDefinition>(field: K, value: SubagentDefinition[K] | undefined): void => {
    setDraft(current => ({ ...current, [field]: value }))
    setValidationError(undefined)
  }
  const nameId = `${fieldId}-name`
  const idId = `${fieldId}-id`
  const purposeId = `${fieldId}-purpose`
  const whenId = `${fieldId}-when`
  const accessId = `${fieldId}-access`
  const instructionsId = `${fieldId}-instructions`
  const allowId = `${fieldId}-allow`
  const denyId = `${fieldId}-deny`
  const backendId = `${fieldId}-backend`
  const backgroundId = `${fieldId}-background`
  const timeoutId = `${fieldId}-timeout`
  const depthId = `${fieldId}-depth`
  const invocationId = `${fieldId}-invocation`
  const advancedId = `${fieldId}-advanced`
  const enabledId = `${fieldId}-enabled`
  const setup = subagentSetupResult(draft, source, setupRuntime)

  const cancel = (): void => {
    setDraft(definition)
    setValidationError(undefined)
    setSetupVisible(false)
    if (newDraft) onCancelDraft?.()
    else setExpanded(false)
  }

  const save = (): void => {
    const failure = onSave(draft)
    if (failure !== undefined) {
      setValidationError(failure)
      return
    }
    setValidationError(undefined)
    setSetupVisible(false)
    if (!newDraft) setExpanded(false)
  }

  return (
    <article className={shownEnabled ? css.card : `${css.card} ${css.cardDisabled}`} aria-label={shown.name}>
      <header className={css.cardHead}>
        <div className={css.cardIdentity}>
          <h3 className={css.cardName}>{shown.name}</h3>
          <p className={shown.purpose.trim().length === 0 ? css.cardPurposeMissing : css.cardPurpose}>
            {shown.purpose.trim().length === 0 ? t('cardNoPurpose') : shown.purpose}
          </p>
        </div>
        {resolved === undefined && definition.enabled
          ? <span className={css.badge}>{t('cardNotActive')}</span>
          : null}
        <div className={css.cardActions}>
          <span className={css.enabledControl}>
            <DraftSwitch
              id={enabledId}
              checked={shownEnabled}
              disabled={disabled}
              onChange={(next) => {
                if (expanded) set('enabled', next)
                else {
                  const failure = onSave({ ...definition, enabled: next })
                  if (failure !== undefined) setValidationError(failure)
                }
              }}
            />
            <label className={css.label} htmlFor={enabledId}>
              {t(shownEnabled ? 'fieldEnabled' : 'cardDisabled')}
            </label>
            <span className={css.visuallyHidden} id={hintIdOf(enabledId)}>{t('fieldEnabledHint')}</span>
          </span>
          {newDraft
            ? null
            : (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={expanded}
                onClick={() => {
                  if (expanded) cancel()
                  else {
                    setDraft(definition)
                    setExpanded(true)
                  }
                }}
              >
                {expanded ? t('cardCancel') : t('cardExpand')}
              </Button>
            )}
        </div>
      </header>
      <div className={css.summaryBadges} aria-label={t('cardRunTitle')}>
        <span className={`${css.summaryBadge} ${css.badgeModel}`}>{summaryModelName}</span>
        {effort === undefined ? null : <span className={css.summaryBadge}>{effort}</span>}
        <span className={`${css.summaryBadge} ${accessBadge}`}>{t(ACCESS_LABEL[shown.access])}</span>
        <span className={`${css.summaryBadge} ${css.badgeInvocation}`}>{t(INVOCATION_LABEL[shown.invocation])}</span>
        {workspaceCustomized === undefined
          ? null
          : (
            <span className={`${css.summaryBadge} ${workspaceCustomized ? css.badgeCustom : ''}`}>
              {t(workspaceCustomized ? 'cardWorkspaceCustom' : 'cardWorkspaceInherited')}
            </span>
          )}
      </div>
      {expanded
        ? (
          <div className={css.editor}>
            <section className={css.editorSection} aria-labelledby={`${fieldId}-role-title`}>
              <h4 className={css.editorTitle} id={`${fieldId}-role-title`}>{t('cardRoleTitle')}</h4>
              <div className={css.primaryFields}>
                <Field id={nameId} label={t('fieldName')} hint={t('fieldNameHint')}>
                  <DraftInput
                    id={nameId}
                    value={draft.name}
                    disabled={disabled}
                    onChange={(next) => { set('name', next) }}
                  />
                </Field>
                <Field id={purposeId} label={t('fieldPurpose')} hint={t('fieldPurposeHint')}>
                  <DraftInput
                    id={purposeId}
                    value={draft.purpose}
                    disabled={disabled}
                    onChange={(next) => { set('purpose', next) }}
                  />
                </Field>
              </div>
            </section>

            <details className={css.routingGuidance}>
              <summary className={css.routingGuidanceSummary}>{t('cardRoutingTitle')}</summary>
              <div className={css.routingGuidanceBody}>
                <p className={css.hint}>{t('cardRoutingDescription')}</p>
                <Field id={whenId} label={t('fieldWhenToUse')} hint={t('fieldWhenToUseHint')}>
                  <DraftTextarea
                    id={whenId}
                    rows={2}
                    value={draft.whenToUse}
                    disabled={disabled}
                    onChange={(next) => { set('whenToUse', next) }}
                  />
                </Field>
              </div>
            </details>

            <section className={css.editorSection} aria-labelledby={`${fieldId}-run-title`}>
              <h4 className={css.editorTitle} id={`${fieldId}-run-title`}>{t('cardRunTitle')}</h4>
              <div className={css.runGrid}>
                <ModelEffortPicker
                  id={fieldId}
                  modelLabel={t('fieldModel')}
                  modelHint={t('fieldModelHint')}
                  effortLabel={t('fieldEffort')}
                  effortHint={t('fieldEffortHint')}
                  model={draft.model}
                  choices={choices}
                  directory={directory}
                  source={source}
                  sourceDetails="hidden"
                  disabled={disabled}
                  t={t}
                  onChange={(next) => { set('model', next) }}
                />
                <Field id={accessId} label={t('fieldAccess')} hint={t('fieldAccessHint')}>
                  <DraftSelect
                    id={accessId}
                    value={draft.access}
                    disabled={disabled}
                    options={SUBAGENT_ACCESS_MODES.map(mode => ({ value: mode, label: t(ACCESS_LABEL[mode]) }))}
                    onChange={(next) => { set('access', next) }}
                  />
                </Field>
                <Field id={invocationId} label={t('fieldInvocation')} hint={t('fieldInvocationHint')}>
                  <DraftSelect
                    id={invocationId}
                    value={draft.invocation}
                    disabled={disabled}
                    options={SUBAGENT_INVOCATION_POLICIES.map(policy => ({
                      value: policy,
                      label: t(INVOCATION_LABEL[policy]),
                    }))}
                    onChange={(next) => { set('invocation', next) }}
                  />
                </Field>
              </div>
              {draft.access === 'danger-full-access'
                ? <p className={css.danger} role="note">{t('accessFullAccessWarning')}</p>
                : null}
            </section>

            <div className={css.setupRow}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSetupVisible(true)
                  onCheckSetup()
                }}
              >
                {t('setupCheck')}
              </Button>
              <span className={css.setupPrivacy}>{t('setupNoModelCall')}</span>
            </div>
            {setupVisible
              ? (
                <div
                  className={`${css.setupResult} ${setup.state === 'ready' ? css.setupResultReady : css.setupResultAttention}`}
                  role="status"
                  aria-live="polite"
                >
                  <strong>{t(setup.state === 'ready' ? 'setupReady' : setup.state === 'checking' ? 'setupChecking' : 'setupAttention')}</strong>
                  <p>{t(setup.copyKey)}</p>
                  <p className={css.setupFacts}>
                    {`${t('fieldBackend')}: ${draft.execution.backend} · ${t('fieldModel')}: ${configurationModelName} · ${t('fieldAccess')}: ${t(ACCESS_LABEL[draft.access])} · ${t('fieldInvocation')}: ${t(INVOCATION_LABEL[draft.invocation])}`}
                  </p>
                </div>
              )
              : null}

            <details className={css.advanced}>
              <summary className={css.advancedSummary}>{t('fieldAdvanced')}</summary>
              <div className={css.advancedBody}>
                <p className={css.hint} id={hintIdOf(advancedId)}>{t('fieldAdvancedHint')}</p>
                <div className={css.fieldGrid}>
                  <Field id={idId} label={t('fieldId')} hint={t('fieldIdHint')}>
                    <input
                      id={idId}
                      className={css.input}
                      value={draft.id}
                      readOnly={!newDraft}
                      disabled={disabled}
                      onChange={newDraft ? (event) => { set('id', event.currentTarget.value) } : undefined}
                      aria-describedby={hintIdOf(idId)}
                    />
                  </Field>
                  <Field id={instructionsId} label={t('fieldInstructions')} hint={t('fieldInstructionsHint')}>
                    <DraftTextarea
                      id={instructionsId}
                      rows={3}
                      value={draft.instructions}
                      disabled={disabled}
                      onChange={(next) => { set('instructions', next) }}
                    />
                  </Field>
                  <Field id={allowId} label={t('fieldToolsAllow')} hint={t('fieldToolsAllowHint')}>
                    <DraftInput
                      id={allowId}
                      value={allow}
                      disabled={disabled}
                      onChange={(next) => { set('tools', toolRestriction(next, deny)) }}
                    />
                  </Field>
                  <Field id={denyId} label={t('fieldToolsDeny')} hint={t('fieldToolsDenyHint')}>
                    <DraftInput
                      id={denyId}
                      value={deny}
                      disabled={disabled}
                      onChange={(next) => { set('tools', toolRestriction(allow, next)) }}
                    />
                  </Field>
                  <Field id={backendId} label={t('fieldBackend')} hint={t('fieldBackendHint')}>
                    <DraftInput
                      id={backendId}
                      value={execution.backend}
                      disabled={disabled}
                      onChange={(next) => { set('execution', withExecution(execution, { backend: next })) }}
                    />
                  </Field>
                  <Field id={backgroundId} label={t('fieldBackground')} hint={t('fieldBackgroundHint')}>
                    <DraftSelect
                      id={backgroundId}
                      value={execution.background}
                      disabled={disabled}
                      options={SUBAGENT_BACKGROUND_POLICIES.map(policy => ({
                        value: policy,
                        label: t(BACKGROUND_LABEL[policy]),
                      }))}
                      onChange={(next) => { set('execution', withExecution(execution, { background: next })) }}
                    />
                  </Field>
                  <Field id={timeoutId} label={t('fieldTimeout')} hint={t('fieldTimeoutHint')}>
                    <DraftNumber
                      id={timeoutId}
                      min={1}
                      value={secondsOf(execution.timeoutMs)}
                      disabled={disabled}
                      onChange={(next) => {
                        set('execution', withExecution(execution, {
                          timeoutMs: next === undefined ? undefined : Math.round(next * 1000),
                        }))
                      }}
                    />
                  </Field>
                  <Field id={depthId} label={t('fieldMaxDepth')} hint={t('fieldMaxDepthHint')}>
                    <DraftNumber
                      id={depthId}
                      min={1}
                      value={draft.maxDepth}
                      disabled={disabled}
                      onChange={(next) => { set('maxDepth', next) }}
                    />
                  </Field>
                </div>
              </div>
            </details>
            {validationError === undefined
              ? null
              : <p className={css.error} role="alert">{validationError}</p>}
            <div className={css.secondaryActions}>
              {newDraft
                ? null
                : (
                  <div className={css.destructiveActions}>
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { onDuplicate(); cancel() }}>
                      {t('cardDuplicate')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
                      {t('cardDelete')}
                    </Button>
                  </div>
                )}
              <Button size="sm" variant="ghost" disabled={disabled} onClick={cancel}>
                {t('cardCancel')}
              </Button>
              <Button size="sm" variant="primary" disabled={disabled} onClick={save}>
                {t(newDraft ? 'cardSaveRole' : 'cardSaveChanges')}
              </Button>
            </div>
          </div>
        )
        : null}
    </article>
  )
}
