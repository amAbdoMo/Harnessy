/** Separate responsive tab using the retained device-preview contribution. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { claimResponsiveOpening, completeResponsiveOpening, type BrowserResponsiveOwner, type BrowserTabParams } from '../responsive.ts'
import css from './Browser.module.css'

/**
 * Compose the device preview without mounting an ordinary guest.
 * @param props - responsive tab and its renderer.
 * @returns the separate device preview.
 */
export function BrowserResponsiveBody({ tab, fullscreen, renderSlot, t }: PropsLocale<'sidebarBrowser'> & {
  readonly tab: SidebarRightTabInfo['tab']
  readonly fullscreen: boolean
  readonly renderSlot: PropsRenderSlots<'sidebar.right.pane.tab.browser.responsive'>['renderSlot']
}): ReactNode {
  const [mode, setMode] = useState<'mobile' | 'tablet'>('mobile')
  const [opening, setOpening] = useState<{ readonly id: typeof tab.id; readonly navigation: BrowserResponsiveOwner['navigation'] }>()
  const params = tab.navigation.params as BrowserTabParams | undefined
  useEffect(() => { setOpening({ id: tab.id, navigation: claimResponsiveOpening(tab) }) },
    [tab.id, tab.signal, params?.responsiveOpenId, params?.url, params?.profileId, params?.previewId])
  const navigation = opening?.id === tab.id ? opening.navigation : undefined
  return <div className={css.root}>
    <div className={css.modes} role="group" aria-label={t('mode.label')}>
      {(['mobile', 'tablet'] as const).map(device => <Button key={device} size="sm" variant={mode === device ? 'outline' : 'ghost'}
        aria-pressed={mode === device} onClick={() => { setMode(device) }}>{t(`mode.${device}`)}</Button>)}
    </div>
    {renderSlot('sidebar.right.pane.tab.browser.responsive', {
      tab, fullscreen, mode, navigation, completeOpening: () => { completeResponsiveOpening(tab) }, selectMobile: () => { setMode('mobile') },
    })}
  </div>
}
