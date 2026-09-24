import { useMemo } from 'react'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { turnChangesFromChat } from '../contract/turn-file-changes.ts'
import { FileChangesButton } from './FileChangesButton.tsx'

export interface TurnChangesDockInjected {
  openDiff: (path: string, diffs: readonly DiffHunk[]) => void
}

type TurnChangesDockProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'chat'>
  & InjectFace<TurnChangesDockInjected>

/** Live changed-file summary for the newest loaded turn. */
export function TurnChangesDock({ useChat, openDiff, t }: TurnChangesDockProps) {
  const snapshot = useChat(current => current)
  const turn = snapshot.timeline.turnOrder.at(-1)
  const changes = useMemo(
    () => turn === undefined ? undefined : turnChangesFromChat(snapshot, turn),
    [snapshot, turn],
  )
  return changes === undefined ? null : <FileChangesButton changes={changes} openDiff={openDiff} t={t} />
}
