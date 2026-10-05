/** Shutdown acceptance distinguishes process settlement from successful product Quit. */
import { describe, expect, it } from 'vitest'
import { assertCleanWebsiteExit } from './website-shutdown.fixture.ts'

describe('Website native shutdown acceptance', () => {
  it('accepts a completed zero-code Quit', () => {
    expect(() => { assertCleanWebsiteExit({ exitCode: 0, signalCode: null }) }).not.toThrow()
  })

  it.each([
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
    { exitCode: 0, signalCode: 'SIGKILL' as const },
    { exitCode: null, signalCode: null },
  ])('rejects abnormal or unsettled outcome $exitCode / $signalCode', (outcome) => {
    expect(() => { assertCleanWebsiteExit(outcome) }).toThrow('Owned Electron exited abnormally')
  })
})
