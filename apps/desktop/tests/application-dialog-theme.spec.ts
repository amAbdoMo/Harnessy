/** Color-only data crosses the renderer-to-Main presentation read, never approval authority. */
import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { readApplicationDialogTheme } from '../src/application-dialog-theme.ts'

const theme = { dark: true, surface: '#0d2731ff', text: '#f1fbfcff', muted: '#b7ccd1ff', border: '#a9e5e930',
  primary: '#37c4c9ff', primaryText: '#052831ff', secondary: '#133440ff' }

it('returns only normalized palette fields from the captured document', async () => {
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>().mockResolvedValue({ ...theme, approve: true, secret: 'unrelated' })
  expect(await readApplicationDialogTheme({ executeJavaScript })).toEqual(theme)
})

it.each([null, {}, { ...theme, dark: 'true' }, { ...theme, surface: 'url(https://example.test)' },
  { ...theme, text: undefined }, { ...theme, primary: '#37c4c9' }])('rejects invalid renderer palette %#', async (value) => {
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>().mockResolvedValue(value)
  await expect(readApplicationDialogTheme({ executeJavaScript })).rejects.toThrow(/theme|color/)
})

it('cancels a pending palette read without waiting for or publishing a late renderer result', async () => {
  const answer = Promise.withResolvers<unknown>()
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>().mockReturnValue(answer.promise)
  const controller = new AbortController()
  const pending = readApplicationDialogTheme({ executeJavaScript }, controller.signal)
  const settled = expect(pending).rejects.toThrow('retired')
  controller.abort(new Error('retired'))
  await settled
  answer.resolve(theme)
})

it('does not read a document after its management operation has retired', async () => {
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>()
  await expect(readApplicationDialogTheme({ executeJavaScript }, AbortSignal.abort(new Error('retired')))).rejects.toThrow('retired')
  expect(executeJavaScript).not.toHaveBeenCalled()
})
