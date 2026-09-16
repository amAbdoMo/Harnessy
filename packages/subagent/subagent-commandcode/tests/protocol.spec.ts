import { describe, expect, it } from 'vitest'
import {
  activityForTool,
  classifyExitCode,
  CommandCodeFrameReader,
  resultFailure,
} from '../src/protocol.ts'

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('CommandCodeFrameReader', () => {
  it('reads the terminal result frame that ends a run', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({ type: 'event', event: { type: 'tool_running', toolName: 'read_file' } }))
    reader.push(frame({ type: 'result', subtype: 'success', finalText: 'the answer', stopReason: 'end_turn' }))
    reader.flush()
    expect(reader.result).toEqual({
      subtype: 'success',
      finalText: 'the answer',
      stopReason: 'end_turn',
    })
  })

  it('reassembles frames split across chunks', () => {
    const reader = new CommandCodeFrameReader()
    const line = frame({ type: 'result', subtype: 'success', finalText: 'split answer' })
    reader.push(line.slice(0, 12))
    expect(reader.result).toBeUndefined()
    reader.push(line.slice(12))
    reader.flush()
    expect(reader.result?.finalText).toBe('split answer')
  })

  it('reads a final line the stream ended without a newline after', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(JSON.stringify({ type: 'result', subtype: 'success', finalText: 'no newline' }))
    expect(reader.result).toBeUndefined()
    reader.flush()
    expect(reader.result?.finalText).toBe('no newline')
  })

  it('counts unreadable lines instead of failing the run', () => {
    const reader = new CommandCodeFrameReader()
    reader.push('not json\n')
    reader.push('[1,2,3]\n')
    reader.push(frame({ type: 'result', subtype: 'success', finalText: 'ok' }))
    reader.flush()
    expect(reader.unreadableFrames).toBe(2)
    expect(reader.result?.finalText).toBe('ok')
  })

  it('treats a truncated trailing frame as a missing result', () => {
    const reader = new CommandCodeFrameReader()
    reader.push('{"type":"result","subtype":"suc')
    reader.flush()
    expect(reader.result).toBeUndefined()
    expect(reader.unreadableFrames).toBe(1)
  })

  it('reports a coarse activity and keeps transcript detail out', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({
      type: 'event',
      event: { type: 'tool_running', toolName: 'edit_file', description: 'secret file contents' },
    }))
    expect(reader.activity).toBe('editing')
  })

  it('reports finalizing once the terminal frame arrives', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({ type: 'event', event: { type: 'tool_running', toolName: 'read_file' } }))
    reader.push(frame({ type: 'result', subtype: 'success', finalText: 'done' }))
    expect(reader.activity).toBe('finalizing')
  })

  it('ignores unknown frame and event types', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({ type: 'something-new', event: { type: 'tool_running', toolName: 'read_file' } }))
    reader.push(frame({ type: 'event', event: { type: 'brand_new_phase' } }))
    reader.push(frame({ type: 'event', event: { type: 'tool_running', toolName: 'bash' } }))
    expect(reader.activity).toBe('command')
    expect(reader.unreadableFrames).toBe(0)
  })

  it('carries a reported error through the terminal frame', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({ type: 'result', subtype: 'error', finalText: '', error: 'auth failed' }))
    reader.flush()
    expect(reader.result).toEqual({ subtype: 'error', finalText: '', error: 'auth failed' })
  })

  it('keeps an unrecognized subtype verbatim', () => {
    const reader = new CommandCodeFrameReader()
    reader.push(frame({ type: 'result', subtype: 'future_subtype', finalText: 'x' }))
    expect(reader.result?.subtype).toBe('future_subtype')
  })
})

describe('activityForTool', () => {
  it('maps the documented tool families to coarse categories', () => {
    expect(activityForTool('read_file')).toBe('reading')
    expect(activityForTool('read_directory')).toBe('reading')
    expect(activityForTool('grep')).toBe('reading')
    expect(activityForTool('write_file')).toBe('editing')
    expect(activityForTool('edit_file')).toBe('editing')
    expect(activityForTool('bash')).toBe('command')
    expect(activityForTool('run_command')).toBe('command')
  })

  it('reports nothing for a tool it cannot classify', () => {
    expect(activityForTool('zzz')).toBeUndefined()
  })
})

describe('classifyExitCode', () => {
  it('transcribes the documented exit codes', () => {
    expect(classifyExitCode(3)).toBe('not-authenticated')
    expect(classifyExitCode(4)).toBe('access-denied')
    expect(classifyExitCode(5)).toBe('rate-limited')
    expect(classifyExitCode(6)).toBe('network')
    expect(classifyExitCode(7)).toBe('service')
    expect(classifyExitCode(8)).toBe('max-turns')
    expect(classifyExitCode(9)).toBe('no-answer')
    expect(classifyExitCode(10)).toBe('credits')
    expect(classifyExitCode(130)).toBe('cancelled')
  })

  it('treats success, signals, and unknown codes as unclassified', () => {
    expect(classifyExitCode(0)).toBe('unknown')
    expect(classifyExitCode(null)).toBe('unknown')
    expect(classifyExitCode(42)).toBe('unknown')
  })
})

describe('resultFailure', () => {
  it('accepts only a non-empty success', () => {
    expect(resultFailure({ subtype: 'success', finalText: 'answer' })).toBeUndefined()
    expect(resultFailure({ subtype: 'success', finalText: '   ' })).toBe('no-answer')
    expect(resultFailure({ subtype: 'max_turns', finalText: 'partial' })).toBe('max-turns')
    expect(resultFailure({ subtype: 'error', finalText: '' })).toBe('unknown')
  })
})
