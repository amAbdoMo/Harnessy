/** Drive real host-only commands before the SDK's recorded root turn closes. */
export const name = 'snapshot-codex-fast-probe'
export const inject = ['commands', 'sessionProjections']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed command and projection services.
 */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = JSON.stringify(agent.session.deriveMessages())
    const state = () => ctx.sessionProjections.stateOf(agent.session, 'codexFastMode')
    if (state() !== false) throw new Error('fast snapshot requires the initial disabled preference')
    for (const [line, enabled, kind] of [
      ['/fast on', true, 'success'],
      ['/fast status', true, 'success'],
      ['/fast invalid', true, 'error'],
      ['/fast off', false, 'success'],
    ]) {
      const execution = await ctx.commands.execute(agent, line, [], signal)
      if (execution?.result.kind !== kind) throw new Error(`${line}: unexpected command outcome`)
      if (state() !== enabled) throw new Error(`${line}: unexpected projected preference`)
    }
    if (JSON.stringify(agent.session.deriveMessages()) !== messages) {
      throw new Error('fast commands changed model-visible history')
    }
  })
}
