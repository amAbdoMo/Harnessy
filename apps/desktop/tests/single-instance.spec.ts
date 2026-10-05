import { describe, expect, it, vi } from 'vitest'
import { claimDesktopSingleInstance, type DesktopSingleInstanceApplication } from '../src/single-instance.ts'

describe('desktop single-instance ownership', () => {
  it('quits a second process without registering lifecycle work', () => {
    const quit = vi.fn()
    const on = vi.fn()
    const application = {
      requestSingleInstanceLock: () => false,
      quit,
      on,
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, vi.fn())).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(on).not.toHaveBeenCalled()
  })

  it('reports a lost claim before quitting', () => {
    const order: string[] = []
    const application = {
      requestSingleInstanceLock: () => false,
      quit: vi.fn(() => { order.push('quit') }),
      on: vi.fn(),
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, vi.fn(), () => { order.push('report') })).toBe(false)
    expect(order).toEqual(['report', 'quit'])
    expect(application.on).not.toHaveBeenCalled()
  })

  it('forwards later OS argv without interpreting URI or other launch arguments', () => {
    let secondInstance: ((event?: unknown, argv?: readonly string[]) => void) | undefined
    const launches: (readonly string[] | undefined)[] = []
    const application = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: (event?: unknown, argv?: readonly string[]) => void) => { secondInstance = listener }),
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, (argv) => { launches.push(argv) })).toBe(true)
    const argv = ['Harnessy.exe', 'harnessy://session/opaque%2Fid', '--updated']
    secondInstance?.({}, argv)
    secondInstance?.({}, ['Harnessy.exe'])
    expect(launches).toEqual([argv, ['Harnessy.exe']])
    expect(application.quit).not.toHaveBeenCalled()
  })

  it('routes a later launch to the primary process', () => {
    let secondInstance: (() => void) | undefined
    const focus = vi.fn()
    const application = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: () => void) => { secondInstance = listener }),
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, focus)).toBe(true)
    secondInstance?.()
    expect(focus).toHaveBeenCalledOnce()
  })
})
