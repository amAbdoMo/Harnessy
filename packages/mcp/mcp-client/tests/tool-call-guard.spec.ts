/**
 * `mcp/tool-call` guard behavior: the trusted identity a listener receives, the
 * ways a guard denies or withholds an upstream result, and every pathway that
 * reaches the guarded executor.
 */
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolDispatchExecution, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createMcpToolDefinition, publicToolName, syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { McpToolCallEvent, ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** Minimal MCP client double: the bridge only lists tools and calls them. */
function createMockClient(tools: MockTool[], result: JsonValue = { content: [{ type: 'text', text: 'upstream' }] }) {
  const listTools = vi.fn(async (): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: { name: string; arguments: unknown }, _options?: unknown,
  ): Promise<JsonValue> => structuredClone(result))
  return {
    listTools,
    callTool,
    getServerCapabilities: (): object => ({ tools: {} }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const bridgeOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

/** Execute one registered public tool name in the native pathway. */
function call(ctx: Context, name: string, args: unknown = {}) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(name),
    name,
    arguments: args,
  })
}

/** One upstream tool registered straight from the plugin bridge under a fixed server. */
function registerDirect(ctx: Context, serverName: string, rawName = 'thing'): ToolDefinition {
  const definition = createMcpToolDefinition(ctx, {
    name: `mcp__${serverName}__${rawName}`,
    serverName,
    rawName,
    description: 'Direct fixture.',
    inputSchema: { type: 'object' },
    call: async () => ({ content: [{ type: 'text', text: 'upstream' }] }),
  })
  ctx.tools.register(definition)
  return definition
}

describe('guard identity', () => {
  it('reports the trusted serverName and rawName for a normalized public name', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'admin.reset', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, { ...bridgeOpts, serverName: 'trusted' }, new Map())
    const guarded: McpToolCallEvent[] = []
    const executions: ToolDispatchExecution[] = []
    ctx.on('mcp/tool-call', (payload, next) => {
      guarded.push(payload)
      return next()
    })
    ctx.on('tools/execute', (exec, next) => {
      executions.push(exec)
      return next()
    })

    const result = await call(ctx, publicToolName('trusted', 'admin.reset'))

    expect(result.isError).toBe(false)
    expect(guarded).toHaveLength(1)
    expect(guarded[0]?.serverName).toBe('trusted')
    expect(guarded[0]?.rawName).toBe('admin.reset')
    // The exact execution, not a copy: identity and cancellation stay registry-owned.
    expect(guarded[0]?.execution).toBe(executions[0])
    expect(client.callTool).toHaveBeenCalledWith({ name: 'admin.reset', arguments: {} }, expect.anything())
  })

  it('keeps the declared serverName when the public name names another server', async () => {
    const ctx = await mountRegistry()
    const guarded: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', (payload, next) => {
      guarded.push(payload)
      return next()
    })
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'mcp__impostor__thing',
      serverName: 'trusted',
      rawName: 'thing',
      description: 'Renamed fixture.',
      inputSchema: { type: 'object' },
      call: async () => ({ content: [{ type: 'text', text: 'upstream' }] }),
    }))

    expect((await call(ctx, 'mcp__impostor__thing')).isError).toBe(false)
    expect(guarded[0]).toMatchObject({ serverName: 'trusted', rawName: 'thing' })
  })

  it('keeps colliding truncated public names apart by their raw identity', async () => {
    const ctx = await mountRegistry()
    const long = 'a'.repeat(80)
    const longer = `${'a'.repeat(79)}b`
    const client = createMockClient([
      { name: long, inputSchema: { type: 'object' } },
      { name: longer, inputSchema: { type: 'object' } },
    ])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    const guarded: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', (payload, next) => {
      guarded.push(payload)
      return next()
    })
    const first = publicToolName('srv', long)
    const second = publicToolName('srv', longer)
    // Both names lose characters to the 64-character contract and share the truncated prefix.
    expect(first.slice(0, 51)).toBe(second.slice(0, 51))
    expect(first).not.toBe(second)

    await call(ctx, first)
    await call(ctx, second)

    expect(guarded.map(payload => payload.rawName)).toEqual([long, longer])
    expect(guarded.map(payload => payload.serverName)).toEqual(['srv', 'srv'])
    expect(client.callTool.mock.calls.map(([params]) => params?.name)).toEqual([long, longer])
  })
})

