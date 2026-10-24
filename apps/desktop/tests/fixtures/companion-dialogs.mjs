/** Real isolated companion presentation with synthetic Host status and app theme inputs. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { DesktopCompanion } from '../../lib/types/companion-native.js'
import { readApplicationDialogTheme } from '../../lib/types/application-dialog-theme.js'

async function rendered(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Companion dialog did not render')); }, 10000);
    function check() { if (document.querySelector('main:not([hidden])')) { observer.disconnect(); clearTimeout(timer); resolve(); } }
    observer.observe(document, { subtree: true, attributes: true }); check();
  })`)
}

/** Qualify production copy, color capture, overlay, focus and cancellation without authorizing a real device. */
export async function qualifyCompanionDialogs(parent, dialogs, root) {
  const expected = JSON.parse(await readFile(new URL('../expected/companion-dialog.json', import.meta.url), 'utf8'))
  const screenshots = []
  for (const sample of expected.states) {
    parent.setContentSize(sample.viewportWidth, 650)
    const css = Object.entries(expected.themes[sample.theme]).map(([token, value]) => `${token}:${value}`).join(';')
    await parent.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body ${sample.theme === 'dark' ? 'data-ds-dark-theme' : ''} style="${css}"></body>`)}`)
    parent.show()
    const commands = []
    const host = { companionControl: async (command) => {
      commands.push(command)
      assert.equal(command.kind, 'describe', 'Visual qualification must not mutate phone access')
      return { kind: 'status', status: { available: true, connected: false, paired: [], candidates: [] } }
    } }
    const companion = new DesktopCompanion(() => ({ host, window: parent }), () => 'en', {
      show: async (owner, options) => dialogs.show(owner.window, {
        ...options, applicationTheme: await readApplicationDialogTheme(owner.window.webContents, options.signal),
      }),
      copy: () => { throw new Error('Visual qualification must not copy an invitation') },
    })
    try {
      const created = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
      const pending = companion.open()
      const [, contents] = await created
      const window = { webContents: contents }
      await once(window.webContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
      await rendered(window)
      const view = await window.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('main'); const box = main.getBoundingClientRect();
        return { title: document.getElementById('title').textContent, detail: document.getElementById('detail').textContent,
          buttons: [...document.querySelectorAll('#actions button')].map(button => button.textContent),
          surface: getComputedStyle(main).backgroundColor, primary: getComputedStyle(document.querySelector('.primary')).backgroundColor,
          width: box.width, radius: getComputedStyle(main).borderRadius,
          fits: box.x >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && main.scrollWidth === main.clientWidth,
          isolated: typeof window.require === 'undefined', focused: document.activeElement.id };
      })()`)
      assert.deepEqual(view, { ...expected.content, surface: sample.surface, primary: sample.primary, width: sample.width,
        radius: '28px', fits: true, isolated: true, focused: 'dialog' })
      assert.equal(await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })); document.activeElement.id`), 'close')
      assert.equal(await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })); document.activeElement.textContent`), expected.content.buttons.at(-1))
      await window.webContents.executeJavaScript(`document.getElementById('dialog').focus(); Promise.all(document.getAnimations().map(animation => animation.finished))`)
      const bounds = await window.webContents.executeJavaScript(`(() => { const box = document.querySelector('main').getBoundingClientRect(); return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) }; })()`)
      const name = `companion-${sample.theme}${sample.viewportWidth < 500 ? '-narrow' : ''}.png`
      await writeFile(join(root, name), (await window.webContents.capturePage(bounds)).toPNG())
      screenshots.push(name)
      const closed = once(window.webContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
      await window.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))`)
      await pending
      await closed
      assert.deepEqual(commands, [{ kind: 'describe' }])
    } finally {
      await companion.close()
    }
  }
  return screenshots
}
