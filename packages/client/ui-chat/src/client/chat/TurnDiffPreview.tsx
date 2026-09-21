import type { ReactNode } from 'react'
import { DiffBlock, type DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TurnDiffPreview.module.css'

export const TURN_DIFF_KIND = 'chat-turn-diff'
export const TURN_DIFF_ID = '@deepseek-ai/dsh-client-ui-chat/turn-diff'

export interface TurnDiffParams {
  readonly path: string
  readonly diffs: readonly DiffHunk[]
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Applied file hunks selected from a turn change summary. */
    'chat-turn-diff': TurnDiffParams
  }
}

type TurnDiffPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'chat'>

/** Right-sidebar viewer for one file's applied turn diffs. */
export function TurnDiffPreview({ useTabInfo, t }: TurnDiffPreviewProps): ReactNode {
  const params = useTabInfo().tab.navigation.params as TurnDiffParams
  return (
    <div className={css.root}>
      <div className={css.path} title={params.path}>{params.path}</div>
      <DiffBlock
        diffs={[...params.diffs]}
        labels={{
          copy: t('changes.copy'),
          copied: t('changes.copied'),
          collapseAria: t('changes.collapse'),
          expandAria: hidden => t('changes.expand', { count: hidden }),
          collapse: t('changes.collapse'),
          expand: hidden => t('changes.expand', { count: hidden }),
          files: count => t('changes.summary', { count }),
        }}
      />
    </div>
  )
}
