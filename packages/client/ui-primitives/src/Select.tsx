// Select: the app's own single-choice control. A native <select> paints the
// platform's popup, ignores the theme's tokens, and cannot carry grouped rows
// or the app's focus ring, so settings surfaces render this instead.
// Cordis-free and copy-free: the caller supplies the visible label (through a
// <label for> or `label`) and every option's text.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons/index.tsx'
import { useAnchoredPosition } from './useAnchoredPosition.ts'
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
import css from './Select.module.css'

/** One selectable row: the stored value and the copy shown for it. */
export interface SelectOption<Value extends string = string> {
  /** Value the row stores when picked. */
  readonly value: Value
  /** Visible copy, and the row's accessible name. */
  readonly label: string
  /** Renders the row dimmed and unselectable; the value may still be the current one. */
  readonly disabled?: boolean | undefined
}

/** One titled run of options, announced as a group. */
export interface SelectGroup<Value extends string = string> {
  /** Visible group heading, which also names the group. */
  readonly label: string
  /** The rows this group holds, in render order. */
  readonly options: readonly SelectOption<Value>[]
}

/** One entry of the listbox: a plain option or a titled group. */
export type SelectEntry<Value extends string = string> = SelectOption<Value> | SelectGroup<Value>

/** One popup row: its option, its element id, and its index in the flat row list. */
interface SelectRow<Value extends string> {
  readonly option: SelectOption<Value>
  readonly id: string
  readonly index: number
}

/** One entry as the popup renders it, with its rows already flattened. */
type SelectRenderEntry<Value extends string> =
  | { readonly kind: 'option'; readonly row: SelectRow<Value> }
  | { readonly kind: 'group'; readonly label: string; readonly id: string; readonly rows: readonly SelectRow<Value>[] }

/** Props the select renders from. */
export interface SelectProps<Value extends string = string> {
  /** Value of the option the trigger shows. */
  readonly value: Value
  /** Every row the popup offers, in render order. */
  readonly options: readonly SelectEntry<Value>[]
  /** Receives the value the user picked. */
  readonly onChange: (next: Value) => void
  /** Element id a visible `<label for>` points at; the trigger carries it. */
  readonly id?: string | undefined
  /** Accessible name when no visible label is associated with the trigger. */
  readonly label?: string | undefined
  /** Id(s) of the copy describing the control, wired through `aria-describedby`. */
  readonly ariaDescribedBy?: string | undefined
  /** Whether the control accepts interaction. */
  readonly disabled?: boolean | undefined
  /** Extra class on the control root, for width constraints the row owns. */
  readonly className?: string | undefined
}

/** Whether one entry is a titled group rather than a plain option. */
function isGroup<Value extends string>(entry: SelectEntry<Value>): entry is SelectGroup<Value> {
  return 'options' in entry
}

/**
 * Render the app's single-choice control.
 * @param props - the selected value, the rows to offer, the write path, and the labelling the row supplies.
 * @returns the trigger and, while open, its portaled listbox.
 */
