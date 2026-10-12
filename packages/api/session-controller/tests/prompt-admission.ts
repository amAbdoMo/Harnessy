/** Operation-local cancellation for direct command-controller test consumers. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionCommandController } from '../src/commands.ts'
import type { SessionPromptRequest, SessionPromptValue } from '../src/types.ts'

/** Direct test adapter retaining the command owner's queue implementation. */
export interface PromptCommandTestAdapter {
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<SessionPromptValue>
  updateQueue: SessionCommandController['updateQueue']
}

/**
 * Give every direct prompt invocation an explicit cancellation owner.
 * @param commands - real command controller, including legacy suite fixtures.
 * @returns prompt and queue operations bound to that controller.
 */
export function promptCommandTestAdapter(commands: SessionCommandController): PromptCommandTestAdapter {
  return {
    prompt: (request, signal = new AbortController().signal) => commands.prompt(request, () => {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'prompt admission was cancelled', {})
    }),
    updateQueue: request => commands.updateQueue(request),
  }
}
