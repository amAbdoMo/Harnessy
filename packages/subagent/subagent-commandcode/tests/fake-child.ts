/** One controllable managed process standing in for the shared subprocess seam. */
import { PassThrough } from 'node:stream'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Options one fake managed process is built with. */
export interface FakeChildOptions {
  /** stderr text the collected reader exposes after exit. */
  readonly stderrTail?: string
  /** stdout text the collected reader exposes after exit. */
  readonly stdoutTail?: string
  /**
   * Whether termination requests settle the process the way the real seam
   * does. A test that must observe a disposal waiting on the managed range
   * turns this off and reports the exit itself.
   */
  readonly settleOnTerminate?: boolean
}

/** A spawned process the test drives by hand. */
export interface FakeChild {
  /** The handle the run under test holds. */
  readonly handle: SubprocessHandle
  /** The exact spawn request the run issued. */
  readonly spec: SubprocessSpawnSpec
  /** Bytes the run wrote to the child's stdin, in order. */
  readonly stdin: Buffer[]
  /** Whether the run asked the managed range to terminate. */
  readonly terminated: () => boolean
  /** Deliver one stdout chunk. */
  readonly stdout: (text: string) => void
  /** Deliver one stderr chunk. */
  readonly stderr: (text: string) => void
  /** Report the direct child's exit. */
  readonly exit: (outcome?: SubprocessOutcome) => void
  /** Reject the managed process, as a spawn failure does. */
  readonly fail: (error: Error) => void
}

/** Exit facts of a managed range the run terminated itself. */
const TERMINATED: SubprocessOutcome = { exitCode: null, signal: 'SIGTERM' }

/**
 * Build one fake managed process for a spawn request.
 * @param spec - the request the run issued.
 * @param options - stderr tail and termination behavior.
 * @returns the handle plus the test's controls.
 */
export function fakeChild(spec: SubprocessSpawnSpec, options: FakeChildOptions = {}): FakeChild {
  const out = new PassThrough()
  const err = new PassThrough()
  const input = new PassThrough()
  const stdin: Buffer[] = []
  input.on('data', (chunk: Buffer) => { stdin.push(Buffer.from(chunk)) })
  const done = Promise.withResolvers<SubprocessOutcome>()
  const exited = Promise.withResolvers<boolean>()
  const settleOnTerminate = options.settleOnTerminate ?? true
  let stopped = false
  let finished = false

  const exit = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (finished) return
    finished = true
    out.end()
    err.end()
    done.resolve(outcome)
    exited.resolve(true)
  }

  const handle: SubprocessHandle = {
    stdin: input,
    stdout: out,
    stderr: err,
    collected: {
      stdout: {
        readFrom: (fromByte: number) => {
          const text = fromByte === 0 ? options.stdoutTail ?? '' : ''
          return { text, nextOffset: fromByte + text.length, lossy: false }
        },
      },
      stderr: {
        readFrom: (fromByte: number) => {
          const text = fromByte === 0 ? options.stderrTail ?? '' : ''
          return { text, nextOffset: fromByte + text.length, lossy: false }
        },
      },
    },
    done: done.promise,
    terminate: () => {
      stopped = true
      // The real seam reacts to a termination request by ending the managed
      // range; a fake that ignored it would hang every disposal.
      if (settleOnTerminate) exit(TERMINATED)
    },
    waitForExit: () => exited.promise,
  }

  // The seam starts termination when the spawn signal aborts, which is what a
  // deadline or a cancelled caller does.
  spec.signal?.addEventListener('abort', () => { handle.terminate() }, { once: true })

  return {
    handle,
    spec,
    stdin,
    terminated: () => stopped,
    stdout: (text) => { out.write(text) },
    stderr: (text) => { err.write(text) },
    exit,
    fail: (error) => {
      if (finished) return
      finished = true
      out.destroy()
      err.destroy()
      done.reject(error)
      exited.resolve(true)
    },
  }
}
