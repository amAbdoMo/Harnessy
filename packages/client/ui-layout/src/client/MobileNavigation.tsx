/** Phone navigation keeps the conversation mounted beneath a modal sidebar. */
import { useCallback, useEffect, useRef } from 'react'
import {
  ConnectionIndicator, IconCloseOutlineRegular, IconPanelLeftOutlineRegular,
  Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './AppFrame.module.css'

type MobileNavigationProps = Pick<AppFrameProps,
  'useSessions' | 'usePanelInfo' | 'useConnectionState' | 'reconnect' | 'renderSlot' | 'actions' | 't'> & {
    open: boolean
    width: number
    productTitle: string
  }

/**
 * Render the phone navigator and recovery strip with the existing sidebar actions.
 * @param props - Framework data, sidebar visibility, and measured phone width.
 * @returns The strip and, while open, a body-portaled navigation dialog.
 */
export function MobileNavigation({
  useSessions, usePanelInfo, useConnectionState, reconnect, renderSlot, actions, t,
  open, width, productTitle,
}: MobileNavigationProps) {
  const panel = usePanelInfo(info => info.activePanelId)
  const session = useSessions(state => Object.values(state.byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id)
  const title = useSessions(state => session === undefined ? undefined : state.byId[session]?.displayTitle)
  const connection = useConnectionState(state => state)
  const close = useCallback(() => { if (open) actions.toggleSidebar() }, [open, actions])
  const previousNavigation = useRef({ session, panel })
  useEffect(() => {
    const previous = previousNavigation.current
    previousNavigation.current = { session, panel }
    if (previous.session !== session || previous.panel !== panel) close()
  }, [session, panel, close])

  const status = connection === 'connected' ? undefined : connection ?? 'connecting'
  return (
    <>
      <header className={css.mobileHeader}>
        <div className={css.mobileTitleRow}>
          <Tooltip label={t('appMenu.toggleSidebar')}>
            <button type="button" className={css.mobileIconButton} onClick={actions.toggleSidebar}
              aria-label={t('appMenu.toggleSidebar')} aria-haspopup="dialog" aria-expanded={open}>
              <IconPanelLeftOutlineRegular size={18} />
            </button>
          </Tooltip>
          <h1 className={css.mobileTitle}>{panel === null ? title ?? productTitle : productTitle}</h1>
        </div>
        <div className={css.mobileConnection} aria-live="polite">
          <ConnectionIndicator state={status}
            disconnectedLabel={t('connection.error')} connectingLabel={t('connection.connecting')}
            recoveredLabel={t('connection.connected')} reconnectActionLabel={t('connection.reconnect')}
            restartActionLabel={t('connection.restart')} onReconnect={reconnect} />
        </div>
      </header>
      <Modal open={open} onClose={close} headless title={t('appMenu.toggleSidebar')}
        className={css.mobileDialog ?? ''} backdropBlur={false}>
        <div className={css.mobileDialogHeader}>
          <button type="button" className={css.mobileIconButton} onClick={close}
            data-modal-autofocus aria-label={t('close')}>
            <IconCloseOutlineRegular size={18} />
          </button>
        </div>
        <div className={css.mobileSidebar}>
          {open && renderSlot('sidebar', { collapsed: false, width })}
        </div>
      </Modal>
    </>
  )
}
