/** Assert the actual model request while replay controls only model responses. */
import { join } from 'node:path'

export const name = 'directory-request-probe'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped loop services. */
export function apply(ctx) {
  let calls = 0
  ctx.on('llm/stream', async function* (request, next) {
    const agent = ctx.agents.get(request.sessionId)
    if (agent === undefined) throw new Error('directory snapshot requires a real Agent')
    const original = process.cwd()
    const expected = calls++ === 0 ? original : join(original, 'selected')
    const literal = `Current working directory: ${JSON.stringify(expected)}.`
    const context = request.messages.filter(message => message.source.kind === 'runtime-context').at(-1)
    if (!context?.content.some(block => block.type === 'text' && block.text.includes(literal))) {
      throw new Error(`DIRECTORY_SNAPSHOT_CONTEXT_MISMATCH: expected ${literal}; got ${JSON.stringify(context)}`)
    }
    if (agent.session.header.cwd !== original) throw new Error('directory snapshot changed project authority')
    if (calls === 2 && !request.messages.some(message => message.source.kind === 'working-directory')) {
      throw new Error('directory snapshot lost the committed transition notice')
    }
    yield* next()
  })
}
