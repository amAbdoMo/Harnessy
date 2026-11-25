/** State of the Desktop tab's explicitly started private viewer. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { BrowserRemoteShareControl } from '../browser/BrowserFrame.ts'

type ShareState = { readonly phase: 'starting' | 'setup' | 'failed' }
  | { readonly phase: 'sharing'; readonly url: string }

interface Attempt {
  view?: BrowserRemoteShareControl
  expiration?: ReturnType<typeof setTimeout>
}

/**
 * Tie a private view to the visible page that started it.
 * @param pageKey - navigation generation, absent when this page is unavailable.
 * @returns State and explicit controls for this share.
 */
export function useBrowserShare(pageKey: string | undefined): {
  readonly state: ShareState | undefined
  readonly start: (begin: () => Promise<BrowserRemoteShareControl | null>) => Promise<void>
  readonly stop: () => void
} {
  const [state, setState] = useState<ShareState>()
  const active = useRef<Attempt>()
  const release = (): Promise<void> => {
    const attempt = active.current
    active.current = undefined
    clearTimeout(attempt?.expiration)
    return attempt?.view?.stop() ?? Promise.resolve()
  }
  const stop = (): void => {
    const completion = release()
    setState(undefined)
    void completion.catch((_error: unknown) => { if (active.current === undefined) setState({ phase: 'failed' }) })
  }
  useLayoutEffect(() => {
    setState(undefined)
    const abandon = (): void => {
      void release().catch((_error: unknown) => { /* Closed renderers and retired Hosts already lose their share. */ })
    }
    const visibilityChanged = (): void => { if (document.hidden) { abandon(); setState(undefined) } }
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => { document.removeEventListener('visibilitychange', visibilityChanged); abandon() }
  }, [pageKey])
  const start = async (begin: () => Promise<BrowserRemoteShareControl | null>): Promise<void> => {
    if (pageKey === undefined || active.current !== undefined || document.hidden) return
    const attempt: Attempt = {}
    active.current = attempt
    setState({ phase: 'starting' })
    try {
      const view = await begin()
      if (active.current !== attempt) { await view?.stop(); return }
      if (view === null) {
        active.current = undefined
        setState({ phase: 'setup' })
        return
      }
      attempt.view = view
      attempt.expiration = setTimeout(stop, Math.max(0, view.expiresAt - Date.now()))
      setState({ phase: 'sharing', url: view.url })
    } catch (_error: unknown) {
      if (active.current !== attempt) return
      active.current = undefined
      setState({ phase: 'failed' })
    }
  }
  return { state, start, stop }
}