describe('guard decisions', () => {
  it('denies the upstream request when a guard throws before delegating', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    ctx.on('mcp/tool-call', () => { throw new Error('blocked by policy') })

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('blocked by policy')
  })

  it('denies the upstream request when a guard supplies a result without delegating', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    ctx.on('mcp/tool-call', () => Promise.resolve({ content: [{ type: 'text', text: 'answered locally' }] }))

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      isError: false,
      value: { content: [{ type: 'text', text: 'answered locally' }] },
      content: [{ type: 'text', text: 'answered locally' }],
    })
  })

  it('withholds an upstream result a guard rejects after awaiting it', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }], { content: [{ type: 'text', text: 'secret' }] })
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    ctx.on('mcp/tool-call', async (_payload, next) => {
      await next()
      throw new Error('result withheld')
    })

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('result withheld')
    expect(JSON.stringify(result.content)).not.toContain('secret')
  })

  it('accepts a replacement result a guard returns after awaiting the upstream call', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }], { content: [{ type: 'text', text: 'original' }] })
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    ctx.on('mcp/tool-call', async (_payload, next) => {
      await next()
      return { content: [{ type: 'text', text: 'redacted' }] }
    })

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'redacted' }] })
  })

  it('leaves an unguarded call unchanged', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'upstream' }] })
  })
})

