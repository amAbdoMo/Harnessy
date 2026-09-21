import { useEffect, useRef, useState } from 'react'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnFileChanges } from '../contract/turn-file-changes.ts'
import css from './FileChangesButton.module.css'

/** Compact per-turn changed-file summary and file picker. */
export function FileChangesButton({ changes, openDiff, t }: {
  readonly changes: TurnFileChanges
  readonly openDiff: (path: string, diffs: readonly DiffHunk[]) => void
  readonly t: ChatViewSlotProps['t']
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      summaryRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])
  return (
    <div ref={rootRef} className={css.root}>
      <button ref={summaryRef} type="button" className={css.summary} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span>{t('changes.summary', { count: changes.files.length })}</span>
        <span className={css.added}>+{changes.added}</span>
        <span className={css.removed}>-{changes.removed}</span>
      </button>
      {open && (
        <div className={css.panel} role="group" aria-label={t('changes.list')}>
          {changes.files.map(file => (
            <button key={file.path} type="button" onClick={() => {
              setOpen(false)
              openDiff(file.path, file.diffs)
            }}>
              <span title={file.path}>{file.path}</span>
              <span><b className={css.added}>+{file.added}</b> <b className={css.removed}>-{file.removed}</b></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
