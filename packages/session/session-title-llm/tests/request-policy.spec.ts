import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelReasoningInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { generateSessionTitleWithLlm, resolveSessionTitleLlmConfig, SESSION_TITLE_TIMEOUT_CODE } from '@deepseek-ai/dsh-session-title-llm'

let ctx: Context | undefined
const CONFIG = resolveSessionTitleLlmConfig({
  targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 1000, maxOutputTokens: 32, timeoutMs: 1000,
})
const PROVIDER = SessionTitleProviderId('policy-test')

class PolicyAdapter extends LlmAdapter {
  preparations = 0
  readonly requests: GenerateOptions[] = []
  constructor(readonly output: string, readonly reasoning?: LlmModelReasoningInfo) { super() }

  override prepareCall(provider: string, model: string) {
    this.preparations += 1
    return Promise.resolve({
      model: {
        provider, id: model, name: model, defaultMaxTokens: 8192,
        ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
      },
      stream: (options: GenerateOptions) => this.stream(options),
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: this.output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.useRealTimers()
})

async function setup(adapter: PolicyAdapter): Promise<SessionTitleProviderRequest> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['route'], adapter)
  const session = ctx.sessions.create(SessionId('title-policy'))
  session.append('turn/start', { turn: 1 })
  const message = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Improve title requests' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return { session, messages: [{ seq: message.seq, text: 'Improve title requests' }], route: { provider: 'route', model: 'model' }, signal: new AbortController().signal }
}

async function generate(request: SessionTitleProviderRequest, anchor?: string) {
  if (ctx === undefined) throw new Error('missing test context')
  return generateSessionTitleWithLlm(ctx, CONFIG, request, request.messages, PROVIDER, anchor)
}

describe('title request policy', () => {
  it.each([
    [['high', 'low', 'off'], 'high', 'low'],
    [['minimal', 'medium', 'high'], 'high', 'minimal'],
    [['medium', 'high'], 'high', 'medium'],
    [['opaque'], 'opaque', 'opaque'],
    [[], undefined, undefined],
  ] as const)('selects only a supported effort from %s without inheriting conversation defaults', async (ids, defaultEffort, expected) => {
    const reasoning = ids.length === 0 ? undefined : {
      efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id })),
      ...defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) },
    }
    const adapter = new PolicyAdapter('Title', reasoning)
    const request = await setup(adapter)
    await generate(request)
    expect(adapter.preparations).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ maxTokens: 32, purpose: 'session-title' })
    expect(adapter.requests[0]?.reasoningEffort).toBe(expected)
    const dispatched = adapter.requests[0]!
    const logged = request.session.snapshotEvents().find(event => event.type === 'session/title-llm-request')
    expect(logged?.data).toEqual({
      titleProvider: PROVIDER,
      messageSeqs: request.messages.map(message => message.seq),
      route: { provider: dispatched.provider, model: dispatched.model },
      system: dispatched.system, messages: dispatched.messages, maxTokens: dispatched.maxTokens,
      config: {
        provider: dispatched.provider, model: dispatched.model, maxTokens: dispatched.maxTokens,
        ...dispatched.reasoningEffort === undefined ? {} : { reasoningEffort: dispatched.reasoningEffort },
      },
    })
  })

  it.each([
    ['\n **Useful title**\r\nExplanation to discard', 'Useful title'],
    ['*Useful title*', 'Useful title'],
    ['***Useful title***', 'Useful title'],
    ['Title with *literal emphasis*', 'Title with *literal emphasis*'],
    ['**Title with **inner** emphasis**', '**Title with **inner** emphasis**'],
    ['\u001b[31mTitle\u001b[0m\nMore text', 'Title'],
  ])('normalizes the first non-empty title line in %j', async (output, title) => {
    const request = await setup(new PolicyAdapter(output))
    expect((await generate(request)).title).toBe(title)
  })

  it('rejects output whose first non-empty line normalizes to empty', async () => {
    const request = await setup(new PolicyAdapter('\u001b[31m\nDo not use commentary'))
    await expect(generate(request)).rejects.toThrow('produced no text')
  })

  it('records the anchored JSON input and stability instructions before bound dispatch', async () => {
    const adapter = new PolicyAdapter('Existing title')
    const request = await setup(adapter)
    expect((await generate(request, 'Existing title')).title).toBe('Existing title')
    const event = request.session.snapshotEvents().find(event => event.type === 'session/title-llm-request')
    expect(event?.data).toMatchObject({ system: adapter.requests[0]?.system, messages: adapter.requests[0]?.messages, maxTokens: 32 })
    const input = adapter.requests[0]?.messages[0]?.content[0]
    expect(input?.type === 'text' && input.text).toBe(`Update the session title from this JSON object:\n${JSON.stringify({ currentTitle: 'Existing title', messages: request.messages })}`)
    expect(adapter.requests[0]?.system).toMatchInlineSnapshot(`
      "Create a concise title for an AI coding-assistant session from the supplied human messages.
      Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.
      Use the language of the messages.
      Aim for about 5 words in non-CJK languages or 10 CJK characters.
      If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.
      An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.
      Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.
      Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.
      Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate."
    `)
  })

  it('counts the current-title framing in the complete input-byte bound', async () => {
    const adapter = new PolicyAdapter('Unused')
    const request = await setup(adapter)
    await expect(generate(request, '界'.repeat(1000))).rejects.toThrow('exceeding maxInputBytes')
    expect(adapter.preparations).toBe(0)
    expect(request.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)
  })

  it('rejects late successful preparation before request logging or streaming', async () => {
    vi.useFakeTimers()
    class LateAdapter extends PolicyAdapter {
      override async prepareCall(provider: string, model: string) {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        return super.prepareCall(provider, model)
      }
    }
    const adapter = new LateAdapter('Unused')
    const request = await setup(adapter)
    const pending = generateSessionTitleWithLlm(ctx!, { ...CONFIG, timeoutMs: 10 }, request, request.messages, PROVIDER)
    const rejection = expect(pending).rejects.toMatchObject({ code: SESSION_TITLE_TIMEOUT_CODE })
    await vi.advanceTimersByTimeAsync(20)
    await rejection
    expect(adapter.requests).toEqual([])
    expect(request.session.snapshotEvents().some(event => event.type === 'session/title-llm-request')).toBe(false)
  })
})