describe('upstream dispatch outcome', () => {
  it.each(['response', 'protocol error', 'invalid response', 'timeout', 'disconnect', 'pre-dispatch denial',
    'pre-dispatch cancellation', 'post-response denial'] as const)(
    'reports %s independently of acceptance and cancellation', async (outcome) => {
      const ctx = await mountRegistry()
      const controller = new AbortController()
      const upstream = vi.fn(async (): Promise<unknown> => {
        expect(controller.signal.aborted).toBe(false)
        if (outcome === 'timeout' || outcome === 'disconnect') throw new Error(outcome)
        if (outcome === 'invalid response') return []
        return { content: [{ type: 'text', text: 'upstream' }], isError: outcome === 'protocol error' }
      })
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'outcome', serverName: 'srv', rawName: 'echo', description: 'Outcome fixture.',
        inputSchema: { type: 'object' }, call: upstream,
      }))
      const events: McpToolCallEvent[] = []
      ctx.on('mcp/tool-call', async (event, next) => {
        events.push(event)
        expect(event.dispatchStatus).toBe('pending')
        if (outcome === 'pre-dispatch denial') throw new Error('denied')
        if (outcome === 'pre-dispatch cancellation') controller.abort()
        const result = await next()
        expect(event.dispatchStatus).toBe('responded')
        if (outcome === 'post-response denial') throw new Error('withheld')
        return result
      })
      const result = await ctx.tools.execute({ signal: controller.signal, callId: ToolCallId('outcome'),
        name: 'outcome', arguments: {} })
      const expected = outcome.startsWith('pre-dispatch') ? 'pending'
        : outcome === 'timeout' || outcome === 'disconnect' ? 'dispatched' : 'responded'
      expect(events[0]?.dispatchStatus).toBe(expected)
      expect(upstream).toHaveBeenCalledTimes(expected === 'pending' ? 0 : 1)
      expect(result.isError).toBe(outcome !== 'response')
      expect(controller.signal.aborted).toBe(outcome === 'pre-dispatch cancellation')
    },
  )

  it.each([
    'sequential', 'concurrent', 'rejected upstream', 'rediscovered definition', 'reloaded module', 'pre-dispatch denial',
  ] as const)(
    'allows one upstream entry per exact registry invocation after %s body delegation', async (mode) => {
      const ctx = await mountRegistry()
      const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'upstream' }] }))
      if (mode === 'rejected upstream') upstream.mockRejectedValueOnce(new Error('unknown upstream outcome'))
      let factory = createMcpToolDefinition
      const define = () => factory(ctx, {
        name: 'mcp__srv__thing', serverName: 'srv', rawName: 'thing', description: 'Direct fixture.',
        inputSchema: { type: 'object' }, call: upstream,
      })
      let dispose = ctx.tools.register(define())
      const events: McpToolCallEvent[] = []
      let veto = mode === 'pre-dispatch denial'
      ctx.on('mcp/tool-call', (event, next) => {
        events.push(event)
        if (veto) { veto = false; throw new Error('pre-dispatch guard denial') }
        if (event.dispatchStatus !== 'pending') {
          expect(() => { event.addCancellation(new AbortController().signal) })
            .toThrow('MCP cancellation must be registered before upstream dispatch')
        }
        return next()
      })
      ctx.on('tools/execute', async (_exec, next) => {
        if (mode === 'concurrent') {
          const [, second] = await Promise.all([next(), next()])
          return second
        }
        await next()
        if (mode === 'rediscovered definition' || mode === 'reloaded module') {
          dispose()
          if (mode === 'reloaded module') {
            vi.resetModules()
            factory = (await import('@deepseek-ai/dsh-mcp-client/src/tools.ts')).createMcpToolDefinition
            expect(factory).not.toBe(createMcpToolDefinition)
          }
          dispose = ctx.tools.register(define())
        }
        return next()
      })
      const result = await call(ctx, 'mcp__srv__thing')
      expect(upstream).toHaveBeenCalledOnce()
      expect(result.isError).toBe(mode !== 'pre-dispatch denial')
      if (result.isError) expect(result.error.message).toContain('only one upstream request')
      expect(events.map(event => event.dispatchStatus)).toEqual(mode === 'rejected upstream'
        ? ['dispatched', 'dispatched'] : ['responded', 'responded'])
      expect(events[0]?.execution).toBe(events[1]?.execution)
      await call(ctx, 'mcp__srv__thing')
      expect(upstream).toHaveBeenCalledTimes(2)
    },
  )

  it('retains the spent upstream allowance across owning-fiber replacement', async () => {
    const ctx = await mountRegistry()
    const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'upstream' }] }))
    const mount = () => ctx.plugin({
      name: 'mcp-upstream-owner-fixture', inject: ['tools'],
      apply: (owner: Context) => {
        owner.tools.register(createMcpToolDefinition(owner, {
          name: 'owned', serverName: 'srv', rawName: 'echo', description: 'Owned fixture.',
          inputSchema: { type: 'object' }, call: upstream,
        }))
      },
    })
    let fiber = mount()
    await fiber
    ctx.on('tools/execute', async (_exec, next) => {
      await next()
      await fiber.dispose()
      expect(ctx.tools.get('owned')).toBeUndefined()
      fiber = mount()
      await fiber
      return next()
    })
    const result = await call(ctx, 'owned')
    expect(upstream).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('only one upstream request')
    await call(ctx, 'owned')
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('rejects saved delegation after a local veto without consuming a fresh body entry', async () => {
    const ctx = await mountRegistry()
    const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'upstream' }] }))
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'deferred', serverName: 'srv', rawName: 'echo', description: 'Deferred fixture.',
      inputSchema: { type: 'object' }, call: upstream,
    }))
    const events: McpToolCallEvent[] = []
    let retained: (() => Promise<unknown>) | undefined
    ctx.on('mcp/tool-call', async (event, next) => {
      events.push(event)
      if (retained === undefined) {
        retained = next
        return { content: [{ type: 'text', text: 'guard-owned local result' }] }
      }
      return next()
    })
    ctx.on('tools/execute', async (_exec, next) => {
      const local = await next()
      expect(local.isError).toBe(false)
      if (retained === undefined) throw new Error('guard did not retain delegation')
      await expect(retained()).rejects.toThrow('only one upstream request')
      expect(upstream).not.toHaveBeenCalled()
      expect(events[0]?.dispatchStatus).toBe('pending')
      return next()
    })
    expect((await call(ctx, 'deferred')).isError).toBe(false)
    expect(upstream).toHaveBeenCalledOnce()
    expect(events.map(event => event.dispatchStatus)).toEqual(['responded', 'responded'])
    expect(events[0]?.execution).toBe(events[1]?.execution)
  })

  it('retains dispatched uncertainty when a guard attempts a second upstream request after rejection', async () => {
    const ctx = await mountRegistry()
    const upstream = vi.fn(async () => { throw new Error('transport lost') })
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'once', serverName: 'srv', rawName: 'echo', description: 'Single dispatch fixture.',
      inputSchema: { type: 'object' }, call: upstream,
    }))
    const events: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', async (event, next) => {
      events.push(event)
      await expect(next()).rejects.toThrow('transport lost')
      return next()
    })
    const result = await call(ctx, 'once')
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(events[0]?.dispatchStatus).toBe('dispatched')
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('only one upstream request')
  })
})

