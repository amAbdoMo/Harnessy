/**
 * The current workspace's override editor for one stored definition.
 *
 * Every field is listed, including the ones no workspace has overridden yet, so
 * the first override is created by editing the field rather than by first adding
 * an entry. Each row reports whether this workspace overrides the field or
 * inherits it, and shows the effective value a delegation here would run with;
 * resetting one field prunes the emptied entry so the definition returns to
 * fully inherited.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/workspace-override
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentDefinition } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SUBAGENT_ACCESS_MODES,
  SUBAGENT_BACKGROUND_POLICIES,
  SUBAGENT_INVOCATION_POLICIES,
} from './contract.ts'
import {
  SUBAGENT_OVERRIDE_FIELDS,
  toolRestriction,
  withExecution,
  type SubagentOverrideField,
} from './edit.ts'
import { DraftInput, DraftNumber, DraftSelect, DraftTextarea, Field, SwitchField } from './fields.tsx'
import { ModelEffortPicker } from './ModelEffortPicker.tsx'
import type { SubagentModelChoice, SubagentModelDirectory, SubagentModelSource } from './catalog.ts'
import type { SubagentsTranslate } from './locales.ts'
import {
  ACCESS_LABEL,
  BACKGROUND_LABEL,
  INVOCATION_LABEL,
  secondsOf,
} from './DefinitionCard.tsx'
import css from './SubagentsSection.module.css'

/** Props one definition's workspace override editor renders from. */
export interface WorkspaceOverrideEditorProps {
  /** The stored definition being overridden. */
  readonly definition: SubagentDefinition
  /** The definition with this workspace's overrides already applied. */
  readonly effective: SubagentDefinition
  /** The fields this workspace replaces. */
  readonly overridden: readonly SubagentOverrideField[]
  /** Every route the model picker offers. */
  readonly choices: readonly SubagentModelChoice[]
  /** The same rows split into advertised groups and removable leftovers. */
  readonly directory: SubagentModelDirectory
  /** Which catalog those routes come from, chosen from the effective backend. */
  readonly source: SubagentModelSource
  /** Whether the settings document accepts writes. */
  readonly disabled: boolean
  /** The page's translate seat. */
  readonly t: SubagentsTranslate
  /** Receives the override value a row writes. */
  readonly onField: (field: SubagentOverrideField, value: unknown) => void
  /** Drop this workspace's override for one field. */
  readonly onResetField: (field: SubagentOverrideField) => void
  /** Drop every override this definition carries for this workspace. */
  readonly onResetAll: () => void
}

/**
 * Render one definition's workspace override editor.
 * @param props - the effective definition, its provenance, and the write paths.
 * @returns the definition's override group.
 */
