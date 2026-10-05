/** Read-only permission checkpoint; it does not report action execution. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './approval-definition.ts'
import css from './ApprovalCheckpoint.module.css'

/** Standard keyed Chat owner props and approval-owned copy. */
export type ApprovalCheckpointProps =
  PropsRuntime<'conversation.chat.node', 'approval-checkpoint'> & PropsLocale<'approval'>

/**
 * Render the audit summary without interactive decisions or correlated Tool detail.
 * @param props - materialized checkpoint and localized copy.
 * @returns the historical permission summary.
 */
export function ApprovalCheckpoint({ node, t }: ApprovalCheckpointProps) {
  return <section className={css.root} aria-label={t('checkpoint.title', { toolName: node.data.toolName })}>
    <div className={css.title}>{t('checkpoint.title', { toolName: node.data.toolName })}</div>
    {node.data.reason !== undefined && <div className={css.reason}>{node.data.reason}</div>}
    <div className={css.status}>{t(`checkpoint.${node.data.status}`)}</div>
  </section>
}
