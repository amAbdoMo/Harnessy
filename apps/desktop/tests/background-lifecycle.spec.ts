import { describe, expect, it } from 'vitest'
import { DesktopBackgroundLifecycle, desktopTrayImagePath } from '../src/background-lifecycle.ts'

describe('desktop background lifecycle', () => {
  it('hides the primary Windows window only after the tray can reopen it', () => {
    const lifecycle = new DesktopBackgroundLifecycle('win32')

    expect(lifecycle.shouldHidePrimaryWindow()).toBe(false)
    expect(lifecycle.shouldKeepRunningWithoutWindows()).toBe(false)

    lifecycle.markTrayReady()

    expect(lifecycle.shouldHidePrimaryWindow()).toBe(true)
    expect(lifecycle.shouldKeepRunningWithoutWindows()).toBe(true)
  })

  it('allows every window to close after an explicit quit request', () => {
    const lifecycle = new DesktopBackgroundLifecycle('win32')
    lifecycle.markTrayReady()
    lifecycle.requestQuit()

    expect(lifecycle.shouldHidePrimaryWindow()).toBe(false)
    expect(lifecycle.shouldKeepRunningWithoutWindows()).toBe(false)
  })

  it('does not enable tray-backed background mode on another platform', () => {
    const lifecycle = new DesktopBackgroundLifecycle('darwin')
    lifecycle.markTrayReady()

    expect(lifecycle.shouldHidePrimaryWindow()).toBe(false)
    expect(lifecycle.shouldKeepRunningWithoutWindows()).toBe(false)
  })

  it('resolves source and packaged tray assets', () => {
    expect(desktopTrayImagePath(false, 'C:\\source\\app', 'C:\\installed\\resources'))
      .toBe('C:\\source\\app\\assets\\harnessy.png')
    expect(desktopTrayImagePath(true, 'C:\\source\\app', 'C:\\installed\\resources'))
      .toBe('C:\\installed\\resources\\harnessy.png')
  })
})
