/**
 * Collapsed-sidebar notification for the Desktop update carrier: a
 * non-interactive brand dot on the expand button, `sidebar.toggle.badge`.
 * Connection feedback takes priority, except while the shell installs, when
 * the backend disconnect it causes must not hide the update state.
 */
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { desktopUpdateCopy, updateVisible } from './desktop-update-copy.ts'
import type { SettingsRootInjected } from './shell-contract.ts'
import css from './DesktopUpdateBadge.module.css'

type BadgeProps = PropsRuntime<'sidebar.toggle.badge'> & PropsLocale<'settings'>
  & Pick<InjectFace<SettingsRootInjected>, 'useDesktopUpdate' | 'useConnectionState'>

/**
 * @param props - Framework-bound carrier and connection state.
 * @returns A non-interactive update notification on the sidebar expand button.
 */
export function DesktopUpdateBadge({ useDesktopUpdate, useConnectionState, t }: BadgeProps) {
  const view = useDesktopUpdate(value => value)
  const connection = useConnectionState(value => value)
  if ((connection === 'disconnected' || connection === 'connecting') && view.presentation?.phase !== 'installing') return null
  if (!updateVisible(view)) return null
  const copy = desktopUpdateCopy(view.presentation, view.failed, t)
  const phase = view.presentation?.phase
  return <Tooltip label={copy.detail} side="right">
    <span role="img" aria-label={copy.label} className={clsx(css.badge,
      (view.failed || phase === 'error' || phase === 'waiting') && css.warning,
      phase === 'ready' && css.ready)} />
  </Tooltip>
}
