/** Secondary native Browser commands. */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconEllipsisOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserAnnotationCapture } from '../../types.ts'
import css from './Browser.module.css'

/** One available page command in the current tab. */
export interface BrowserPageCommand {
  readonly id: string
  readonly label: string
  readonly run: () => void | Promise<void>
}

const ZOOM_PRESETS = [50, 75, 90, 100, 110, 125, 150, 200, 300]

/**
 * Expose secondary actions for a native page.
 * @param props - current visible page and its permitted commands.
 * @returns the action menu and capture status.
 */
export function BrowserPageActions({ visible, disabled, hasPage, find, responsivePreview, hardReload, capture, addFeedback, zoom, commands,
  trigger, t }:
  PropsLocale<'sidebarBrowser'> & {
    readonly visible: boolean
    readonly disabled: boolean
    readonly hasPage: boolean
    readonly find: (() => void) | undefined
    readonly responsivePreview: (() => void) | undefined
    readonly hardReload: () => void
    readonly capture: () => Promise<BrowserAnnotationCapture>
    readonly addFeedback: (file: File, text: string) => boolean
    readonly zoom: { readonly factor: number; readonly set: (factor: number) => Promise<void> } | undefined
    readonly commands: readonly BrowserPageCommand[]
    readonly trigger: RefObject<HTMLButtonElement>
  }): ReactNode {
  const [open, setOpen] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'screenshot.failed' | 'page.commandFailed'>()
  const generation = useRef(0)
  const enabled = visible && !disabled
  const closeMenu = (): void => { setOpen(false); setZoomOpen(false) }
  useLayoutEffect(() => {
    if (!visible) {
      closeMenu()
      setBusy(false)
      setFailure(undefined)
    }
    return () => { generation.current++ }
  }, [visible])
  useLayoutEffect(() => { if (disabled) closeMenu() }, [disabled])
  const takeScreenshot = async (): Promise<void> => {
    const current = ++generation.current
    setBusy(true)
    setFailure(undefined)
    try {
      const shot = await capture()
      if (current !== generation.current) return
      const bytes = Uint8Array.from(atob(shot.png), character => character.charCodeAt(0))
      const file = new File([bytes], 'browser-screenshot.png', { type: 'image/png' })
      if (!addFeedback(file, [shot.title, shot.url].filter(Boolean).join('\n\n'))) setFailure('screenshot.failed')
    } catch (_error: unknown) {
      if (current === generation.current) setFailure('screenshot.failed')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  const zoomCommands: readonly BrowserPageCommand[] = zoom === undefined ? [] : ZOOM_PRESETS.map(percent => ({
    id: `zoom-${percent}`,
    label: t('page.zoom.percent', { percent }),
    run: () => zoom.set(percent / 100),
  }))
  const runCommand = async (run: BrowserPageCommand['run']): Promise<void> => {
    const current = generation.current
    setFailure(undefined)
    try { await run() }
    catch (_error: unknown) {
      if (current === generation.current) setFailure('page.commandFailed')
    }
  }
  return <>
    <Menu portal compact align="end" open={enabled && open} autoFocus={zoomOpen}
      anchor={<Tooltip label={t('page.actions')} side="bottom">
        <button type="button" className={css.tool} ref={trigger} aria-label={t('page.actions')} aria-haspopup="menu"
          aria-expanded={enabled && open} disabled={!enabled} onClick={() => { if (open) closeMenu(); else setOpen(true) }}>
          <IconEllipsisOutlineRegular size={14} />
        </button>
      </Tooltip>}
      selectedId={zoomOpen && zoom !== undefined ? `zoom-${Math.round(zoom.factor * 100)}` : undefined}
      items={zoomOpen && zoom !== undefined ? [
        { id: 'actions-back', label: t('back') }, ...zoomCommands.map(({ id, label }) => ({ id, label })),
      ] : [
        ...(find === undefined ? [] : [{ id: 'find', label: t('find.label') }]),
        { id: 'hard-reload', label: t('reload.hard'), disabled: !hasPage || busy },
        { id: 'screenshot', label: t('screenshot.add'), disabled: !hasPage || busy },
        ...(responsivePreview === undefined ? [] : [{ id: 'responsive', label: t('page.responsive'), disabled: !hasPage }]),
        ...(zoom === undefined ? [] : [{ id: 'zoom', label: t('page.zoom', { percent: Math.round(zoom.factor * 100) }) }]),
        ...commands.map(({ id, label }) => ({ id, label })),
      ]}
      onClose={closeMenu} onSelect={(id) => {
        if (id === 'zoom' || id === 'actions-back') {
          if (id === 'actions-back') trigger.current?.focus()
          setZoomOpen(id === 'zoom')
          return
        }
        closeMenu()
        if (id === 'find') find?.()
        else if (id === 'hard-reload') hardReload()
        else if (id === 'screenshot') void takeScreenshot()
        else if (id === 'responsive') responsivePreview?.()
        else {
          const command = commands.find(item => item.id === id) ?? zoomCommands.find(item => item.id === id)
          if (command !== undefined) void runCommand(command.run)
        }
      }} />
    {failure !== undefined && <span role="status" className={css.screenshotNotice}>{t(failure)}</span>}
  </>
}
