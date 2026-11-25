// @vitest-environment jsdom
/** Recent-address filtering and keyboard/pointer use in the Browser address bar. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { BrowserAddressSuggestions } from '../src/client/view/BrowserAddressSuggestions.tsx'
import { filterBrowserAddresses, MAX_RECENT_BROWSER_ADDRESSES, rememberBrowserAddress } from '../src/client/browser/address-suggestions.ts'
import type { BrowserTarget } from '../src/client/browser/url.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function address(index: number): BrowserTarget {
  return { kind: 'https', url: `https://site-${index}.example/path`, title: `Site ${index}` }
}

function mount(recent: readonly BrowserTarget[] = [address(1), address(2)]) {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  function AddressUnderTest() {
    const [value, setValue] = useState('')
    return <BrowserAddressSuggestions value={value} recent={recent} label="Enter an HTTP(S) address"
      suggestionsLabel="Recent pages" inputClassName="address" disabled={false}
      onChange={(next) => { setValue(next); onChange(next) }} onCommit={onCommit} />
  }
  const view = render(<AddressUnderTest />)
  return { ...view, onChange, onCommit }
}

describe('recent Browser addresses', () => {
  it('keeps the latest visit first, deduplicates by URL, and bounds the tab list', () => {
    const recent = Array.from({ length: MAX_RECENT_BROWSER_ADDRESSES }, (_, index) => address(index))
    const repeated = rememberBrowserAddress(recent, address(4))
    expect(repeated).toHaveLength(MAX_RECENT_BROWSER_ADDRESSES)
    expect(repeated[0]).toEqual(address(4))
    expect(repeated.filter(entry => entry.url === address(4).url)).toHaveLength(1)
    expect(rememberBrowserAddress(recent, address(20)).at(-1)).toEqual(address(MAX_RECENT_BROWSER_ADDRESSES - 2))
  })

  it('matches URL text without retaining or navigating the typed query', () => {
    const recent = [address(1), { ...address(2), url: 'https://other.example/path' }]
    expect(filterBrowserAddresses(recent, ' SITE-1 ')).toEqual([address(1)])
    expect(filterBrowserAddresses(recent, '')).toEqual(recent)
    const mounted = mount(recent)
    const input = mounted.getByLabelText('Enter an HTTP(S) address')
    expect(mounted.getByRole('textbox')).toBe(input)
    fireEvent.focus(input)
    expect(mounted.getByRole('combobox')).toBe(input)
    expect(mounted.getAllByRole('option')).toHaveLength(2)
    fireEvent.change(input, { target: { value: 'other.example' } })
    expect(mounted.getAllByRole('option')).toHaveLength(1)
    expect(mounted.getByRole('option').textContent).toBe('https://other.example/path')
    expect(mounted.onChange).toHaveBeenCalledExactlyOnceWith('other.example')
    expect(mounted.onCommit).not.toHaveBeenCalled()
  })

  it('selects filtered suggestions with arrow keys and Enter', () => {
    const mounted = mount([address(1), address(2), address(3)])
    const input = mounted.getByLabelText('Enter an HTTP(S) address')
    fireEvent.focus(input)
    expect(mounted.getByRole('combobox')).toBe(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toContain('option-0')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toContain('option-1')
    fireEvent.keyDown(input, { key: 'End' })
    expect(input.getAttribute('aria-activedescendant')).toContain('option-2')
    fireEvent.keyDown(input, { key: 'Home' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mounted.onCommit).toHaveBeenCalledExactlyOnceWith(address(1).url)
    expect(mounted.queryByRole('listbox')).toBeNull()
  })

  it('wraps upward keyboard navigation and closes on Escape or Tab', () => {
    const mounted = mount([address(1), address(2)])
    const input = mounted.getByLabelText('Enter an HTTP(S) address')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toContain('option-1')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toContain('option-0')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(mounted.queryByRole('listbox')).toBeNull()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(mounted.queryByRole('listbox')).toBeNull()
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(mounted.queryByRole('listbox')).toBeNull()
    fireEvent.focus(input)
    fireEvent.pointerDown(document.body)
    expect(mounted.queryByRole('listbox')).toBeNull()
    expect(mounted.onCommit).not.toHaveBeenCalled()
  })

  it('commits a pointer selection without moving focus away from the input', () => {
    const mounted = mount()
    const input = mounted.getByLabelText('Enter an HTTP(S) address')
    act(() => { input.focus() })
    const option = mounted.getAllByRole('option')[1]!
    fireEvent.pointerDown(option)
    expect(document.activeElement).toBe(input)
    fireEvent.pointerMove(option)
    fireEvent.click(option)
    expect(mounted.onCommit).toHaveBeenCalledExactlyOnceWith(address(2).url)
    expect(mounted.queryByRole('listbox')).toBeNull()
  })

  it('keeps an empty or disabled address input free of suggestions', () => {
    const empty = mount([])
    fireEvent.focus(empty.getByLabelText('Enter an HTTP(S) address'))
    expect(empty.queryByRole('listbox')).toBeNull()

    const onCommit = vi.fn()
    const disabled = render(<BrowserAddressSuggestions value="" recent={[address(1)]} label="Address"
      suggestionsLabel="Recent pages" inputClassName="address" disabled onChange={vi.fn()} onCommit={onCommit} />)
    fireEvent.focus(disabled.getByLabelText('Address'))
    expect(disabled.queryByRole('listbox')).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
