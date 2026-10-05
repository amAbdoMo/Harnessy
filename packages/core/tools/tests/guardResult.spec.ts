import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineTool, TOOL_RUNTIME_SCHEDULER,
  type ToolExecution, type ToolExecutionResult,
} from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'guard-result-test': { kind: 'guard-result-test' }
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const echo = defineTool({
  name: 'guarded', description: '', parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: () => ({ secret: 'sensitive metadata' }),
  },
  async execute() { return 'sensitive value' },
})

function call() {
  return {
    callId: ToolCallId('guard-result'), name: echo.name, arguments: {},
    signal: new AbortController().signal,
  }
}

const revokedError = {
  isError: true,
  content: [{ type: 'text', text: 'Error: authority revoked' }],
  error: { message: 'authority revoked', info: { name: 'HarnessError', code: 'AUTHORITY_REVOKED' } },
}

function assertAuthorized(authorized: boolean): undefined {
  if (!authorized) throw new HarnessError('authority revoked', 'AUTHORITY_REVOKED')
  return undefined
}

const secretContext = () => createUserMessage({
  content: [{ type: 'text', text: 'sensitive context' }],
  source: { kind: 'guard-result-test' },
})

describe('ToolRuntime.guardResult', () => {
  it('accepts only synchronous invocation assertions', () => {
    type Check = Parameters<ToolRuntime['guardResult']>[1]
    expectTypeOf<Check>().toEqualTypeOf<(result: Readonly<ToolExecutionResult>) => undefined>()
    expectTypeOf<() => Promise<undefined>>().not.toExtend<Check>()
  })

  it.each([
    'authorized', 'post-execute cancellation', 'finalization cancellation', 'materialization cancellation',
  ])('retains caller and restored-wrapper cancellation through publication after %s', async (outcome) => {
    const ctx = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const caller = new AbortController()
    const wrapper = new AbortController()
    const added = vi.spyOn(wrapper.signal, 'addEventListener')
    const removed = vi.spyOn(wrapper.signal, 'removeEventListener')
    const addedCaller = vi.spyOn(caller.signal, 'addEventListener')
    const removedCaller = vi.spyOn(caller.signal, 'removeEventListener')
    let capturedSignal: AbortSignal | undefined
    const pending: Promise<ToolExecutionResult>[] = []
    onTestFinished(async () => {
      release.resolve(undefined)
      await Promise.allSettled(pending)
      added.mockRestore()
      removed.mockRestore()
      addedCaller.mockRestore()
      removedCaller.mockRestore()
      await ctx.fiber.dispose()
    })
    ctx.on('tools/execute', async (exec, next) => {
      const previous = exec.signal
      exec.signal = wrapper.signal
      try {
        return await next()
      } finally {
        exec.signal = previous
      }
    })
    ctx.tools.register({
      ...echo,
      async execute(_args, exec) {
        const signal = exec.signal
        capturedSignal = signal
        ctx.tools.guardResult(exec, () => { signal.throwIfAborted(); return undefined })
        return 'sensitive value'
      },
      finalizeContent() {
        if (outcome === 'materialization cancellation') return [{
          type: 'text',
          get text() {
            wrapper.abort(new HarnessError('authority revoked', 'AUTHORITY_REVOKED'))
            return 'sensitive final content'
          },
        }]
        if (outcome !== 'finalization cancellation') return undefined
        wrapper.abort(new HarnessError('authority revoked', 'AUTHORITY_REVOKED'))
        return [{ type: 'text', text: 'sensitive final content' }]
      },
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    const running = ctx.tools.execute({ ...call(), signal: caller.signal })
    pending.push(running)
    await entered.promise
    expect(added).toHaveBeenCalledTimes(1)
    expect(addedCaller).toHaveBeenCalledTimes(1)
    expect(removed).not.toHaveBeenCalled()
    expect(removedCaller).not.toHaveBeenCalled()
    if (outcome === 'post-execute cancellation') wrapper.abort(new HarnessError('authority revoked', 'AUTHORITY_REVOKED'))
    expect(capturedSignal?.aborted).toBe(outcome === 'post-execute cancellation')
    expect(caller.signal.aborted).toBe(false)
    release.resolve(undefined)
    const result = await running
    if (outcome !== 'authorized') expect(result).toEqual(revokedError)
    else expect(result).toMatchObject({ isError: false, value: 'sensitive value' })
    expect(capturedSignal?.aborted).toBe(outcome !== 'authorized')
    expect(removed).toHaveBeenCalledTimes(1)
    expect(removedCaller).toHaveBeenCalledTimes(1)
  })

  it('removes caller and wrapper forwarding after an uncancelled around-dispatch failure', async () => {
    const ctx = await setup()
    const caller = new AbortController()
    const wrapper = new AbortController()
    const removedCaller = vi.spyOn(caller.signal, 'removeEventListener')
    const removedWrapper = vi.spyOn(wrapper.signal, 'removeEventListener')
    onTestFinished(async () => {
      removedCaller.mockRestore()
      removedWrapper.mockRestore()
      await ctx.fiber.dispose()
    })
    let capturedSignal: AbortSignal | undefined
    ctx.tools.register({
      ...echo,
      async execute(_args, exec) { capturedSignal = exec.signal; return 'sensitive value' },
    })
    ctx.on('tools/execute', async (exec, next) => {
      const previous = exec.signal
      exec.signal = wrapper.signal
      try {
        await next()
        throw new HarnessError('wrapper failed', 'WRAPPER_FAILURE')
      } finally {
        exec.signal = previous
      }
    })
    const result = await ctx.tools.execute({ ...call(), signal: caller.signal })
    expect(result).toMatchObject({ isError: true, error: { message: 'wrapper failed', info: { code: 'WRAPPER_FAILURE' } } })
    expect(capturedSignal?.aborted).toBe(false)
    expect(caller.signal.aborted).toBe(false)
    expect(wrapper.signal.aborted).toBe(false)
    expect(removedCaller).toHaveBeenCalledTimes(1)
    expect(removedWrapper).toHaveBeenCalledTimes(1)
  })

  it.each([
    { failure: false, revoke: false },
    { failure: false, revoke: true },
    { failure: true, revoke: false },
    { failure: true, revoke: true },
  ])('publishes a guarded outcome after held post-execute (failure: $failure, revoked: $revoke)', async ({ failure, revoke }) => {
    const ctx = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let authorized = true
    const bodyContext = secretContext()
    const postContext = secretContext()
    let observed: Readonly<ToolExecutionResult> | undefined
    const order: string[] = []
    let pending: Promise<ToolExecutionResult> | undefined
    try {
      ctx.tools.register({
        ...echo,
        async execute(_args, exec) {
          ctx.tools.guardResult(exec, () => {
            order.push('check')
            assertAuthorized(authorized)
            return undefined
          })
          exec.deferContext(bodyContext)
          exec.concludeTurn()
          if (failure) throw new Error('sensitive failure')
          return 'sensitive value'
        },
        finalizeContent() {
          order.push('finalize')
          return [{ type: 'text', text: 'sensitive final content' }]
        },
      })
      ctx.on('tools/execute', async (_exec, next) => ({
        ...await next(), meta: { secret: 'sensitive metadata' },
      }))
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        const decision = await next()
        entered.resolve(undefined)
        await release.promise
        return { ...decision, additionalContexts: [postContext] }
      })
      ctx.on('tools/result', (_exec, result) => {
        order.push('notify')
        observed = result
      })
      pending = ctx.tools.execute(call())
      await entered.promise
      expect(observed).toBeUndefined()
      expect(order).toEqual([])
      authorized = !revoke
      release.resolve(undefined)
      const result = await pending
      expect(observed).toBe(result)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.content)).toBe(true)
      expect(order).toEqual(['finalize', 'check', 'notify'])
      if (revoke) {
        expect(result).toEqual(revokedError)
        expect(JSON.stringify(result)).not.toContain('sensitive')
      } else {
        expect(result.isError).toBe(failure)
        expect(result.content).toEqual([{ type: 'text', text: 'sensitive final content' }])
        expect(result.meta).toEqual({ secret: 'sensitive metadata' })
        expect(result.additionalContexts).toEqual([bodyContext, postContext])
        if (!result.isError) {
          expect(result.value).toBe('sensitive value')
          expect(result.concludesTurn).toBe(true)
        }
      }
    } finally {
      release.resolve(undefined)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it('passes the complete frozen final outcome to assertions after finalization and materialization', async () => {
    const ctx = await setup()
    onTestFinished(() => ctx.fiber.dispose())
    let checked: Readonly<ToolExecutionResult> | undefined
    const addedContext = secretContext()
    ctx.tools.register({ ...echo, finalizeContent: () => [{ type: 'text', text: 'final content' }] })
    ctx.on('tools/pre-execute', (execution, next) => {
      ctx.tools.guardResult(execution, (result) => {
        checked = result
        return undefined
      })
      return next()
    })
    ctx.on('tools/post-execute', async (_execution, _result, next) => ({
      ...await next(), additionalContexts: [addedContext],
    }))
    const result = await ctx.tools.execute(call())
    expect(result.isError).toBe(false)
    expect(checked).toBe(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.content)).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'final content' }])
    expect(result.meta).toEqual({ secret: 'sensitive metadata' })
    expect(result.additionalContexts).toEqual([addedContext])
  })

  it('accumulates pre-execute, body, and post-execute assertions in registration order', async () => {
    const ctx = await setup()
    const checked: string[] = []
    try {
      ctx.on('tools/pre-execute', async (exec, next) => {
        ctx.tools.guardResult(exec, () => { checked.push('pre'); return undefined })
        return next()
      })
      ctx.tools.register({
        ...echo,
        async execute(_args, exec) {
          ctx.tools.guardResult(exec, () => { checked.push('body'); return undefined })
          return 'sensitive value'
        },
      })
      ctx.on('tools/post-execute', async (exec, _result, next) => {
        ctx.tools.guardResult(exec, () => { checked.push('post'); return undefined })
        return next()
      })
      expect((await ctx.tools.execute(call())).isError).toBe(false)
      expect(checked).toEqual(['pre', 'body', 'post'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([0, 1])('does not let later registrations remove denial from assertion %i', async (denyingIndex) => {
    const ctx = await setup()
    try {
      ctx.on('tools/pre-execute', async (exec, next) => {
        ctx.tools.guardResult(exec, () => { assertAuthorized(denyingIndex !== 0); return undefined })
        ctx.tools.guardResult(exec, () => { assertAuthorized(denyingIndex !== 1); return undefined })
        ctx.tools.guardResult(exec, () => undefined)
        return next()
      })
      ctx.tools.register(echo)
      expect(await ctx.tools.execute(call())).toEqual(revokedError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks revoked authority after a content validator throws a sensitive diagnostic', async () => {
    const ctx = await setup()
    onTestFinished(() => ctx.fiber.dispose())
    let authorized = true
    let authorityChecked = false
    let observed: Readonly<ToolExecutionResult> | undefined
    ctx.tools.register(echo)
    ctx.on('tools/pre-execute', (exec, next) => {
      ctx.tools.guardResult(exec, (result) => {
        throw new Error(`invalid result: ${JSON.stringify(result)}`)
      })
      ctx.tools.guardResult(exec, () => {
        authorityChecked = true
        assertAuthorized(authorized)
        return undefined
      })
      return next()
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const result = await next()
      authorized = false
      return { ...result, additionalContexts: [secretContext()] }
    })
    ctx.on('tools/result', (_exec, result) => { observed = result })
    const result = await ctx.tools.execute(call())
    expect(authorityChecked).toBe(true)
    expect(observed).toBe(result)
    expect(result).toEqual(revokedError)
    expect(JSON.stringify(result)).not.toContain('sensitive')
  })

  it('rejects copied, foreign, and settled executions without rejecting the exact live execution', async () => {
    const ctx = await setup()
    const foreign = await setup()
    let execution: ToolExecution | undefined
    let checks = 0
    let observerRejected = false
    const rejected = /exact live execution before final acceptance/
    try {
      ctx.tools.register(echo)
      ctx.on('tools/pre-execute', async (exec, next) => {
        execution = exec
        expect(() => { ctx.tools.guardResult({ ...exec }, () => undefined) }).toThrow(rejected)
        expect(() => { foreign.tools.guardResult(exec, () => undefined) }).toThrow(rejected)
        ctx.tools.guardResult(exec, () => { checks++; return undefined })
        return next()
      })
      ctx.on('tools/result', (exec) => {
        try {
          ctx.tools.guardResult(exec, () => undefined)
        } catch (error: unknown) {
          observerRejected = error instanceof Error && rejected.test(error.message)
        }
      })
      expect((await ctx.tools.execute(call())).isError).toBe(false)
      expect(checks).toBe(1)
      expect(observerRejected).toBe(true)
      if (execution === undefined) throw new Error('pre-execute did not capture execution')
      const settled = execution
      expect(() => { ctx.tools.guardResult(settled, () => undefined) }).toThrow(rejected)
    } finally {
      await foreign.fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('closes registrations before initial materialization and checks after final materialization', async () => {
    const ctx = await setup()
    let authorized = true
    const stages: string[] = []
    const closedStages = new Set<string>()
    const rejected = /exact live execution before final acceptance/
    const probeRegistration = (exec: ToolExecution, stage: string): void => {
      try {
        ctx.tools.guardResult(exec, () => undefined)
      } catch (error: unknown) {
        if (error instanceof Error && rejected.test(error.message)) closedStages.add(stage)
      }
    }
    try {
      ctx.tools.register({
        ...echo,
        finalizeContent(exec) {
          stages.push('finalize')
          probeRegistration(exec, 'finalize')
          return [{
            type: 'text',
            get text() {
              stages.push('final materialization')
              authorized = false
              probeRegistration(exec, 'final materialization')
              return 'sensitive final content'
            },
          }]
        },
      })
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepared = await scheduler.prepare(call())
      if (prepared.kind !== 'dispatch') throw new Error('expected allowed preparation')
      const exec = prepared.exec
      ctx.tools.guardResult(exec, () => {
        stages.push('check')
        probeRegistration(exec, 'check')
        assertAuthorized(authorized)
        return undefined
      })
      const result = scheduler.finish(exec, {
        isError: true, content: [{ type: 'text', text: 'sensitive content' }],
        error: { message: 'sensitive failure' },
        get meta() {
          stages.push('initial materialization')
          probeRegistration(exec, 'initial materialization')
          return { secret: 'sensitive metadata' }
        },
      })
      expect(result).toEqual(revokedError)
      expect(stages.indexOf('initial materialization')).toBeLessThan(stages.indexOf('finalize'))
      expect(stages.slice(-3)).toEqual(['finalize', 'final materialization', 'check'])
      expect(closedStages).toEqual(new Set(['initial materialization', 'finalize', 'final materialization', 'check']))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['materialization', 'finalization'])('checks failures from %s without rerunning the finalizer', async (failureStage) => {
    const ctx = await setup()
    const order: string[] = []
    try {
      ctx.tools.register({
        ...echo,
        finalizeContent() {
          order.push('finalize')
          if (failureStage === 'finalization') throw new Error('sensitive finalization failure')
          return [{ type: 'text', text: 'sensitive final content' }]
        },
      })
      ctx.on('tools/pre-execute', async (exec, next) => {
        ctx.tools.guardResult(exec, () => {
          order.push('check')
          assertAuthorized(false)
          return undefined
        })
        return next()
      })
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepared = await scheduler.prepare(call())
      if (prepared.kind !== 'dispatch') throw new Error('expected allowed preparation')
      const candidate: ToolExecutionResult = failureStage === 'materialization'
        ? {
          isError: false, content: [{ type: 'text', text: 'sensitive content' }], value: 'sensitive value',
          get meta(): Record<string, never> {
            order.push('materialize')
            throw new Error('sensitive materialization failure')
          },
        }
        : { isError: false, content: [{ type: 'text', text: 'sensitive content' }], value: 'sensitive value' }
      expect(scheduler.finish(prepared.exec, candidate)).toEqual(revokedError)
      expect(order).toEqual(failureStage === 'materialization'
        ? ['materialize', 'finalize', 'check']
        : ['finalize', 'check'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
