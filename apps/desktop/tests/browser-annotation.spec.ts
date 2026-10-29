/** Human annotation captures retain page context and bounded element selections. */
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { captureBrowserAnnotation, pickBrowserElement } from '../src/browser-annotation.ts'

function captureGuest() {
  return {
    isDestroyed: () => false,
    getURL: vi.fn(() => 'https://example.test/page'),
    getTitle: () => 'Example page',
    executeJavaScriptInIsolatedWorld: async () => ({ width: 800, height: 600 }),
    capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png'), getSize: () => ({ width: 800, height: 600 }) }),
  }
}

it('captures the visible image with its page identity', async () => {
  await expect(captureBrowserAnnotation(captureGuest())).resolves.toEqual({
    png: Buffer.from('png').toString('base64'), width: 800, height: 600, viewportWidth: 800, viewportHeight: 600,
    url: 'https://example.test/page', title: 'Example page',
  })
})

it('rejects a screenshot whose page navigated before capture completed', async () => {
  const guest = captureGuest()
  guest.getURL.mockReturnValueOnce('https://example.test/old')
  await expect(captureBrowserAnnotation(guest)).rejects.toThrow('page changed')
})

it('rejects empty captures and closed tabs', async () => {
  const guest = captureGuest()
  guest.isDestroyed = () => true
  await expect(captureBrowserAnnotation(guest)).rejects.toThrow('closed')
  guest.isDestroyed = () => false
  guest.capturePage = async () => ({ isEmpty: () => true, toPNG: () => Buffer.from(''), getSize: () => ({ width: 0, height: 0 }) })
  await expect(captureBrowserAnnotation(guest)).rejects.toThrow('empty')
})

it('selects the actual element at the requested point without reading form values', async () => {
  const dom = new JSDOM('<body><section><button>First</button><button>Book a call</button><input value="private"></section></body>', { runScripts: 'outside-only' })
  try {
    let element: Element = dom.window.document.querySelectorAll('button')[1]!
    Object.defineProperty(dom.window.document, 'elementFromPoint', { value: () => element })
    const execute: WebContents['executeJavaScriptInIsolatedWorld'] = async (_world, scripts) => {
      const selection: unknown = new Script(scripts[0]!.code).runInContext(dom.getInternalVMContext())
      return selection
    }
    const guest = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: execute }
    expect(await pickBrowserElement(guest, { x: 20, y: 30 })).toMatchObject({
      selector: 'html > body > section > button:nth-of-type(2)', tagName: 'button', text: 'Book a call',
    })
    element = dom.window.document.querySelector('input')!
    expect(await pickBrowserElement(guest, { x: 20, y: 30 })).toMatchObject({ tagName: 'input', text: '' })
  } finally { dom.window.close() }
})

it('rejects invalid coordinates before running page code', async () => {
  const execute = vi.fn()
  await expect(pickBrowserElement({ isDestroyed: () => false, executeJavaScriptInIsolatedWorld: execute }, { x: -1, y: 1 })).rejects.toThrow('coordinates')
  expect(execute).not.toHaveBeenCalled()
})
