import { IconBrowseOutline16, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { NS } from './locales.ts'
import css from './WorkspaceBriefCard.module.css'

export type WorkspaceBriefCardProps =
  PropsRuntime<'conversation.chat.commandview'> & PropsLocale<typeof NS>

/** Durable command renderer: loading, failed, and settled Markdown states. */
export function WorkspaceBriefCard({ node, t }: WorkspaceBriefCardProps) {
  const labels: MarkdownLabels = {
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }
  const outcome = node.outcome
  const state = outcome === null ? 'loading' : outcome.kind
  return (
    <article className={css.card} data-state={state} aria-label={t('card.title')}>
      <header className={css.header}>
        <span className={css.mark} aria-hidden="true">
          {state === 'error' ? <StateDot state="error" /> : <IconBrowseOutline16 size={14} />}
        </span>
        <span className={css.title}>{t('card.title')}</span>
        <span className={css.state} role="status">
          {state === 'loading' ? t('card.running') : state === 'error' ? t('card.failed') : ''}
        </span>
      </header>
      {outcome?.text !== undefined
        ? outcome.kind === 'success'
          ? <div className={css.markdown}><MarkdownText text={outcome.text} labels={labels} /></div>
          : <p className={css.failure}>{outcome.text}</p>
        : null}
    </article>
  )
}
