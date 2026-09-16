/**
 * Model and reasoning-effort picker for the Subagents page.
 *
 * Built inside this package over the shared catalog data: `ModelSelect` in
 * `ui-model-selection` submits a selection to the live session rather than
 * emitting a controlled value, and a plugin may not import another plugin's
 * component, so the settings page owns its own control. The catalog itself is
 * still the Host's, so a provider or model added to a deployment appears here
 * with no change to this package.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/model-picker
 */

import type { ReactNode } from 'react'
import type { SubagentModelPolicy } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SUBAGENT_MODEL_AUTOMATIC_SELECTION,
  selectSubagentModel,
  subagentEfforts,
  subagentModelSelection,
  withSubagentEffort,
} from './catalog.ts'
import type { SubagentModelChoice, SubagentModelDirectory, SubagentModelSource } from './catalog.ts'
import { hintIdOf } from './fields.tsx'
import type { SubagentsTranslate } from './locales.ts'
import css from './SubagentsSection.module.css'

/** Props the model and effort controls render from. */
export interface ModelEffortPickerProps {
  /** Stable prefix for this picker's control ids. */
  readonly id: string
  /** Visible label of the model control. */
  readonly modelLabel: string
  /** Description of the model control, wired through `aria-describedby`. */
  readonly modelHint: string
  /** Visible label of the reasoning-effort control. */
  readonly effortLabel: string
  /** Description of the reasoning-effort control, wired through `aria-describedby`. */
  readonly effortHint: string
  /** The stored model policy. */
  readonly model: SubagentModelPolicy | undefined
  /** Every route this picker's catalog offers, advertised rows and stored leftovers together. */
  readonly choices: readonly SubagentModelChoice[]
  /** The same rows split into advertised groups and removable leftovers. */
  readonly directory: SubagentModelDirectory
  /** Which catalog those routes come from, so the choice is visible where it is made. */
  readonly source: SubagentModelSource
  /** Whether the settings document accepts writes. */
  readonly disabled: boolean
  /** The page's translate seat. */
  readonly t: SubagentsTranslate
  /** Receives the policy a selection stores. */
  readonly onChange: (next: SubagentModelPolicy) => void
}

/**
 * Render the model control and, when the selected model supports them, its reasoning levels.
 * @param props - the stored policy, the catalog rows, and the write path.
 * @returns the model row and the reasoning-effort row.
 */
export function ModelEffortPicker(props: ModelEffortPickerProps): ReactNode {
  const { id, model, choices, directory, source, disabled, t, onChange } = props
  const modelId = `${id}-model`
  const effortId = `${id}-effort`
  const pinned = model?.mode === 'fixed' ? model.route : undefined
  const efforts = subagentEfforts(choices, model)
  // An effort a saved route names but the model no longer advertises stays
  // listed: the route is real, and dropping the option would hide what a
  // delegation actually runs with.
  const stored = pinned?.reasoningEffort
  const advertised = stored !== undefined && efforts.some(effort => effort.id === stored)
  // The sentence names the catalog every option below was drawn from, because
  // the source follows the role's backend and nothing else on this control says
  // which model space a route will be interpreted in.
  const sourceNote = source.owner === 'runtime'
    ? t('modelSourceRuntime')
    : source.state === 'loading'
      ? t('modelSourceLoading', { backend: source.backend })
      : t('modelSourceBackend', { backend: source.backend })
  return (
    <>
      <div className={css.field}>
        <label className={css.label} htmlFor={modelId}>{props.modelLabel}</label>
        <select
          id={modelId}
          className={css.select}
          value={subagentModelSelection(model)}
          disabled={disabled}
          aria-describedby={hintIdOf(modelId)}
          onChange={(event) => { onChange(selectSubagentModel(choices, model, event.target.value)) }}
        >
          <option value="">{t('modelInheritOption')}</option>
          <option value={SUBAGENT_MODEL_AUTOMATIC_SELECTION}>{t('modelAutomaticOption')}</option>
          {directory.groups.map(group => (
            <optgroup key={group.provider} label={group.providerName}>
              {group.choices.map(choice => (
                <option key={choice.key} value={choice.key}>{choice.modelName}</option>
              ))}
            </optgroup>
          ))}
          {directory.unavailable.length === 0 ? null : (
            <optgroup label={t('modelUnavailableGroup')}>
              {directory.unavailable.map(choice => (
                <option key={choice.key} value={choice.key}>
                  {`${choice.modelName} ${t('modelUnavailableSuffix')}`}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <p className={css.hint} id={hintIdOf(modelId)}>{props.modelHint}</p>
        <p className={css.hint}>{sourceNote}</p>
        {source.owner === 'backend' && source.state === 'error'
          ? <p className={css.notice} role="alert">{t('modelSourceFailed', { backend: source.backend })}</p>
          : null}
        {model?.mode === 'automatic'
          ? <p className={css.notice} role="note">{t('modelAutomaticNote')}</p>
          : null}
      </div>
      <div className={css.field}>
        {pinned === undefined || efforts.length === 0
          ? (
            <>
              <span className={css.label}>{props.effortLabel}</span>
              <p className={css.hint} id={hintIdOf(effortId)}>
                {pinned === undefined ? t('effortNoRoute') : t('effortNotAdvertised')}
              </p>
            </>
          )
          : (
            <>
              <label className={css.label} htmlFor={effortId}>{props.effortLabel}</label>
              <select
                id={effortId}
                className={css.select}
                value={stored ?? ''}
                disabled={disabled}
                aria-describedby={hintIdOf(effortId)}
                onChange={(event) => { onChange({ mode: 'fixed', route: withSubagentEffort(pinned, event.target.value) }) }}
              >
                <option value="">{t('effortDefault')}</option>
                {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                {stored === undefined || advertised ? null : <option value={stored}>{stored}</option>}
              </select>
              <p className={css.hint} id={hintIdOf(effortId)}>{props.effortHint}</p>
            </>
          )}
      </div>
    </>
  )
}
