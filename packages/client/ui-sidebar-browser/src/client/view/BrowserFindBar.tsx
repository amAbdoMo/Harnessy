/** Find text in the currently visible native page. */
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserFindResult } from '../browser/BrowserFrame.ts'
import type { BrowserTabControllers } from '../browser/BrowserController.ts'
import css from './Browser.module.css'

/**
 * Search and step through native matches from the active tab.
 * @param props - current occurrence, search controls and match result.
 * @returns inline native search controls.
 */
export function BrowserFindBar({ tabId, input, findInPage, result, onClose, t }: PropsLocale<'sidebarBrowser'> & {
  readonly tabId: TabId
  readonly input: RefObject<HTMLInputElement>
  readonly findInPage: BrowserTabControllers['findInPage']
  readonly result: BrowserFindResult | 'failed' | undefined
  readonly onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  useEffect(() => {
    input.current?.focus()
    return () => { findInPage(tabId, '') }
  }, [findInPage, input, tabId])
  const matches = typeof result === 'object' ? result.matches : 0
  const step = (forward: boolean): void => {
    if (query !== '' && matches > 0) findInPage(tabId, query, forward)
  }
  return (
    <div className={css.findBar} role="search" aria-label={t('find.label')} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }}>
      <input ref={input} className={css.findInput} type="search" value={query} aria-label={t('find.label')}
        placeholder={t('find.label')} maxLength={200} spellCheck={false} autoComplete="off"
        onChange={(event) => {
          const value = event.currentTarget.value
          setQuery(value)
          findInPage(tabId, value)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter') return
          event.preventDefault()
          step(!event.shiftKey)
        }} />
      <span className={css.findResult} role="status">
        {query === '' || result === undefined ? '' : result === 'failed' ? t('find.failed')
          : result.matches === 0 ? t('find.empty') : t('find.count', { active: result.active, total: result.matches })}
      </span>
      <Tooltip label={t('find.previous')} side="bottom">
        <button type="button" className={css.tool} aria-label={t('find.previous')} disabled={matches === 0} onClick={() => { step(false) }}>
          <IconChevronUpOutlineRegular size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('find.next')} side="bottom">
        <button type="button" className={css.tool} aria-label={t('find.next')} disabled={matches === 0} onClick={() => { step(true) }}>
          <IconChevronDownOutlineRegular size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('find.close')} side="bottom">
        <button type="button" className={css.tool} aria-label={t('find.close')} onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
