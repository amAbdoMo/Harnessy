import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import OpenAIAccountController from '../src/openai-account.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const PiAiSettings = z.object({ providers: z.dict(z.object({})).default({}) })

async function boot(openUrl = vi.fn(async () => {})) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(MemorySettings)
  ctx.settings.register('llm-pi-ai', PiAiSettings)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(OpenAIAccountController, { openUrl })
  return { ctx, controller: ctx.openAIAccountController, openUrl }
}

describe('the OpenAI account Remote namespace', () => {
  it('reports unavailable without the authorization composition', async () => {
    const ctx = new Context()
    await ctx.plugin(OpenAIAccountController)
    expect(await ctx.openAIAccountController.describe()).toEqual({
      available: false, configured: false, inFlight: false, writable: false,
    })
    const failure = await ctx.openAIAccountController.signIn(new AbortController().signal)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'openai-account/unavailable' })
  })

  it('owns the expected Remote methods', async () => {
    const { controller } = await boot()
    expect(remoteMethods(controller)).toEqual([
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'signIn', invocation: { kind: 'direct' } },
      { method: 'signOut', invocation: { kind: 'direct' } },
    ])
  })

  it('opens secure browser OAuth, stores no token on the wire, and activates Codex', async () => {
    const { ctx, controller, openUrl } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        expect(await session.prompt({
          kind: 'select',
          message: 'Select login method',
          options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code' }],
        })).toBe('browser')
        session.notify({ message: 'Continue in browser', url: 'https://auth.openai.com/oauth/authorize' })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
          kind: 'grant', payload: { access: 'must-stay-local' },
        }))
      },
    })

    expect(await controller.describe()).toEqual({
      available: true, configured: false, inFlight: false, writable: true,
    })
    expect(await controller.signIn(new AbortController().signal)).toEqual({ status: 'authorized' })
    expect(openUrl).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/authorize', expect.any(AbortSignal),
    )
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value)
      .toEqual({ providers: { 'openai-codex': {} } })
    const described = await controller.describe()
    expect(described.configured).toBe(true)
    expect(JSON.stringify(described)).not.toContain('must-stay-local')
  })

  it('ignores progress notices that do not carry a browser destination', async () => {
    const { ctx, controller, openUrl } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        session.notify({ message: 'Preparing secure sign-in' })
        await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
          kind: 'grant', payload: { access: 'local-only' },
        }))
      },
    })
    await expect(controller.signIn(new AbortController().signal))
      .resolves.toEqual({ status: 'authorized' })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('signs out and removes the dependent provider route', async () => {
    const { ctx, controller } = await boot()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { token: 'secret' } }))
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {} }])
    await controller.signOut()
    expect((await ctx.credentials.describeRecord(KEY)).configured).toBe(false)
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value)
      .toEqual({ providers: {} })
  })

  it('rejects a non-HTTPS destination before launching it', async () => {
    const { ctx, controller, openUrl } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        session.notify({ message: 'bad', url: 'http://example.com/login' })
      },
    })
    const failure = await controller.signIn(new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'openai-account/unavailable' })
    expect(openUrl).not.toHaveBeenCalled()
  })

  it.each(['not a URL', 'http://example.com/login'])(
    'rejects unsafe authorization destination %s before launching it',
    async (url) => {
      const { ctx, controller, openUrl } = await boot()
      ctx.authorization.registerFlow({
        key: KEY,
        label: 'OpenAI Codex',
        methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
        async run(session) {
          session.notify({ message: 'bad', url })
        },
      })
      const failure = await controller.signIn(new AbortController().signal).catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'openai-account/unavailable' })
      expect(openUrl).not.toHaveBeenCalled()
    },
  )

  it('refuses a registered flow without OAuth or browser login', async () => {
    const noOAuth = await boot()
    noOAuth.ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'api-key', label: 'API key' }],
      async run() {},
    })
    await expect(noOAuth.controller.signIn(new AbortController().signal))
      .rejects.toMatchObject({ code: 'openai-account/unavailable' })

    const noBrowser = await boot()
    noBrowser.ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        await session.prompt({
          kind: 'select', message: 'Select login method',
          options: [{ id: 'device_code', label: 'Device code' }],
        })
      },
    })
    await expect(noBrowser.controller.signIn(new AbortController().signal))
      .rejects.toMatchObject({ code: 'openai-account/unavailable' })
  })

  it('returns cancelled for a withdrawn request without activating the provider', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run() {},
    })
    const request = new AbortController()
    request.abort()
    await expect(controller.signIn(request.signal)).resolves.toEqual({ status: 'cancelled' })
    expect(ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai')?.value)
      .toEqual({ providers: {} })
  })

  it.each([false, true])('withdraws a pending browser callback prompt (own signal: %s)', async (ownSignal) => {
    const { ctx, controller } = await boot()
    const prompting = Promise.withResolvers<undefined>()
    const promptController = new AbortController()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        prompting.resolve(undefined)
        await session.prompt({
          kind: 'text', message: 'Wait for the callback',
          ...(ownSignal ? { signal: promptController.signal } : {}),
        })
      },
    })
    const request = new AbortController()
    const outcome = controller.signIn(request.signal)
    await prompting.promise
    if (ownSignal) promptController.abort()
    else request.abort()
    if (ownSignal) await expect(outcome).rejects.toThrow('browser sign-in prompt was withdrawn')
    else await expect(outcome).resolves.toEqual({ status: 'cancelled' })
  })

  it('rejects a prompt whose own signal was already withdrawn', async () => {
    const { ctx, controller } = await boot()
    const promptController = new AbortController()
    promptController.abort()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        await session.prompt({
          kind: 'text', message: 'Wait for the callback', signal: promptController.signal,
        })
      },
    })
    await expect(controller.signIn(new AbortController().signal))
      .rejects.toThrow('browser sign-in prompt was withdrawn')
  })

  it.each([
    ['ordinary error', new Error('browser unavailable'), 'openai-account/browser-failed'],
    ['non-error rejection', 'launcher refused', 'openai-account/browser-failed'],
    ['classified failure', new RemoteError('openai-account/unavailable', 'blocked', {}), 'openai-account/unavailable'],
  ])('classifies an %s from the native browser launcher', async (_label, reason, code) => {
    const { ctx, controller } = await boot(vi.fn(async () => { throw reason }))
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      async run(session) {
        session.notify({ message: 'opening', url: 'https://auth.openai.com/login' })
        await new Promise<undefined>((resolve) => {
          session.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
        })
      },
    })
    const failure = await controller.signIn(new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code })
  })

  it('reports missing credential and settings stores during sign-out', async () => {
    const empty = new Context()
    await empty.plugin(OpenAIAccountController)
    await expect(empty.openAIAccountController.signOut())
      .rejects.toMatchObject({ code: 'openai-account/unavailable' })

    const credentialsOnly = new Context()
    await credentialsOnly.plugin(MemoryCredentials)
    await credentialsOnly.plugin(OpenAIAccountController)
    await expect(credentialsOnly.openAIAccountController.signOut())
      .rejects.toMatchObject({ code: 'openai-account/unavailable' })
  })
})
