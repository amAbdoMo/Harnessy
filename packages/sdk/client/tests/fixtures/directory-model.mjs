/** Keyless model boundary: inspect the real loop request before producing text. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'sdk-directory-model'
export const inject = ['llm', 'agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped profile services. */
export function apply(ctx) {
  class DirectoryModel extends LlmAdapter {
    async *stream(request) {
      const agent = ctx.agents.get(request.sessionId)
      if (agent === undefined) throw new Error('directory model requires a real Agent')
      const prompt = request.messages.filter(message => message.source.kind === 'user').at(-1)
      const input = prompt?.content.find(block => block.type === 'text')?.text
      const expected = JSON.parse(input)
      const contexts = request.messages.filter(message => message.source.kind === 'runtime-context')
      const context = contexts.at(-1)
      const section = context?.source.sections.find(section => section.name === 'working-directory:current')
      const literal = `Current working directory: ${JSON.stringify(expected.cwd)}.`
      if (context?.source.sections.length !== 1) throw new Error('OPTIONAL_CONTEXT_NOT_SUPPRESSED')
      if (section?.text !== literal || !context.content.some(block => block.type === 'text' && block.text.includes(literal))) {
        throw new Error('DIRECTORY_CONTEXT_MISMATCH')
      }
      if (agent.session.header.cwd !== expected.original) throw new Error('DIRECTORY_HEADER_CHANGED')
      if (!Object.isFrozen(request) || !Object.isFrozen(request.messages)) throw new Error('REQUEST_NOT_IMMUTABLE')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'DIRECTORY_OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DIRECTORY_OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['directory-keyless'], new DirectoryModel()))
}
