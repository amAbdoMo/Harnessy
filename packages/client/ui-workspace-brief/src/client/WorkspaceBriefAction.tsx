import { useEffect, useRef, useState } from 'react'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceBriefActionInjected } from './index.ts'
import type { NS } from './locales.ts'
import css from './WorkspaceBriefAction.module.css'

export type WorkspaceBriefActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<WorkspaceBriefActionInjected>
  & PropsLocale<typeof NS>

type ActionState = 'idle' | 'loading' | 'success' | 'error'

/** Session-header trigger; the durable command card owns the full result. */
export function WorkspaceBriefAction({ useSession, createBrief, t }: WorkspaceBriefActionProps) {
  const openState = useSession(snapshot => snapshot.openState)
  const [state, setState] = useState<ActionState>('idle')
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const pending = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>()

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    }
  }, [])

  const label = t(state === 'loading'
    ? 'action.loading'
    : state === 'success'
      ? 'action.success'
      : state === 'error'
        ? 'action.failed'
        : 'action.idle')

  const create = (): void => {
    if (pending.current) return
    pending.current = true
    setState('loading')
    setError(null)
    void createBrief().then(() => {
      pending.current = false
      if (!alive.current) return
      setState('success')
      resetTimer.current = setTimeout(() => {
        if (alive.current) setState('idle')
      }, 1_800)
    }, (reason: unknown) => {
      pending.current = false
      if (!alive.current) return
      setState('error')
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.root} data-state={state}>
      <button
        type="button"
        className={css.button}
        aria-label={label}
        title={error ?? label}
        disabled={openState !== 'open' || state === 'loading'}
        onClick={create}
      >
        <IconBrowseOutline16 size={14} className={css.icon} />
        <span className={css.label}>{label}</span>
      </button>
      {error !== null ? <span className={css.error} role="status">{error}</span> : null}
    </span>
  )
}
