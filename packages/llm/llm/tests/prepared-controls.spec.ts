import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ConfigureCall, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

class BoundAdapter extends LlmAdapter {
  preparations = 0
  readonly requests: GenerateOptions[] = []
  readonly info: LlmResolvedModelInfo = {
    provider: 'route', id: 'model', name: 'Model', defaultMaxTokens: 4096,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('high'), name: 'High' },
        { id: ReasoningEffortId('low'), name: 'Low' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    },
  }

  override prepareCall() {
    this.preparations += 1
    return Promise.resolve({ model: this.info, stream: (options: GenerateOptions) => this.stream(options) })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<{ runtime: LlmRuntime; adapter: BoundAdapter; dispose: () => void }> {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new BoundAdapter()
  const dispose = ctx.llm.registerAdapter(['route'], adapter)
  return { runtime: ctx.llm, adapter, dispose }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* consume the prepared call */ }
}

describe('prepared call control selection', () => {
  it('selects once from detached frozen inputs before defaults and binds dispatch across registration replacement', async () => {
    const { runtime, adapter, dispose } = await setup()
    const config = { provider: 'route', model: 'model', maxTokens: 32, stop: ['stop'] }
    const configure = vi.fn<ConfigureCall>((controls, model) => {
      expect(controls).toEqual({ maxTokens: 32, stop: ['stop'] })
      expect(Object.isFrozen(controls)).toBe(true)
      expect(Object.isFrozen(controls.stop)).toBe(true)
      expect(Object.isFrozen(model.reasoning?.efforts)).toBe(true)
      expect(model.reasoning?.defaultEffort).toBe('high')
      return { ...controls, reasoningEffort: ReasoningEffortId('low'), provider: 'ignored', model: 'ignored' }
    })
    const call = await runtime.prepareCall(config, undefined, configure)
    config.stop.push('later')
    adapter.info.reasoning!.efforts[0]!.name = 'Changed'
    expect(configure.mock.calls[0]?.[0].stop).toEqual(['stop'])
    expect(configure.mock.calls[0]?.[1].reasoning?.efforts[0]?.name).toBe('High')
    expect(Object.isFrozen(adapter.info)).toBe(false)
    dispose()
    const replacement = new BoundAdapter()
    runtime.registerAdapter(['route'], replacement)
    expect(call.config).toEqual({ ...config, stop: ['stop'], reasoningEffort: 'low' })
    expect(call.adapterDefaults).toEqual({})
    await drain(call.stream({ ...call.config, messages: [] }))
    expect(configure).toHaveBeenCalledTimes(1)
    expect(adapter.preparations).toBe(1)
    expect(adapter.requests[0]?.reasoningEffort).toBe('low')
    expect(replacement.preparations).toBe(0)
    expect(replacement.requests).toEqual([])
  })

  it.each([false, true])('captures proposed controls before asynchronous lookup (selector: %s)', async (withSelector) => {
    const { runtime, dispose } = await setup()
    const ready = Promise.withResolvers<undefined>()
    class WaitingAdapter extends BoundAdapter {
      override async prepareCall() {
        await ready.promise
        return super.prepareCall()
      }
    }
    dispose()
    const captured = new WaitingAdapter()
    const release = runtime.registerAdapter(['route'], captured)
    const config = { provider: 'route', model: 'model', maxTokens: 32, stop: ['original'] }
    const configure = vi.fn<ConfigureCall>(controls => ({ ...controls, reasoningEffort: ReasoningEffortId('low') }))
    const pending = runtime.prepareCall(config, undefined, withSelector ? configure : undefined)
    config.model = 'changed'
    config.maxTokens = 64
    config.stop.push('changed')
    release()
    const replacement = new BoundAdapter()
    runtime.registerAdapter(['route'], replacement)
    ready.resolve(undefined)
    const call = await pending
    expect(call.config).toEqual({
      provider: 'route', model: 'model', maxTokens: 32, stop: ['original'],
      reasoningEffort: withSelector ? 'low' : 'high',
    })
    await drain(call.stream({ ...call.config, messages: [] }))
    expect(captured.requests).toHaveLength(1)
    expect(replacement.requests).toEqual([])
    if (withSelector) expect(configure.mock.calls[0]?.[0]).toEqual({ maxTokens: 32, stop: ['original'] })
  })

  it('materializes defaults after selection and leaves the no-callback path unchanged', async () => {
    const { runtime } = await setup()
    const call = await runtime.prepareCall({ provider: 'route', model: 'model', maxTokens: 32 }, undefined, () => ({}))
    expect(call.config).toMatchObject({ maxTokens: 4096, reasoningEffort: 'high' })
    expect(call.adapterDefaults).toEqual({ maxTokens: true, reasoningEffort: true })
    const normal = await runtime.prepareCall({ provider: 'route', model: 'model', maxTokens: 32 })
    expect(normal.config).toMatchObject({ maxTokens: 32, reasoningEffort: 'high' })
    expect(normal.adapterDefaults).toEqual({ reasoningEffort: true })
  })

  it('rejects unsupported callback-selected efforts before dispatch', async () => {
    const { runtime, adapter } = await setup()
    await expect(runtime.prepareCall({ provider: 'route', model: 'model' }, undefined,
      controls => ({ ...controls, reasoningEffort: ReasoningEffortId('absent') })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(adapter.requests).toEqual([])
  })

  it('propagates callback failures without dispatch', async () => {
    const { runtime, adapter } = await setup()
    const failure = new Error('selection failed')
    await expect(runtime.prepareCall({ provider: 'route', model: 'model' }, undefined, () => { throw failure }))
      .rejects.toBe(failure)
    expect(adapter.requests).toEqual([])
  })

  it('rejects pre-abort without resolving an adapter or calling the selector', async () => {
    const { runtime, adapter } = await setup()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    const configure = vi.fn(() => ({}))
    await expect(runtime.prepareCall({ provider: 'route', model: 'model' }, controller.signal, configure)).rejects.toBe(reason)
    expect(adapter.preparations).toBe(0)
    expect(configure).not.toHaveBeenCalled()
  })

  it('rejects cancellation during a lookup that ignores its signal before selection', async () => {
    const { runtime, adapter, dispose } = await setup()
    const started = Promise.withResolvers<undefined>()
    const resolved = Promise.withResolvers<undefined>()
    class DelayedAdapter extends BoundAdapter {
      override async prepareCall() {
        started.resolve(undefined)
        await resolved.promise
        return super.prepareCall()
      }
    }
    dispose()
    const delayed = new DelayedAdapter()
    runtime.registerAdapter(['route'], delayed)
    const controller = new AbortController()
    const configure = vi.fn(() => ({}))
    const pending = runtime.prepareCall({ provider: 'route', model: 'model' }, controller.signal, configure)
    await started.promise
    const reason = new Error('lookup cancelled')
    controller.abort(reason)
    resolved.resolve(undefined)
    await expect(pending).rejects.toBe(reason)
    expect(configure).not.toHaveBeenCalled()
    expect(adapter.requests).toEqual([])
    expect(delayed.requests).toEqual([])
  })

  it('rejects cancellation during control selection', async () => {
    const { runtime, adapter } = await setup()
    const controller = new AbortController()
    const reason = new Error('selection cancelled')
    await expect(runtime.prepareCall({ provider: 'route', model: 'model' }, controller.signal, (controls) => {
      controller.abort(reason)
      return controls
    })).rejects.toBe(reason)
    expect(adapter.requests).toEqual([])
  })
})
