/**
 * Shared labelled controls for the Subagents settings page.
 *
 * Every control is a native input, select, textarea, or button, so it is
 * keyboard-reachable and carries its own accessible name. {@link Field} owns the
 * label/description pairing: the hint is wired through `aria-describedby` and
 * never folded into the label, so the accessible name stays exactly the visible
 * one. Each control renders only the control element; the row it sits in owns
 * the label.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-subagents/fields
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import css from './SubagentsSection.module.css'

/**
 * Local draft that adopts external changes without fighting its own writes.
 *
 * A settings write reaches the mirrored snapshot one round-trip after the
 * keystroke, and an earlier keystroke's response can land after a later one. A
 * control bound straight to the snapshot is therefore reset mid-typing; this
 * keeps the user's text and applies only a value this control did not write.
 * @param value - the committed value from the snapshot.
 * @param commit - persists one draft value.
 * @returns the value the control renders and the setter that writes it.
 */
export function useDraft<T>(value: T, commit: (next: T) => void): { value: T; set: (next: T) => void } {
  const [draft, setDraft] = useState(value)
  const adopted = useRef(value)
  const written = useRef<T | undefined>(undefined)
  if (!Object.is(adopted.current, value)) {
    adopted.current = value
    // A stored value this control wrote is already what the user sees; only a
    // change from somewhere else replaces the draft.
    if (!Object.is(written.current, value)) setDraft(value)
  }
  return {
    value: draft,
    set: (next: T) => {
      written.current = next
      setDraft(next)
      commit(next)
    },
  }
}

/**
 * Read the description id one row's hint paragraph owns.
 * @param id - the control's element id.
 * @returns the id a control passes as `aria-describedby`.
 */
export function hintIdOf(id: string): string {
  return `${id}-hint`
}

/**
 * One labelled editor row: its own visible label, its control, and a described hint.
 * @param id - the control's element id, which the label points at.
 * @param label - the visible field name, and therefore the control's accessible name.
 * @param hint - the description wired through `aria-describedby`.
 * @param children - the control element.
 * @returns the labelled row.
 */
export function Field({ id, label, hint, children }: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={id}>{label}</label>
      {children}
      <p className={css.hint} id={hintIdOf(id)}>{hint}</p>
    </div>
  )
}

/** Single-line text control whose draft survives the settings round-trip. */
export function DraftInput({ id, value, disabled, onChange }: {
  readonly id: string
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (next: string) => void
}): ReactNode {
  const draft = useDraft(value, onChange)
  return (
    <input
      id={id}
      className={css.input}
      value={draft.value}
      disabled={disabled}
      aria-describedby={hintIdOf(id)}
      onChange={(event) => { draft.set(event.target.value) }}
    />
  )
}

/** Multi-line text control whose draft survives the settings round-trip. */
export function DraftTextarea({ id, value, disabled, rows, onChange }: {
  readonly id: string
  readonly value: string
  readonly disabled: boolean
  readonly rows: number
  readonly onChange: (next: string) => void
}): ReactNode {
  const draft = useDraft(value, onChange)
  return (
    <textarea
      id={id}
      className={css.textarea}
      rows={rows}
      value={draft.value}
      disabled={disabled}
      aria-describedby={hintIdOf(id)}
      onChange={(event) => { draft.set(event.target.value) }}
    />
  )
}

/** Numeric control holding its draft as text, so an emptied field clears the bound. */
export function DraftNumber({ id, value, disabled, min, onChange }: {
  readonly id: string
  readonly value: number | undefined
  readonly disabled: boolean
  readonly min: number
  readonly onChange: (next: number | undefined) => void
}): ReactNode {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const adopted = useRef(value)
  const written = useRef<number | undefined>(undefined)
  if (!Object.is(adopted.current, value)) {
    adopted.current = value
    if (!Object.is(written.current, value)) setText(value === undefined ? '' : String(value))
  }
  return (
    <input
      id={id}
      className={css.input}
      type="number"
      min={min}
      value={text}
      disabled={disabled}
      aria-describedby={hintIdOf(id)}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        // An emptied control clears the bound; anything else must parse before
        // it is written, so a half-typed number never reaches the document.
        if (next.trim().length === 0) {
          written.current = undefined
          onChange(undefined)
          return
        }
        const parsed = Number.parseFloat(next)
        if (Number.isFinite(parsed)) {
          written.current = parsed
          onChange(parsed)
        }
      }}
    />
  )
}

/** Select over a fixed option list. */
export function DraftSelect<T extends string>({ id, value, disabled, options, onChange }: {
  readonly id: string
  readonly value: T
  readonly disabled: boolean
  readonly options: readonly { readonly value: T; readonly label: string }[]
  readonly onChange: (next: T) => void
}): ReactNode {
  return (
    <select
      id={id}
      className={css.select}
      value={value}
      disabled={disabled}
      aria-describedby={hintIdOf(id)}
      onChange={(event) => { onChange(event.target.value as T) }}
    >
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

/** Two-state switch, rendered as a checkbox carrying the switch role. */
export function DraftSwitch({ id, checked, disabled, onChange }: {
  readonly id: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}): ReactNode {
  return (
    <input
      id={id}
      className={css.switch}
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      aria-describedby={hintIdOf(id)}
      onChange={(event) => { onChange(event.target.checked) }}
    />
  )
}

/** A row whose label and switch sit on one line. */
export function SwitchField({ id, label, hint, checked, disabled, onChange }: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}): ReactNode {
  return (
    <div className={css.switchField}>
      <DraftSwitch id={id} checked={checked} disabled={disabled} onChange={onChange} />
      <label className={css.label} htmlFor={id}>{label}</label>
      <p className={css.hint} id={hintIdOf(id)}>{hint}</p>
    </div>
  )
}