export function Select<Value extends string = string>(props: SelectProps<Value>): ReactNode {
  const { value, options, onChange, id, label, ariaDescribedBy, disabled = false, className } = props
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Keyboard navigation walks the flattened rows, so groups stay a rendering
  // detail of one flat model and `aria-activedescendant` names a single row.
  const entries = useMemo<SelectRenderEntry<Value>[]>(() => {
    const rendered: SelectRenderEntry<Value>[] = []
    let index = 0
    options.forEach((entry, entryIndex) => {
      if (!isGroup(entry)) {
        rendered.push({ kind: 'option', row: { option: entry, id: `${listId}-${String(entryIndex)}`, index } })
        index += 1
        return
      }
      const rows: SelectRow<Value>[] = entry.options.map((option, optionIndex) => ({
        option,
        id: `${listId}-${String(entryIndex)}-${String(optionIndex)}`,
        index: index + optionIndex,
      }))
      rendered.push({ kind: 'group', label: entry.label, id: `${listId}-group-${String(entryIndex)}`, rows })
      index += rows.length
    })
    return rendered
  }, [options, listId])
  const rows = useMemo(
    () => entries.flatMap(entry => entry.kind === 'option' ? [entry.row] : entry.rows),
    [entries],
  )
  const selected = rows.findIndex(row => row.option.value === value)
  const selectedRow = rows[selected]
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef: listRef, gap: 4, margin: 12 })
  useDismissOnOutsidePointer(rootRef, open, setOpen, listRef)

  const activeRow = rows[active]
  useEffect(() => {
    // Keep the row the keys are on visible without moving focus into the popup:
    // the trigger keeps focus and names its row through aria-activedescendant.
    if (!open) return
    const row = activeRow
    if (row === undefined) return
    const element = document.getElementById(row.id)
    /* v8 ignore next -- the id names a row of the committed popup, and the
       engine check is jsdom's missing scrolling surface, not a state. */
    if (element === null || typeof element.scrollIntoView !== 'function') return
    element.scrollIntoView({ block: 'nearest' })
  }, [open, activeRow])

  /** The next enabled row walking `delta` from `from`, wrapping once around. */
  const stepEnabled = (from: number, delta: number): number => {
    if (rows.length === 0) return from
    for (let offset = 1; offset <= rows.length; offset += 1) {
      const index = (from + delta * offset + rows.length * rows.length) % rows.length
      if (rows[index]?.option.disabled !== true) return index
    }
    return from
  }
  /** The first enabled row, or row 0 when every row is disabled. */
  const firstEnabled = (): number => {
    const index = rows.findIndex(row => row.option.disabled !== true)
    return index === -1 ? 0 : index
  }
  /** The last enabled row, or row 0 when every row is disabled. */
  const lastEnabled = (): number => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index]?.option.disabled !== true) return index
    }
    return 0
  }
  /** Open the popup on the stored value, or the first enabled row when nothing matches it. */
  const openAtSelected = (): void => {
    setActive(selected === -1 ? firstEnabled() : selected)
    setOpen(true)
  }
  /** Store one row's value and close; a disabled row or the current value leaves the document untouched. */
  const commit = (row: SelectRow<Value>): void => {
    if (row.option.disabled === true) return
    setOpen(false)
    if (row.option.value !== value) onChange(row.option.value)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!open) {
        openAtSelected()
        return
      }
      if (event.key === 'Home') setActive(firstEnabled())
      else if (event.key === 'End') setActive(lastEnabled())
      else setActive(current => stepEnabled(current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        openAtSelected()
        return
      }
      if (activeRow !== undefined) commit(activeRow)
    }
  }

  /** Render one row with the state its value and its option carry. */
  const renderRow = (row: SelectRow<Value>): ReactNode => (
    <div
      key={row.id}
      id={row.id}
      className={clsx(
        css.option,
        row.index === active && css.optionActive,
        row.option.disabled === true && css.optionDisabled,
      )}
      role="option"
      aria-selected={row.option.value === value}
      aria-disabled={row.option.disabled === true ? true : undefined}
      onClick={() => { commit(row) }}
    >
      <span className={css.optionLabel}>{row.option.label}</span>
      {row.option.value === value ? <IconCheckOutline16 className={css.check} /> : null}
    </div>
  )

  return (
    <span className={clsx(css.root, className)} ref={rootRef}>
      <button
        type="button"
        id={id}
        className={css.trigger}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeRow !== undefined ? activeRow.id : undefined}
        aria-label={label}
        aria-describedby={ariaDescribedBy}
        disabled={disabled}
        onClick={() => { if (open) setOpen(false); else openAtSelected() }}
        onKeyDown={onKeyDown}
      >
        <span className={css.value}>{selectedRow === undefined ? '' : selectedRow.option.label}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </button>
      {open
        ? createPortal(
          <div className={css.list} role="listbox" id={listId} aria-label={label} ref={listRef} style={position ?? undefined}>
            {entries.map(entry => entry.kind === 'group'
              ? (
                <div key={entry.label} className={css.group} role="group" aria-labelledby={entry.id}>
                  <div className={css.groupLabel} id={entry.id}>{entry.label}</div>
                  {entry.rows.map(renderRow)}
                </div>
              )
              : renderRow(entry.row))}
          </div>,
          document.body,
        )
        : null}
    </span>
  )
}
