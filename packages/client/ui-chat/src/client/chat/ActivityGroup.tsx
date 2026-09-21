import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ActivityCategory } from './activity-groups.ts'
import css from './ActivityGroup.module.css'

const CATEGORY_KEYS = {
  think: 'activity.think',
  read: 'activity.read',
  search: 'activity.search',
  command: 'activity.command',
  edit: 'activity.edit',
  mcp: 'activity.mcp',
  delegate: 'activity.delegate',
  tool: 'activity.tool',
} as const

/** Compact disclosure for consecutive reasoning and tool activity. */
export function ActivityGroup({ categories, hasError, turn, open, onToggle, t }: {
  readonly categories: readonly ActivityCategory[]
  readonly hasError: boolean
  readonly turn: number
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: ChatViewSlotProps['t']
}) {
  const summary = categories.map(category => t(CATEGORY_KEYS[category])).join(t('activity.separator'))
  return (
    <div className={css.root} data-chat-turn={turn} data-open={open || undefined}>
      <button type="button" className={css.toggle} aria-expanded={open} onClick={onToggle}>
        <IconChevronDownOutline14 className={css.chevron} />
        <span>{summary}</span>
        {hasError && <span className={css.error}>{t('activity.needsAttention')}</span>}
      </button>
    </div>
  )
}
