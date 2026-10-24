/** Awaited creation context shared by TypeScript and Python SDK snapshots. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const name = 'serial-created-fixture'
export const inject = ['agents', 'sessions']

/** Install ordered creation listeners whose context must precede the first turn. */
export function apply(ctx) {
  const ready = new WeakSet()
  ctx.on('agent/created', async ({ agent }) => {
    await setImmediate()
    if (agent.session.header.origin !== 'subagent') {
      const fork = ctx.sessions.fork(agent.session)
      const nested = ctx.sessions.fork(fork)
      for (const [session, source] of [[fork, agent.session], [nested, fork]]) {
        if (session.header.parentSession !== source.id || session.header.origin !== undefined
          || !session.header.isSeeded) throw new Error('ordinary fork lost source metadata or acquired subagent origin')
      }
    }
    agent.inject({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Serial agent creation completed.' }],
      source: { kind: `plugin:${name}` },
    })
    ready.add(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!ready.has(agent)) throw new Error('creation listeners ran out of order')
  })
}
