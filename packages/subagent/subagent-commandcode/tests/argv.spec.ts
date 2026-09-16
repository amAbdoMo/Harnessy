import { describe, expect, it } from 'vitest'
import { assertProcessToken, commandCodeArgv } from '../src/argv.ts'
import type { CommandCodeRunSpec } from '../src/types.ts'

function spec(overrides: Partial<CommandCodeRunSpec> = {}): CommandCodeRunSpec {
  return {
    laneName: 'Review',
    model: 'deepseek/deepseek-v4.1-flash',
    effort: 'default',
    access: 'read-only',
    maxTurns: 60,
    timeoutMs: 3_600_000,
    ...overrides,
  }
}

describe('commandCodeArgv', () => {
  it('builds the documented headless invocation for a read-only default-effort lane', () => {
    expect(commandCodeArgv(spec())).toEqual([
      '-p',
      '--output-format', 'json',
      '--no-session',
      '--skip-onboarding',
      '--no-auto-update',
      '--max-turns', '60',
      '--model', 'deepseek/deepseek-v4.1-flash',
      '--permission-mode', 'plan',
    ])
  })

  it('adds --yolo only for a full-access lane', () => {
    const argv = commandCodeArgv(spec({ access: 'full-access' }))
    expect(argv).toContain('--yolo')
    expect(argv).not.toContain('--permission-mode')
  })

  it('passes the effort flag only when the lane chose one', () => {
    expect(commandCodeArgv(spec({ effort: 'default' }))).not.toContain('--effort')
    const argv = commandCodeArgv(spec({ effort: 'high' }))
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
  })

  it('never carries the task text', () => {
    expect(commandCodeArgv(spec()).join(' ')).not.toContain('task')
  })

  it('always disables persistence', () => {
    expect(commandCodeArgv(spec())).toContain('--no-session')
  })

  it('rejects a turn bound that is not a positive whole number', () => {
    expect(() => commandCodeArgv(spec({ maxTurns: 0 }))).toThrow(/positive whole number/u)
    expect(() => commandCodeArgv(spec({ maxTurns: 1.5 }))).toThrow(/positive whole number/u)
  })
})

describe('assertProcessToken', () => {
  it('accepts an ordinary token', () => {
    expect(assertProcessToken('model', 'zai-org/glm-5.3')).toBe('zai-org/glm-5.3')
  })

  it('rejects an empty token', () => {
    expect(() => assertProcessToken('model', '')).toThrow(/must not be empty/u)
  })

  it('rejects a token carrying a NUL or a line break', () => {
    expect(() => assertProcessToken('model', 'a\0b')).toThrow(/NUL/u)
    expect(() => assertProcessToken('model', 'a\nb')).toThrow(/line break/u)
  })
})
