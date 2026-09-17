/**
 * One model row's reasoning provenance, as the Models page shows it.
 *
 * The block is the reason a row reads as it does: whether the levels come from
 * the user's own declaration or from public metadata, which database and
 * provider entry answered, and whether that answer was live, cached, or
 * bundled. Authority is carried by words — never by colour alone — so an
 * id-only suggestion is distinguishable from an applied capability without
 * relying on styling.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models/CapabilityProvenance
 */

import type { ReactNode } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelativeTimeUnit } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelCapabilitySuggestion } from '@deepseek-ai/dsh-api-remotes/client'
import type { CapabilityProvenanceState } from './capability.ts'
import { effortLabel } from './ModelListEditor.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Copy lookup this block renders with. */
type Translate = (key: keyof typeof en, params?: Record<string, unknown>) => string

/** The relative-time bucket keys, one per {@link relativeTime} unit. */
const TIME_KEYS: Readonly<Record<RelativeTimeUnit, keyof typeof en>> = {
  now: 'timeNow',
  minutes: 'timeMinutes',
  hours: 'timeHours',
  days: 'timeDays',
  months: 'timeMonths',
  years: 'timeYears',
}

/**
 * Spell a fetch time the way every other dated row does.
 * @param fetchedAt - ISO 8601 fetch time the Host reported.
 * @param now - current epoch ms.
 * @param t - section copy.
 * @returns the relative age, or undefined when the time is unreadable.
 */
function fetchedAge(fetchedAt: string, now: number, t: Translate): string | undefined {
  const at = Date.parse(fetchedAt)
  if (Number.isNaN(at)) return undefined
  const { unit, n } = relativeTime(at, now)
  return t(TIME_KEYS[unit], { n })
}

/**
 * Name the origin tier in the words a person reads.
 * @param origin - origin tier the Host reported.
 * @param t - section copy.
 * @returns the label, or undefined for a tier no shipped deployment selects.
 */
function originLabel(origin: string, t: Translate): string | undefined {
  switch (origin) {
    case 'live': return t('capabilityOriginLive')
    case 'cache': return t('capabilityOriginCache')
    case 'bundled': return t('capabilityOriginBundled')
    // A fixture is a test's catalog, never a tier a deployment serves: it is
    // reported without an origin rather than leaking a build-time word.
    default: return undefined
  }
}

/**
 * How one provider-aware match was reached, in the words the page uses.
 * @param match - match kind the Host reported.
 * @param provider - matched provider entry.
 * @param t - section copy.
 * @returns the phrase naming that match.
 */
function matchLabel(match: string, provider: string, t: Translate): string {
  return match === 'openrouter-route'
    ? t('capabilityMatchedOpenRouter')
    : t('capabilityMatchedProvider', { provider })
}

/** Props of {@link CapabilityProvenance}. */
export interface CapabilityProvenanceProps {
  /** The Host's answer for this row, already reduced to a render state. */
  state: CapabilityProvenanceState
  /** Current epoch ms, so the fetch age renders deterministically in a test. */
  now?: number
  /** Section copy. */
  t: Translate
}

/**
 * Render one row's provenance block, or nothing when there is nothing to say.
 * @param props - the reduced state, the clock, and section copy.
 * @returns the block, or null.
 */
export function CapabilityProvenance({ state, now, t }: CapabilityProvenanceProps): ReactNode {
  if (state.kind === 'none') return null
  if (state.kind === 'disabled') {
    return <p className={styles['modelCapabilityHint']}>{t('capabilityDisabled')}</p>
  }
  if (state.kind === 'declared') {
    return (
      <dl className={styles['capabilitySource']}>
        <dt>{t('capabilitySource')}</dt>
        <dd>{t('capabilitySourceConfigured')}</dd>
        {state.notApplied === undefined
          ? null
          : (
            <dd className={styles['capabilityNotApplied']}>
              {t('capabilityNotApplied', { levels: levelsText(state.notApplied, t) })}
            </dd>
          )}
      </dl>
    )
  }
  if (state.kind === 'id-only') {
    return (
      <div className={styles['capabilitySource']}>
        <p className={styles['modelCapabilityHint']}>
          {state.claims.length > 1 ? t('capabilityAmbiguous') : t('capabilityIdOnly')}
        </p>
        {/* The claims themselves are the diagnostic behind that sentence, and
            they sit here rather than in the row's summary. */}
        {state.claims.length < 2
          ? null
          : (
            <ul className={styles['capabilityClaims']}>
              {state.claims.map(claim => (
                <li key={`${claim.source}/${claim.provider}`}>
                  {claimLine(claim, t)}
                </li>
              ))}
            </ul>
          )}
      </div>
    )
  }
  const age = state.fetchedAt === undefined ? undefined : fetchedAge(state.fetchedAt, now ?? Date.now(), t)
  const origin = originLabel(state.origin, t)
  return (
    <dl className={styles['capabilitySource']}>
      <dt>{t('capabilityReasoning')}</dt>
      <dd>{levelsText(state.levels, t)}</dd>
      <dt>{t('capabilitySource')}</dt>
      <dd>{`${t('capabilitySourcePublic')} · ${state.source}`}</dd>
      <dt className={styles['capabilityTerm']}>{t('capabilityProvider')}</dt>
      <dd>{matchLabel(state.match, state.provider, t)}</dd>
      {origin === undefined
        ? null
        : (
          <dd>
            {age === undefined
              ? origin
              : `${origin} · ${t('capabilityUpdated', { time: age })}`}
          </dd>
        )}
    </dl>
  )
}

/**
 * Name one level set.
 * @param levels - normalized level ids.
 * @param t - section copy.
 * @returns the labels joined the way the rest of the page joins them.
 */
function levelsText(levels: readonly string[], t: Translate): string {
  return levels.map(level => effortLabel(level, t)).join(' · ')
}

/**
 * Name one id-only claim.
 * @param claim - the database, provider entry, and levels it states.
 * @param t - section copy.
 * @returns the claim's line.
 */
function claimLine(claim: ModelCapabilitySuggestion, t: Translate): string {
  return `${claim.source} / ${claim.provider}: ${levelsText(claim.levels, t)}`
}
