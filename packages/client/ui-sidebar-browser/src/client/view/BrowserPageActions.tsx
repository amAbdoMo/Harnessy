/** Secondary native Browser commands. */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconEllipsisOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserAnnotationCapture } from '../../types.ts'
import css from './Browser.module.css'

/**
 * Expose secondary actions for a native page.
 * @param props - current visible page and its permitted commands.
 * @returns the action menu and capture status.
 */
export function BrowserPageActions({ visible, disabled, hasPage, find, responsivePreview, hardReload, capture, addFeedback, trigger, t }:
  PropsLocale<'sidebarBrowser'> & {
    readonly visible: boolean
    readonly disabled: boolean
    readonly hasPage: boolean
    readonly find: (() => void) | undefined
    readonly responsivePreview: (() => void) | undefined
    readonly hardReload: () => void
    readonly capture: () => Promise<BrowserAnnotationCapture>
    readonly addFeedback: (file: File, text: string) => boolean
    readonly trigger: RefObject<HTMLButtonElement>
  }): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const enabled = visible && !disabled
  useLayoutEffect(() => {
    if (!visible) {
      setOpen(false)
      setBusy(false)
      setFailed(false)
    }
    return () => { generation.current++ }
  }, [visible])
  useLayoutEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const takeScreenshot = async (): Promise<void> => {
    const current = ++generation.current
    setBusy(true)
    setFailed(false)
    try {
      const shot = await capture()
      if (current !== generation.current) return
      const bytes = Uint8Array.from(atob(shot.png), character => character.charCodeAt(0))
      const file = new File([bytes], 'browser-screenshot.png', { type: 'image/png' })
      if (!addFeedback(file, [shot.title, shot.url].filter(Boolean).join('\n\n'))) setFailed(true)
    } catch (_error: unknown) {
      if (current === generation.current) setFailed(true)
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return <>
    <Menu portal compact align="end" open={enabled && open}
      anchor={<Tooltip label={t('page.actions')} side="bottom">
        <button type="button" className={css.tool} ref={trigger} aria-label={t('page.actions')} aria-haspopup="menu"
          aria-expanded={enabled && open} disabled={!enabled} onClick={() => { setOpen(value => !value) }}>
          <IconEllipsisOutlineRegular size={14} />
        </button>
      </Tooltip>}
      items={[
        ...(find === undefined ? [] : [{ id: 'find', label: t('find.label') }]),
        { id: 'hard-reload', label: t('reload.hard'), disabled: !hasPage || busy },
        { id: 'screenshot', label: t('screenshot.add'), disabled: !hasPage || busy },
        ...(responsivePreview === undefined ? [] : [{ id: 'responsive', label: t('page.responsive'), disabled: !hasPage }]),
      ]}
      onClose={() => { setOpen(false) }} onSelect={(id) => {
        setOpen(false)
        if (id === 'find') find?.()
        else if (id === 'hard-reload') hardReload()
        else if (id === 'screenshot') void takeScreenshot()
        else if (id === 'responsive') responsivePreview?.()
      }} />
    {failed && <span role="status" className={css.screenshotNotice}>{t('screenshot.failed')}</span>}
  </>
}
