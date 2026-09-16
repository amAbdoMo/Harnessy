/**
 * One stored subagent definition as an editable card.
 *
 * A card is the whole stored definition: collapsed it reports the one-line
 * summary a delegation would run with, expanded it edits every field. Nothing
 * here enforces role policy — the Host resolves and enforces it — so the page
 * only writes the fields the user changed.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/definition-card
 */

import { useId, useState } from 'react'
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
import { DraftInput, DraftNumber, DraftSelect, DraftTextarea, Field, SwitchField, hintIdOf } from './fields.tsx'
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

/** One-line explanation of each invocation policy. */
export const INVOCATION_HINT: Readonly<Record<SubagentInvocationPolicy, SubagentsKey>> = {
  automatic: 'invocationAutomaticHint',
  'ask-first': 'invocationAskFirstHint',
  manual: 'invocationManualHint',
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
  /** Whether the settings document accepts writes. */
  readonly disabled: boolean
  /** The page's translate seat. */
  readonly t: SubagentsTranslate
  /** Receives the whole definition the edit produced. */
  readonly onEdit: (next: SubagentDefinition) => void
  /** Add a disabled copy of this definition under a fresh id. */
  readonly onDuplicate: () => void
  /** Delete this definition and every workspace override that named it. */
  readonly onDelete: () => void
}

/**
 * Render one definition's card.
 * @param props - the stored definition, the resolved role, and the write paths.
 * @returns the card element.
 */
export function DefinitionCard(props: DefinitionCardProps): ReactNode {
  const { definition, resolved, choices, directory, source, disabled, t, onEdit, onDuplicate, onDelete } = props
  const [expanded, setExpanded] = useState(false)
  const fieldId = useId()
  const shown = resolved ?? definition
  const route = shown.model.mode === 'fixed' ? shown.model.route : undefined
  const effort = subagentEffortName(choices, route)
  const modelName = shown.model.mode === 'automatic'
    ? t('modelAutomatic')
    : route === undefined
      ? t('modelInherit')
      : subagentModelName(choices, route)
  const summary = [
    shown.name,
    modelName,
    ...effort === undefined ? [] : [effort],
    t(ACCESS_LABEL[shown.access]),
    t(INVOCATION_LABEL[shown.invocation]),
  ].join(' · ')
  const tools = definition.tools
  const allow = (tools?.allow ?? []).join(', ')
  const deny = (tools?.deny ?? []).join(', ')
  const execution = definition.execution
  // A card edit replaces the field on the definition it shows; the settings edit
  // module normalizes the result on its way to the document, so a cleared
  // optional field is stored as an absent key rather than an empty value.
  const set = <K extends keyof SubagentDefinition>(field: K, value: SubagentDefinition[K] | undefined): void => {
    onEdit({ ...definition, [field]: value })
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

  return (
    <article className={definition.enabled ? css.card : `${css.card} ${css.cardDisabled}`} aria-label={definition.name}>
      <header className={css.cardHead}>
        <h3 className={css.cardName}>{definition.name}</h3>
        {definition.enabled ? null : <span className={css.badge}>{t('cardDisabled')}</span>}
        {resolved === undefined && definition.enabled
          ? <span className={css.badge}>{t('cardNotActive')}</span>
          : null}
        <div className={css.cardActions}>
          <Button size="sm" variant="outline" aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>
            {expanded ? t('cardCollapse') : t('cardExpand')}
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onDuplicate}>
            {t('cardDuplicate')}
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
            {t('cardDelete')}
          </Button>
        </div>
      </header>
      <p className={css.summary}>{summary}</p>
      {expanded
        ? (
          <div className={css.fieldGrid}>
            <SwitchField
              id={enabledId}
              label={t('fieldEnabled')}
              hint={t('fieldEnabledHint')}
              checked={definition.enabled}
              disabled={disabled}
              onChange={(next) => { set('enabled', next) }}
            />
            <Field id={idId} label={t('fieldId')} hint={t('fieldIdHint')}>
              <input
                id={idId}
                className={css.input}
                value={definition.id}
                readOnly
                aria-describedby={hintIdOf(idId)}
              />
            </Field>
            <Field id={nameId} label={t('fieldName')} hint={t('fieldNameHint')}>
              <DraftInput
                id={nameId}
                value={definition.name}
                disabled={disabled}
                onChange={(next) => { set('name', next) }}
              />
            </Field>
            <Field id={purposeId} label={t('fieldPurpose')} hint={t('fieldPurposeHint')}>
              <DraftInput
                id={purposeId}
                value={definition.purpose}
                disabled={disabled}
                onChange={(next) => { set('purpose', next) }}
              />
            </Field>
            <Field id={whenId} label={t('fieldWhenToUse')} hint={t('fieldWhenToUseHint')}>
              <DraftTextarea
                id={whenId}
                rows={2}
                value={definition.whenToUse}
                disabled={disabled}
                onChange={(next) => { set('whenToUse', next) }}
              />
            </Field>
            <ModelEffortPicker
              id={fieldId}
              modelLabel={t('fieldModel')}
              modelHint={t('fieldModelHint')}
              effortLabel={t('fieldEffort')}
              effortHint={t('fieldEffortHint')}
              model={definition.model}
              choices={choices}
              directory={directory}
              source={source}
              disabled={disabled}
              t={t}
              onChange={(next) => { set('model', next) }}
            />
            <Field id={accessId} label={t('fieldAccess')} hint={t('fieldAccessHint')}>
              <DraftSelect
                id={accessId}
                value={definition.access}
                disabled={disabled}
                options={SUBAGENT_ACCESS_MODES.map(mode => ({ value: mode, label: t(ACCESS_LABEL[mode]) }))}
                onChange={(next) => { set('access', next) }}
              />
            </Field>
            {definition.access === 'danger-full-access'
              ? <p className={css.danger} role="note">{t('accessFullAccessWarning')}</p>
              : null}
            <fieldset className={css.choices} aria-describedby={hintIdOf(invocationId)}>
              <legend>{t('fieldInvocation')}</legend>
              <p className={css.hint} id={hintIdOf(invocationId)}>{t('fieldInvocationHint')}</p>
              {SUBAGENT_INVOCATION_POLICIES.map((policy) => {
                const optionId = `${invocationId}-${policy}`
                return (
                  <div key={policy} className={css.option}>
                    <input
                      id={optionId}
                      type="radio"
                      name={invocationId}
                      checked={definition.invocation === policy}
                      disabled={disabled}
                      aria-describedby={hintIdOf(optionId)}
                      onChange={() => { set('invocation', policy) }}
                    />
                    <label htmlFor={optionId}>{t(INVOCATION_LABEL[policy])}</label>
                    <p id={hintIdOf(optionId)}>{t(INVOCATION_HINT[policy])}</p>
                  </div>
                )
              })}
            </fieldset>
            <Field id={instructionsId} label={t('fieldInstructions')} hint={t('fieldInstructionsHint')}>
              <DraftTextarea
                id={instructionsId}
                rows={3}
                value={definition.instructions}
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
            <fieldset className={css.choices} aria-describedby={hintIdOf(advancedId)}>
              <legend>{t('fieldAdvanced')}</legend>
              <p className={css.hint} id={hintIdOf(advancedId)}>{t('fieldAdvancedHint')}</p>
              <div className={css.fieldGrid}>
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
                    value={definition.maxDepth}
                    disabled={disabled}
                    onChange={(next) => { set('maxDepth', next) }}
                  />
                </Field>
              </div>
            </fieldset>
          </div>
        )
        : null}
    </article>
  )
}
