/** Non-operator Remote calls exercise the current authenticated-operator checks. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerId, PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Bind a call to a peer that Connection has not admitted as its operator.
 * @param ctx - fixture context retaining ownership of all services.
 * @returns a service-access context for the rejected caller.
 */
export function restrictedCaller(ctx: Context): Context {
  const peer: PeerScope = { id: randomUUID() as PeerId, ctx, dispose: async () => {} }
  const invocation: RemoteInvocation = {
    request: { namespace: 'actionCards', method: 'act', args: {} }, service: 'actionCards', peer,
    signal: new AbortController().signal, uplink: async function* () {},
  }
  return ctx.extend({ invocation })
}