describe('guard cancellation', () => {
  it('skips the upstream request a guard revokes the signal for', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    const controller = new AbortController()
    ctx.on('mcp/tool-call', (_payload, next) => {
      controller.abort()
      return next()
    })

    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('canceled-before'),
      name: 'mcp__srv__echo',
      arguments: {},
    })

    expect(client.callTool).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('the tool call was canceled before the upstream MCP request')
  })

  it('withholds an upstream result when a guard revokes the signal while awaiting it', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    const controller = new AbortController()
    ctx.on('mcp/tool-call', async (_payload, next) => {
      const value = await next()
      controller.abort()
      return value
    })

    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('canceled-after'),
      name: 'mcp__srv__echo',
      arguments: {},
    })

    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('the tool call was canceled before its upstream MCP result was accepted')
  })
})

describe('guard-owned revocation', () => {
  it.each(['caller', 'first guard', 'second guard'] as const)('retains %s cancellation when later guards add live signals', async (source) => {
    const ctx = await mountRegistry()
    const caller = new AbortController()
    const first = new AbortController()
    const second = new AbortController()
    const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: 'upstream' }] }))
    const definition = createMcpToolDefinition(ctx, {
      name: 'revocable', serverName: 'srv', rawName: 'echo', description: 'Revocation fixture.',
      inputSchema: { type: 'object' }, call: upstream,
    })
    ctx.tools.register(definition)
    ctx.on('mcp/tool-call', (event, next) => {
      event.addCancellation(first.signal)
      return next()
    })
    ctx.on('mcp/tool-call', (event, next) => {
      event.addCancellation(second.signal)
      const controller = source === 'caller' ? caller : source === 'first guard' ? first : second
      controller.abort()
      expect(event.signal.aborted).toBe(true)
      return next()
    })

    const result = await ctx.tools.execute({
      signal: caller.signal, callId: ToolCallId('revocable'), name: definition.name, arguments: {},
    })

    expect(upstream).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('the tool call was canceled before the upstream MCP request')
    expect(caller.signal.aborted).toBe(source === 'caller')
  })

  it.each(['registry', 'direct', 'nested'] as const)('aborts the %s upstream request and withholds its late result without changing caller identity', async (pathway) => {
    const ctx = await mountRegistry()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const settled: PromiseWithResolvers<void> = Promise.withResolvers()
    onTestFinished(() => { settled.resolve() })
    const caller = new AbortController()
    const revocation = new AbortController()
    let holding = false
    const upstream = vi.fn(async (_args: Record<string, unknown>, exec: ToolExecution) => {
      if (holding) {
        expect(exec.signal).not.toBe(caller.signal)
        expect(exec.agent).toBeUndefined()
        entered.resolve()
        await settled.promise
        expect(exec.signal.aborted).toBe(true)
      }
      return { content: [{ type: 'text', text: 'private result' }] }
    })
    const definition = createMcpToolDefinition(ctx, {
      name: 'revocable', serverName: 'srv', rawName: 'echo', description: 'Revocation fixture.',
      inputSchema: { type: 'object' }, call: upstream,
    })
    ctx.tools.register(definition)
    const executions: ToolDispatchExecution[] = []
    ctx.on('tools/execute', (exec, next) => { executions.push(exec); return next() })
    await call(ctx, definition.name)
    const parent = executions[0]!
    const events: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', (event, next) => {
      events.push(event)
      event.addCancellation(revocation.signal)
      return next()
    })
    holding = true
    const direct: ToolRunContext = {
      ...parent, signal: caller.signal, deferContext: () => {}, concludeTurn: () => {},
    }
    const executing = pathway === 'direct'
      ? definition.execute({}, direct).then(value => ({ value }), (error: unknown) => ({ error }))
      : ctx.tools.execute({
        signal: caller.signal, callId: ToolCallId('revoked'), name: definition.name, arguments: {},
        ...(pathway === 'nested' ? { parent: parent.token, rootCallId: parent.rootCallId } : {}),
      })
    await entered.promise
    expect(events[0]?.execution).toBe(pathway === 'direct' ? direct : executions.at(-1))
    expect(events[0]?.execution.signal).toBe(caller.signal)
    revocation.abort()
    expect(events[0]?.signal.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    settled.resolve()
    const result = await executing

    expect(result).toMatchObject({ error: { message: 'the tool call was canceled before its upstream MCP result was accepted' } })
    expect('value' in result).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private result')
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('passes guard revocation through the MCP client callback', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    const revocation = new AbortController()
    ctx.on('mcp/tool-call', async (event, next) => {
      event.addCancellation(revocation.signal)
      const result = await next()
      revocation.abort()
      return result
    })

    const result = await call(ctx, 'mcp__srv__echo')

    expect(client.callTool).toHaveBeenCalledTimes(1)
    expect(client.callTool.mock.calls[0]?.[1]).toHaveProperty('signal.aborted', true)
    expect(result.isError).toBe(true)
  })

  it('rejects adding cancellation after dispatch and after a local veto settles', async () => {
    const ctx = await mountRegistry()
    const definition = registerDirect(ctx, 'srv')
    let retained: McpToolCallEvent | undefined
    const delegated = ctx.on('mcp/tool-call', async (event, next) => {
      retained = event
      await next()
      event.addCancellation(new AbortController().signal)
      return { content: [] }
    })

    const result = await call(ctx, definition.name)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('MCP cancellation must be registered before upstream dispatch')
    expect(() => retained?.addCancellation(new AbortController().signal)).toThrow('MCP cancellation must be registered before upstream dispatch')
    delegated()
    ctx.on('mcp/tool-call', async (event) => { retained = event; return { content: [] } })
    expect((await call(ctx, definition.name)).isError).toBe(false)
    expect(() => retained?.addCancellation(new AbortController().signal)).toThrow('MCP cancellation must be registered before upstream dispatch')
  })
})

