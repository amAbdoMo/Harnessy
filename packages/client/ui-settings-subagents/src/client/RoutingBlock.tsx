/**
 * The Automatic routing block: the authorization control an automatic role's
 * model choice resolves against.
 *
 * The control keeps the semantics of the Plugins card it moves from: the switch
 * gates explicit route selection, the checkbox list is the exact set of routes a
 * selection must resolve to, and a route saved against a model the catalog no
 * longer advertises stays listed so it can still be removed.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/routing-block
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelProviderGroup, SubagentAutomaticRouting } from '@deepseek-ai/dsh-api-remotes/client'
import { subagentModelChoices, subagentModelDirectory, subagentModelKey } from './catalog.ts'
import type { SubagentModelChoice } from './catalog.ts'
import { SwitchField } from './fields.tsx'
import type { SubagentsTranslate } from './locales.ts'
import css from './SubagentsSection.module.css'

/** Props the automatic-routing block renders from. */
export interface RoutingBlockProps {
  /** The authority the settings document stores. */
  readonly routing: SubagentAutomaticRouting
  /**
   * The Host's own read of that authority. It answers whether explicit route
   * selection is accepted at all, which the explanation reports.
   */
  readonly authority: SubagentAutomaticRouting | undefined
  /** The global model catalog this block draws its routes from. */
  readonly groups: readonly ModelProviderGroup[]
  /** Whether the settings document accepts writes. */
  readonly disabled: boolean
  /** How far the catalog read has got. */
  readonly catalogStatus: 'loading' | 'ready' | 'error'
  /** Whether some provider's catalog could not be read. */
  readonly catalogPartial: boolean
  /** The page's translate seat. */
  readonly t: SubagentsTranslate
  /** Retry the catalog read after a failure. */
  readonly onRetry: () => void
  /** Receives the authority one edit produced. */
  readonly onChange: (next: SubagentAutomaticRouting) => void
}

/**
 * Render the collapsible automatic-routing block.
 * @param props - the stored authority, the catalog, and the write path.
 * @returns the block element.
 */
export function RoutingBlock(props: RoutingBlockProps): ReactNode {
  const { routing, authority, groups, disabled, catalogStatus, catalogPartial, t, onRetry, onChange } = props
  const [open, setOpen] = useState(false)
  const stored = routing.allowedModels.map(route => ({ ...route }))
  const directory = subagentModelDirectory(subagentModelChoices(groups, stored))
  const selected = new Set(stored.map(subagentModelKey))
  const canEnable = stored.length > 0
  const authorized = authority?.allowedModels.length ?? stored.length
  const renderChoice = (choice: SubagentModelChoice) => {
    const checked = selected.has(choice.key)
    // Enabling already needs one route, so the last authorized route cannot be
    // removed while the flag stands; the checkbox reports that rather than
    // accepting a click that would be rejected.
    const locked = routing.enabled && checked && stored.length === 1
    return (
      <label key={choice.key} className={css.choice}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || locked}
          onChange={() => {
            onChange({
              ...routing,
              allowedModels: checked
                ? stored.filter(route => subagentModelKey(route) !== choice.key)
                : [...stored, { provider: choice.provider, model: choice.model }],
            })
          }}
        />
        <span>
          <span className={css.choiceName}>{choice.modelName}</span>
          <span className={css.choiceRoute}>{`${choice.providerName} · ${choice.provider}/${choice.model}`}</span>
        </span>
        {choice.available ? null : <span className={css.unavailable}>{t('routingUnavailable')}</span>}
      </label>
    )
  }
  const toggleId = 'subagents-automatic-routing'
  return (
    <section className={css.block} aria-label={t('routingTitle')}>
      <div className={css.blockHead}>
        <h3 className={css.blockTitle}>{t('routingTitle')}</h3>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => { setOpen(!open) }}>
          {open ? t('cardCollapse') : t('cardExpand')}
        </Button>
      </div>
      <p className={css.status}>
        {routing.enabled ? t('routingAuthority', { count: String(authorized) }) : t('routingAuthorityOff')}
      </p>
      {open
        ? (
          <>
            <SwitchField
              id={toggleId}
              label={t('routingToggle')}
              hint={t('routingDescription')}
              checked={routing.enabled}
              disabled={disabled || (!routing.enabled && !canEnable)}
              onChange={(next) => { onChange({ ...routing, enabled: next }) }}
            />
            {routing.enabled || canEnable ? null : <p className={css.notice}>{t('routingRequired')}</p>}
            {catalogStatus === 'loading'
              ? <p className={css.notice} role="status">{t('routingLoading')}</p>
              : null}
            {catalogStatus === 'error'
              ? (
                <div className={css.error} role="alert">
                  <span>{t('routingLoadFailed')}</span>
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={onRetry}>
                    {t('routingRetry')}
                  </Button>
                </div>
              )
              : null}
            {catalogPartial ? <p className={css.notice}>{t('routingPartial')}</p> : null}
            <fieldset className={css.choices}>
              <legend>{t('routingAllowed')}</legend>
              {directory.groups.map(group => (
                <div key={group.provider} className={css.choices}>
                  <div className={css.groupName}>{group.providerName}</div>
                  {group.choices.map(renderChoice)}
                </div>
              ))}
              {directory.unavailable.length === 0
                ? null
                : (
                  <div className={css.choices}>
                    <div className={css.groupName}>{t('routingUnavailableGroup')}</div>
                    {directory.unavailable.map(renderChoice)}
                  </div>
                )}
            </fieldset>
            {catalogStatus === 'ready' && directory.groups.length === 0 && directory.unavailable.length === 0
              ? <p className={css.status}>{t('routingEmpty')}</p>
              : null}
          </>
        )
        : null}
    </section>
  )
}
