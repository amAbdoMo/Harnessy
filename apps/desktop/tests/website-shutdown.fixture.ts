/** Native Website acceptance requires successful exit as well as physical process settlement. */
import type { ChildProcess } from 'node:child_process'

/**
 * Reject a crash, signal termination or still-running process after the product Quit flow.
 * @param child - exit outcome of the owned Electron process.
 */
export function assertCleanWebsiteExit(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): void {
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(`Owned Electron exited abnormally: code=${child.exitCode}; signal=${child.signalCode}`)
  }
}
