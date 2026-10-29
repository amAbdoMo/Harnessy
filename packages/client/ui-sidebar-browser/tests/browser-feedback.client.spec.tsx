// @vitest-environment jsdom
/** Browser feedback and tab-control behavior at the human interaction seam. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BrowserFeedback } from '../src/client/view/BrowserFeedback.tsx'
import { BrowserControl } from '../src/client/view/BrowserControl.tsx'
import { en } from '../src/client/locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '../../locale/src/locales/en.ts'
import type { BrowserAnnotationCapture } from '../src/types.ts'
import { annotationRect, annotationHit } from '../src/client/view/browser-annotations.ts'
import * as annotations from '../src/client/view/browser-annotations.ts'

const shot: BrowserAnnotationCapture = { png: 'cG5n', width: 800, height: 600, viewportWidth: 400, viewportHeight: 300,
  title: 'Preview page', url: 'https://example.test/page' }
const messages: Readonly<Record<string, string>> = { ...commonEn, ...en }
const t: TranslateNS<'sidebarBrowser'> = key => messages[key] ?? key
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture() {
  const capture = vi.fn(async () => shot)
  const pick = vi.fn(async () => ({ selector: '#hero', tagName: 'SECTION', text: 'Hero content', rect: { x: 10, y: 20, width: 60, height: 80 } }))
  const addFeedback = vi.fn<(file: File, text: string) => boolean>(() => true)
  const view = render(<BrowserFeedback capture={capture} pick={pick} addFeedback={addFeedback} t={t} />)
  return { ...view, capture, pick, addFeedback }
}

describe('Browser feedback', () => {
  it('captures the page, maps an element pick at HiDPI, and stages context with its annotated PNG', async () => {
    const file = new File(['image'], 'browser-feedback.png', { type: 'image/png' })
    const raster = vi.spyOn(annotations, 'annotatedBrowserFile').mockResolvedValue(file)
    const view = fixture()
    fireEvent.click(view.getByRole('button', { name: en['annotation.select'] }))
    await waitFor(() => { expect(view.getByRole('dialog')).toBeDefined() })
    const canvas = view.getByLabelText(en['annotation.canvas'])
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
    fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 100 })
    await waitFor(() => { expect(view.pick).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 50 }) })
    await waitFor(() => { expect(canvas.querySelector('rect')?.getAttribute('width')).toBe('120') })
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Change this heading' } })
    fireEvent.click(view.getByRole('button', { name: en['annotation.add'] }))
    await waitFor(() => { expect(view.addFeedback).toHaveBeenCalledOnce() })
    expect(view.addFeedback.mock.calls[0]).toEqual([file, expect.stringContaining('https://example.test/page')])
    expect(view.addFeedback.mock.calls[0]?.[1]).toContain('#hero')
    expect(view.addFeedback.mock.calls[0]?.[1]).toContain('Change this heading')
    expect(raster.mock.calls[0]?.[1]).toEqual([expect.objectContaining({ kind: 'element', selector: '#hero' })])
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('retains feedback when the composer refuses it', async () => {
    vi.spyOn(annotations, 'annotatedBrowserFile').mockResolvedValue(new File(['image'], 'feedback.png', { type: 'image/png' }))
    const view = fixture()
    view.addFeedback.mockReturnValue(false)
    fireEvent.click(view.getByRole('button', { name: en['annotation.draw'] }))
    await waitFor(() => { expect(view.getByRole('dialog')).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: en['annotation.add'] }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe(en['annotation.failed']) })
    expect(view.getByRole('dialog')).toBeDefined()
  })

  it('shows capture failure without opening a blank editor', async () => {
    const view = fixture()
    view.capture.mockRejectedValue(new Error('closed guest'))
    fireEvent.click(view.getByRole('button', { name: en['annotation.region'] }))
    await waitFor(() => { expect(view.getByRole('alert')).toBeDefined() })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.addFeedback).not.toHaveBeenCalled()
  })

  it('normalizes reverse drags and erases only the selected annotation', () => {
    const rect = annotationRect({ x: 90, y: 80 }, { x: 20, y: 30 })
    expect(rect).toEqual({ x: 20, y: 30, width: 70, height: 50 })
    expect(annotationHit({ kind: 'region', rect }, { x: 40, y: 40 })).toBe(true)
    expect(annotationHit({ kind: 'region', rect }, { x: 200, y: 40 })).toBe(false)
    expect(annotationHit({ kind: 'stroke', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }, { x: 200, y: 40 })).toBe(false)
  })
})

describe('Compact browser control', () => {
  it('takes control and resumes the agent through the same tab callback', async () => {
    const control = vi.fn(async () => {})
    const view = render(<BrowserControl humanControl={false} control={control} t={t} />)
    fireEvent.click(view.getByRole('button', { name: en['control.takeover'] }))
    await waitFor(() => { expect(control).toHaveBeenCalledExactlyOnceWith(true) })
    view.rerender(<BrowserControl humanControl control={control} t={t} />)
    await waitFor(() => { expect(view.getByRole('button')).toHaveProperty('disabled', false) })
    fireEvent.click(view.getByRole('button', { name: en['control.resume'] }))
    await waitFor(() => { expect(control).toHaveBeenLastCalledWith(false) })
  })

  it('makes a rejected handoff retryable without claiming control changed', async () => {
    const control = vi.fn().mockRejectedValue(new Error('stale tab'))
    const view = render(<BrowserControl humanControl={false} control={control} t={t} />)
    fireEvent.click(view.getByRole('button', { name: en['control.takeover'] }))
    await waitFor(() => { expect(view.getByText(en['control.failed'])).toBeDefined() })
    expect(view.getByRole('button')).toHaveProperty('disabled', false)
    expect(control).toHaveBeenCalledExactlyOnceWith(true)
  })
})
