/** Address input with a portaled list of this tab's recent committed pages. */
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserTarget } from '../browser/url.ts'
import { filterBrowserAddresses } from '../browser/address-suggestions.ts'
import css from './BrowserAddressSuggestions.module.css'

/** Address suggestion input props supplied by the current Browser tab. */
export interface BrowserAddressSuggestionsProps {
  readonly value: string
  readonly recent: readonly BrowserTarget[]
  readonly label: string
  readonly suggestionsLabel: string
  readonly inputClassName: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
  readonly onCommit: (url: string) => void
}

/**
 * Keep focus on the address field while choosing a recent page.
 * @param props - current address and tab-local navigation.
 * @returns the address field and its suggestions.
 */
export function BrowserAddressSuggestions({ value, recent, label, suggestionsLabel, inputClassName, disabled,
  onChange, onCommit }: BrowserAddressSuggestionsProps): ReactNode {
  const listId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [active, setActive] = useState(-1)
  const suggestions = filterBrowserAddresses(recent, showAll ? '' : value)
  const visible = open && suggestions.length > 0 && !disabled
  const activeTarget = suggestions[active]
  const position = useAnchoredPosition({ open: visible, anchorRef: rootRef, panelRef: listRef, gap: 4, margin: 12 })
  useDismissOnOutsidePointer(rootRef, visible, setOpen, listRef)

  const commit = (url: string): void => {
    setOpen(false)
    setActive(-1)
    onCommit(url)
  }

  const moveActive = (direction: 1 | -1): void => {
    if (suggestions.length === 0) return
    setActive(current => current < 0
      ? direction === 1 ? 0 : suggestions.length - 1
      : (current + direction + suggestions.length) % suggestions.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape' && visible) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      setOpen(true)
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (visible && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : suggestions.length - 1)
      return
    }
    if (event.key === 'Enter' && visible && activeTarget !== undefined) {
      event.preventDefault()
      commit(activeTarget.url)
    }
  }

  return (
    <span className={css.root} ref={rootRef}>
      <input
        className={inputClassName}
        type="text"
        role={visible ? 'combobox' : undefined}
        value={value}
        aria-label={label}
        aria-autocomplete={visible ? 'list' : undefined}
        aria-haspopup={visible ? 'listbox' : undefined}
        aria-expanded={visible ? true : undefined}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible && activeTarget !== undefined ? `${listId}-option-${active}` : undefined}
        placeholder={label}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        onFocus={() => { setOpen(true); setShowAll(true); setActive(-1) }}
        onBlur={() => { setOpen(false); setActive(-1) }}
        onChange={(event) => { onChange(event.currentTarget.value); setShowAll(false); setOpen(true); setActive(-1) }}
        onKeyDown={onKeyDown}
      />
      {visible && createPortal(
        <MenuSurface compact className={css.list} role="listbox" id={listId} aria-label={suggestionsLabel}
          ref={listRef} style={position ?? undefined}>
          <div className={css.viewport} role="presentation">
            {suggestions.map((target, index) => (
              <div
                key={target.url}
                id={`${listId}-option-${index}`}
                className={[css.option, index === active ? css.optionActive : ''].filter(Boolean).join(' ')}
                role="option"
                aria-selected={index === active}
                onPointerMove={index === active ? undefined : () => { setActive(index) }}
                onPointerDown={(event) => { event.preventDefault() }}
                onMouseDown={(event) => { event.preventDefault() }}
                onClick={() => { commit(target.url) }}
              >
                <span className={css.optionLabel}>{target.url}</span>
              </div>
            ))}
          </div>
        </MenuSurface>,
        document.body,
      )}
    </span>
  )
}