describe('guarded pathways', () => {
  it('guards a direct definition.execute call outside the registry', async () => {
    const ctx = await mountRegistry()
    const definition = registerDirect(ctx, 'srv')
    const executions: ToolDispatchExecution[] = []
    ctx.on('tools/execute', (exec, next) => {
      executions.push(exec)
      return next()
    })
    const guarded: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', (payload, next) => {
      guarded.push(payload)
      return next()
    })

    expect((await call(ctx, definition.name)).isError).toBe(false)
    const dispatched = executions[0]!
    expect(guarded[0]?.execution).toBe(dispatched)

    // The registry's live run context is not reachable from outside, so the
    // direct-call stand-in keeps the dispatch identity and adds the two
    // registry-owned members the run context type requires.
    const direct: ToolRunContext = { ...dispatched, deferContext: () => {}, concludeTurn: () => {} }
    const denial = ctx.on('mcp/tool-call', () => { throw new Error('direct execute denied') })
    try {
      await expect(definition.execute({}, direct)).rejects.toThrow('direct execute denied')
    } finally {
      denial()
    }

    await expect(definition.execute({}, direct)).resolves.toEqual({ content: [{ type: 'text', text: 'upstream' }] })
    expect(guarded).toHaveLength(3)
    expect(guarded[2]?.execution).toBe(direct)
    expect(guarded[2]).toMatchObject({ serverName: 'srv', rawName: 'thing' })
  })

  it('guards the nested dispatch shape PTC mode uses', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'echo', inputSchema: { type: 'object' } }])
    await syncTools(client as never, ctx, bridgeOpts, new Map())
    const outer: ToolDispatchExecution[] = []
    ctx.tools.register({
      name: 'outer',
      description: 'Enclosing call.',
      parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'outer' }] },
      execute: async () => true,
    })
    ctx.on('tools/execute', (exec, next) => {
      if (exec.name === 'outer') outer.push(exec)
      return next()
    })
    await call(ctx, 'outer')
    const parent = outer[0]!
    const guarded: McpToolCallEvent[] = []
    ctx.on('mcp/tool-call', (payload, next) => {
      guarded.push(payload)
      return next()
    })
    const nested = (suffix: string) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`${String(parent.callId)}:ptc:${suffix}`),
      rootCallId: parent.rootCallId,
      name: 'mcp__srv__echo',
      arguments: {},
      parent: parent.token,
    })

    expect((await nested('1')).isError).toBe(false)
    expect(guarded).toHaveLength(1)
    expect(guarded[0]).toMatchObject({ serverName: 'srv', rawName: 'echo' })

    const denial = ctx.on('mcp/tool-call', () => { throw new Error('nested dispatch denied') })
    try {
      const result = await nested('2')
      expect(result.isError).toBe(true)
      if (result.isError) expect(result.error.message).toBe('nested dispatch denied')
    } finally {
      denial()
    }
    expect(client.callTool).toHaveBeenCalledTimes(1)
  })

  it('removes the guard with its owning fiber and keeps guarding fresh registrations', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([{ name: 'first', inputSchema: { type: 'object' } }])
    let disposers = await syncTools(client as never, ctx, bridgeOpts, new Map())
    const grouped: string[] = []
    const fiber = ctx.plugin({
      name: 'guard-owner',
      apply(inner: Context) {
        inner.on('mcp/tool-call', (payload, next) => {
          grouped.push(payload.rawName)
          return next()
        })
      },
    })
    await fiber

    await call(ctx, 'mcp__srv__first')
    expect(grouped).toEqual(['first'])

    // A re-sync registers a fresh definition; the same listener still guards it.
    client.listTools.mockResolvedValue({ tools: [{ name: 'second', inputSchema: { type: 'object' } }], nextCursor: undefined })
    disposers = await syncTools(client as never, ctx, bridgeOpts, disposers)
    expect(disposers.size).toBe(1)
    await call(ctx, 'mcp__srv__second')
    expect(grouped).toEqual(['first', 'second'])

    await fiber.dispose()
    expect((await call(ctx, 'mcp__srv__second')).isError).toBe(false)
    expect(grouped).toEqual(['first', 'second'])
    expect(client.callTool).toHaveBeenCalledTimes(3)
  })
})
