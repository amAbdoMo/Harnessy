import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AboutRow.module.css'

/** Build-owned values presented by the product About row. */
export interface AboutRowInjected {
  productName: string
  productUrl: string
  supportUrl: string
  version: string
}

/** Settings-row props composed by the slot renderer. */
export type AboutRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'customHarnessBrand'>
  & AboutRowInjected

/**
 * Render product identity, version, project, and support destinations.
 * @param props - Slot runtime, localized copy, and build-owned product values.
 * @returns the product About settings row.
 */
export function AboutRow({ productName, productUrl, supportUrl, version, t }: AboutRowProps) {
  return (
    <section className={css.root} aria-label={t('aboutLabel')}>
      <div>
        <div className={css.title}>{t('aboutTitle')}</div>
        <div className={css.summary}>{t('aboutSummary')}</div>
      </div>
      <dl className={css.facts}>
        <div><dt>{t('product')}</dt><dd>{productName}</dd></div>
        <div><dt>{t('version')}</dt><dd>{version}</dd></div>
      </dl>
      <div className={css.links}>
        <a href={productUrl} target="_blank" rel="noreferrer">{t('projectLink')}</a>
        <a href={supportUrl} target="_blank" rel="noreferrer">{t('supportLink')}</a>
      </div>
    </section>
  )
}
