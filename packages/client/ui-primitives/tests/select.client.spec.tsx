// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SelectEntry } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const OPTIONS: SelectEntry[] = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta', disabled: true },
  { value: 'gamma', label: 'Gamma' },
]

/** Render a select and return its trigger. */
function renderSelect(overrides: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <Select
      value="alpha"
      options={OPTIONS}
      onChange={onChange}
      label="Backend"
      ariaDescribedBy="backend-hint"
      {...overrides}
    />,
  )
  return { trigger: screen.getByRole('combobox', { name: 'Backend' }), onChange }
}

describe('Select trigger', () => {
  it('shows the stored option and carries the labelling the row supplies', () => {
    renderSelect({ id: 'backend' })
    const trigger = screen.getByRole('combobox', { name: 'Backend' })
    expect(trigger.textContent).toBe('Alpha')
    expect(trigger.id).toBe('backend')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-describedby')).toBe('backend-hint')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('shows no value when nothing matches it', () => {
    renderSelect({ value: 'missing' })
    expect(screen.getByRole('combobox').textContent).toBe('')
  })

  it('renders the extra class on the control root', () => {
    renderSelect({ className: 'narrow' })
    expect(screen.getByRole('combobox').parentElement?.classList.contains('narrow')).toBe(true)
  })

  it('does not open while disabled', () => {
    renderSelect({ disabled: true })
    const trigger = screen.getByRole('combobox')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Select popup', () => {
  it('opens on the trigger and marks the stored option', () => {
    const { trigger } = renderSelect()
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox', { name: 'Backend' })
    const options = within(listbox).getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(within(listbox).getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true')
    expect(within(listbox).getByRole('option', { name: 'Beta' }).getAttribute('aria-disabled')).toBe('true')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      within(listbox).getByRole('option', { name: 'Alpha' }).id,
    )
  })

  it('stores a picked option and closes; picking the current value only closes', () => {
    const { trigger, onChange } = renderSelect()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledWith('gamma')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Alpha' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ignores a disabled option', () => {
    const { trigger, onChange } = renderSelect()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('closes on an outside pointerdown and stays open on one inside', () => {
    const { trigger } = renderSelect()
    fireEvent.click(trigger)
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Beta' }))
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('groups rows under their own headings', () => {
    const grouped: SelectEntry[] = [
      { value: 'plain', label: 'Plain' },
      { label: 'Providers', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] },
    ]
    const { trigger, onChange } = renderSelect({ value: 'plain', options: grouped })
    fireEvent.click(trigger)
    const group = screen.getByRole('group', { name: 'Providers' })
    expect(within(group).getAllByRole('option').map(option => option.textContent)).toEqual(['One', 'Two'])
    fireEvent.click(within(group).getByRole('option', { name: 'Two' }))
    expect(onChange).toHaveBeenCalledWith('two')
  })

  it('opens with no rows when the option list is empty', () => {
    const { trigger, onChange } = renderSelect({ value: 'none', options: [] })
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeDefined()
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(trigger.getAttribute('aria-activedescendant')).toBeNull()
    // With nothing to move onto or commit, the keys leave the state alone.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'End' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-activedescendant')).toBeNull()
  })

  it('closes when the open trigger is clicked again', () => {
    const { trigger } = renderSelect()
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Select keyboard', () => {
  it('opens on the stored row and moves over enabled rows only', () => {
    const { trigger } = renderSelect()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeDefined()
    const active = () => document.getElementById(trigger.getAttribute('aria-activedescendant') ?? '')?.textContent
    expect(active()).toBe('Alpha')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(active()).toBe('Gamma')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(active()).toBe('Alpha')
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(active()).toBe('Gamma')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(active()).toBe('Alpha')
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(active()).toBe('Gamma')
  })

  it('opens on ArrowUp and on Enter or Space, and commits the active row', () => {
    const { trigger, onChange } = renderSelect()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('gamma')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Escape and Tab, and leaves other keys alone', () => {
    const { trigger } = renderSelect()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'a' })
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.keyDown(trigger, { key: 'Tab' })
  })

  it('opens without an active row when every option is disabled', () => {
    const allDisabled: SelectEntry[] = [{ value: 'only', label: 'Only', disabled: true }]
    const { trigger, onChange } = renderSelect({ value: 'only', options: allDisabled })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeDefined()
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Only' }).id,
    )
    // Walking and Home/End have no enabled row to land on, so they stay put.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Only' }).id,
    )
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Select reveal', () => {
  it('scrolls the active row into view when the engine implements it', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { trigger } = renderSelect()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
  })
})
