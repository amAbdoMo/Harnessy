// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ZoomControls, type ZoomControlsHandle } from '../src/client/zoom/ZoomControls.tsx'

afterEach(() => { cleanup() })

const labels = { controls: 'Document zoom', menu: 'Choose zoom', into: 'Zoom in', out: 'Zoom out',
  fitWidth: 'Fit width', value: (percent: number) => `${String(percent)}%` }

it('replaces a gesture percentage when committed zoom changes and does not restore it when that zoom returns', () => {
  const onZoom = vi.fn()
  const ref = createRef<ZoomControlsHandle>()
  const props = { visible: true, labels, onZoom, fitWidth: false, onFitWidth: vi.fn(), onActiveChange: vi.fn() }
  const view = render(<ZoomControls {...props} zoom={1} ref={ref} />)
  act(() => { ref.current!.showZoom(0.8) })
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('80%')
  view.rerender(<ZoomControls {...props} zoom={2} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('200%')
  view.rerender(<ZoomControls {...props} zoom={1} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(onZoom).toHaveBeenLastCalledWith(1.25)
  view.rerender(<ZoomControls {...props} zoom={4} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Zoom in' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<ZoomControls {...props} zoom={0.25} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true)
})

it('uses the current fit-width percentage while retaining the existing fit action and preset menu', () => {
  const ref = createRef<ZoomControlsHandle>()
  const onFitWidth = vi.fn()
  const props = { visible: true, labels, onZoom: vi.fn(), fitWidth: true, onFitWidth, onActiveChange: vi.fn() }
  const view = render(<ZoomControls {...props} zoom={0.6} ref={ref} />)
  act(() => { ref.current!.showZoom(1.5) })
  view.rerender(<ZoomControls {...props} zoom={0.7} ref={ref} />)
  expect(screen.getByRole('button', { name: 'Choose zoom' }).textContent).toContain('70%')
  fireEvent.click(screen.getByRole('button', { name: 'Choose zoom' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Fit width', '25%', '50%', '100%', '150%', '200%'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fit width' }))
  expect(onFitWidth).toHaveBeenCalledOnce()
})
