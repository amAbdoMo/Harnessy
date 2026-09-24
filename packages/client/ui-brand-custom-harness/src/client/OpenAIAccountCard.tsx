import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OpenAIAccountState } from '@deepseek-ai/dsh-api-remotes/client'
import css from './OpenAIAccountCard.module.css'

/** Host operations injected by the Harnessy browser plugin. */
export interface OpenAIAccountOperations {
  describe(): Promise<{ readonly state?: OpenAIAccountState; readonly error?: string }>
  signIn(signal: AbortSignal): Promise<{ readonly authorized: boolean; readonly error?: string }>
  signOut(): Promise<string | undefined>
}

/** Private data supplied to the Models footer occupant. */
export interface OpenAIAccountInjected {
  operations: OpenAIAccountOperations
}

/** Models-footer props composed by the slot renderer. */
export type OpenAIAccountCardProps = PropsRuntime<'settings.models.footer'>
  & PropsLocale<'customHarnessBrand'>
  & OpenAIAccountInjected

/** Render account state and the cancellable browser OAuth action. */
export function OpenAIAccountCard({ operations, t }: OpenAIAccountCardProps) {
  const [state, setState] = useState<OpenAIAccountState | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [signingIn, setSigningIn] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const attempt = useRef<AbortController | undefined>()

  const load = async (): Promise<void> => {
    const result = await operations.describe()
    setState(result.state)
    setFailure(result.error)
  }

  useEffect(() => {
    let alive = true
    void operations.describe().then((result) => {
      if (!alive) return
      setState(result.state)
      setFailure(result.error)
    })
    return () => {
      alive = false
      attempt.current?.abort()
    }
  }, [operations])

  const signIn = async (): Promise<void> => {
    const controller = new AbortController()
    attempt.current = controller
    setFailure(undefined)
    setSigningIn(true)
    const result = await operations.signIn(controller.signal)
    if (attempt.current !== controller) return
    attempt.current = undefined
    setSigningIn(false)
    if (result.error !== undefined) setFailure(result.error)
    if (result.authorized) await load()
  }

  const cancel = (): void => {
    attempt.current?.abort()
    attempt.current = undefined
    setSigningIn(false)
  }

  const signOut = async (): Promise<void> => {
    setFailure(undefined)
    setSigningOut(true)
    const error = await operations.signOut()
    setSigningOut(false)
    if (error !== undefined) {
      setFailure(error)
      return
    }
    await load()
  }

  const unavailable = state !== undefined && !state.available
  const disabled = state === undefined || unavailable || !state.writable || signingOut

  return (
    <section className={css.card} aria-label={t('openAIAccountLabel')}>
      <div className={css.heading}>
        <div>
          <h3 className={css.title}>{t('openAIAccountTitle')}</h3>
          <p className={css.description}>{t('openAIAccountDescription')}</p>
        </div>
        {state?.configured
          ? (
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => { void signOut() }}>
              {signingOut ? t('openAISigningOut') : t('openAISignOut')}
            </Button>
          )
          : (
            <Button variant="primary" size="sm" disabled={disabled} onClick={() => { void signIn() }}>
              {t('openAISignIn')}
            </Button>
          )}
      </div>
      <p className={state?.configured ? css.connected : css.status}>
        {state === undefined
          ? t('openAILoading')
          : state.configured
            ? t('openAIConnected')
            : unavailable
              ? t('openAIUnavailable')
              : t('openAINotConnected')}
      </p>
      {failure === undefined ? null : <p className={css.error}>{failure}</p>}
      <Modal
        open={signingIn}
        onClose={cancel}
        title={t('openAISignInTitle')}
        closeLabel={t('close')}
        description={t('openAISignInDescription')}
        footer={<Button variant="outline" onClick={cancel}>{t('cancel')}</Button>}
      >
        <p className={css.waiting}>{t('openAISignInWaiting')}</p>
      </Modal>
    </section>
  )
}