export function WorkspaceOverrideEditor(props: WorkspaceOverrideEditorProps): ReactNode {
  const { definition, effective, overridden, choices, directory, source, disabled, t, onField, onResetField, onResetAll } = props
  const base = `${definition.id}-override`
  const allow = (effective.tools?.allow ?? []).join(', ')
  const deny = (effective.tools?.deny ?? []).join(', ')

  const control = (field: SubagentOverrideField): ReactNode => {
    const id = `${base}-${field}`
    switch (field) {
      case 'enabled':
        return (
          <SwitchField
            id={id}
            label={t('fieldEnabled')}
            hint={t('fieldEnabledHint')}
            checked={effective.enabled}
            disabled={disabled}
            onChange={(next) => { onField('enabled', next) }}
          />
        )
      case 'name':
        return (
          <Field id={id} label={t('fieldName')} hint={t('fieldNameHint')}>
            <DraftInput id={id} value={effective.name} disabled={disabled} onChange={(next) => { onField('name', next) }} />
          </Field>
        )
      case 'purpose':
        return (
          <Field id={id} label={t('fieldPurpose')} hint={t('fieldPurposeHint')}>
            <DraftInput id={id} value={effective.purpose} disabled={disabled} onChange={(next) => { onField('purpose', next) }} />
          </Field>
        )
      case 'whenToUse':
        return (
          <Field id={id} label={t('fieldWhenToUse')} hint={t('fieldWhenToUseHint')}>
            <DraftTextarea
              id={id}
              rows={2}
              value={effective.whenToUse}
              disabled={disabled}
              onChange={(next) => { onField('whenToUse', next) }}
            />
          </Field>
        )
      case 'model':
        return (
          <ModelEffortPicker
            id={id}
            modelLabel={t('fieldModel')}
            modelHint={t('fieldModelHint')}
            effortLabel={t('fieldEffort')}
            effortHint={t('fieldEffortHint')}
            model={effective.model}
            choices={choices}
            directory={directory}
            source={source}
            disabled={disabled}
            t={t}
            onChange={(next) => { onField('model', next) }}
          />
        )
      case 'access':
        return (
          <Field id={id} label={t('fieldAccess')} hint={t('fieldAccessHint')}>
            <DraftSelect
              id={id}
              value={effective.access}
              disabled={disabled}
              options={SUBAGENT_ACCESS_MODES.map(mode => ({ value: mode, label: t(ACCESS_LABEL[mode]) }))}
              onChange={(next) => { onField('access', next) }}
            />
          </Field>
        )
      case 'invocation':
        return (
          <Field id={id} label={t('fieldInvocation')} hint={t('fieldInvocationHint')}>
            <DraftSelect
              id={id}
              value={effective.invocation}
              disabled={disabled}
              options={SUBAGENT_INVOCATION_POLICIES.map(policy => ({
                value: policy,
                label: t(INVOCATION_LABEL[policy]),
              }))}
              onChange={(next) => { onField('invocation', next) }}
            />
          </Field>
        )
      case 'instructions':
        return (
          <Field id={id} label={t('fieldInstructions')} hint={t('fieldInstructionsHint')}>
            <DraftTextarea
              id={id}
              rows={3}
              value={effective.instructions}
              disabled={disabled}
              onChange={(next) => { onField('instructions', next) }}
            />
          </Field>
        )
      case 'tools':
        return (
          <>
            <Field id={`${id}-allow`} label={t('fieldToolsAllow')} hint={t('fieldToolsAllowHint')}>
              <DraftInput
                id={`${id}-allow`}
                value={allow}
                disabled={disabled}
                onChange={(next) => { onField('tools', toolRestriction(next, deny)) }}
              />
            </Field>
            <Field id={`${id}-deny`} label={t('fieldToolsDeny')} hint={t('fieldToolsDenyHint')}>
              <DraftInput
                id={`${id}-deny`}
                value={deny}
                disabled={disabled}
                onChange={(next) => { onField('tools', toolRestriction(allow, next)) }}
              />
            </Field>
          </>
        )
      case 'maxDepth':
        return (
          <Field id={id} label={t('fieldMaxDepth')} hint={t('fieldMaxDepthHint')}>
            <DraftNumber
              id={id}
              min={1}
              value={effective.maxDepth}
              disabled={disabled}
              onChange={(next) => { onField('maxDepth', next) }}
            />
          </Field>
        )
      default:
        return (
          <>
            <Field id={`${id}-backend`} label={t('fieldBackend')} hint={t('fieldBackendHint')}>
              <DraftInput
                id={`${id}-backend`}
                value={effective.execution.backend}
                disabled={disabled}
                onChange={(next) => { onField('execution', withExecution(effective.execution, { backend: next })) }}
              />
            </Field>
            <Field id={`${id}-background`} label={t('fieldBackground')} hint={t('fieldBackgroundHint')}>
              <DraftSelect
                id={`${id}-background`}
                value={effective.execution.background}
                disabled={disabled}
                options={SUBAGENT_BACKGROUND_POLICIES.map(policy => ({
                  value: policy,
                  label: t(BACKGROUND_LABEL[policy]),
                }))}
                onChange={(next) => { onField('execution', withExecution(effective.execution, { background: next })) }}
              />
            </Field>
            <Field id={`${id}-timeout`} label={t('fieldTimeout')} hint={t('fieldTimeoutHint')}>
              <DraftNumber
                id={`${id}-timeout`}
                min={1}
                value={secondsOf(effective.execution.timeoutMs)}
                disabled={disabled}
                onChange={(next) => {
                  onField('execution', withExecution(effective.execution, {
                    timeoutMs: next === undefined ? undefined : Math.round(next * 1000),
                  }))
                }}
              />
            </Field>
          </>
        )
    }
  }

  const [showAll, setShowAll] = useState(false)
  const toggleId = `${base}-all-fields`
  // Only the fields this workspace replaces are listed until the user asks for
  // the rest: the workspace layer is advanced work, and eleven rows per role is
  // what made this block read as a wall of controls.
  const fields = showAll ? SUBAGENT_OVERRIDE_FIELDS : overridden
  return (
    <details className={css.overrideDetails}>
      <summary className={css.overrideSummary}>
        {t('overrideLegend', {
          name: definition.name,
          count: String(overridden.length),
          total: String(SUBAGENT_OVERRIDE_FIELDS.length),
        })}
      </summary>
      <div className={css.overrideBody}>
        {overridden.length === 0 ? <p className={css.hint}>{t('overrideNone')}</p> : null}
        <label className={css.overrideToggle} htmlFor={toggleId}>
          <input
            id={toggleId}
            type="checkbox"
            checked={showAll}
            onChange={(event) => { setShowAll(event.target.checked) }}
          />
          {t('overrideShowAll')}
        </label>
        <ul className={css.overrideList}>
          {fields.map((field) => {
            const isOverridden = overridden.includes(field)
            return (
              <li key={field} className={css.overrideRow}>
                <div className={css.overrideControl}>{control(field)}</div>
                <div className={css.overrideHead}>
                  <span className={isOverridden ? css.overrideStateOn : css.overrideStateOff}>
                    {isOverridden ? t('overrideOverridden') : t('overrideInherited')}
                  </span>
                  {isOverridden
                    ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => { onResetField(field) }}
                      >
                        {t('overrideReset')}
                      </Button>
                    )
                    : null}
                </div>
              </li>
            )
          })}
        </ul>
        {overridden.length === 0
          ? null
          : (
            <div className={css.actions}>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={onResetAll}>
                {t('overrideResetAll')}
              </Button>
            </div>
          )}
      </div>
    </details>
  )
}
