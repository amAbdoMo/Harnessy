// @vitest-environment jsdom
/** Model-seat registration with the production renderer and per-Session projection adapter. */
import { afterEach, describe, expect, it } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { apply, inject } from '../src/client/index.ts'

const codex: ModelSelection = { provider: 'openai-codex', model: 'gpt-5', reasoningEffort: 'high' }
const external: ModelSelection = { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }
const fastLabel = 'Codex fast mode on for this chat'
let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

async function setup() {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  const locale = new LocaleRuntime(rt.ctx)
  locale.setLocale('en')
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  let command: CommandContribution | undefined
  rt.ctx.provide('commandUi', {
    register(contribution: CommandContribution) {
      command = contribution
      return () => { command = undefined }
    },
  })
  rt.remote.provideNamespaces({ session: {
    modelCatalog: async () => ({ ok: true as const, value: {
      default: codex,
      routableProviders: ['openai-codex', 'openai'],
      groups: ['openai-codex', 'openai'].map(id => ({ id, name: id, models: [{
        id: 'gpt-5', name: 'GPT-5', reasoning: {
          efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high',
        },
      }] })),
      failures: [],
    } }),
    selectModel: () => { throw new Error('indicator must not change model selection') },
  } })
  await rt.declare({ 'conversation.input.model': { kind: 'single', scope: 'session' } })
  const feature = await rt.mount({ inject: [...inject], apply })
  await rt.flush()
  const add = async (id: string, preference?: boolean) => {
    const sessionId = await rt.sessions.add({ id })
    await rt.sessions.setProjection(id, 'modelSelection', { lastUsed: null, next: codex })
    if (preference !== undefined) await rt.sessions.setProjection(id, 'codexFastMode', preference)
    const reference = rt.sessions.retainFor(rt.ctx, sessionId)
    await reference.ready
    return reference
  }
  return { rt, feature, add, command: () => command }
}

function expectFast(button: HTMLElement, enabled: boolean): void {
  expect(button.getAttribute('aria-label')?.includes(fastLabel)).toBe(enabled)
  expect(button.getAttribute('title')?.includes(fastLabel)).toBe(enabled)
  expect(button.firstElementChild?.getAttribute('fill')).toBe(enabled ? 'currentColor' : 'none')
}

describe('registered composer Codex preference', () => {
  it.each([
    ['restored on', true, true],
    ['restored off', false, false],
    ['absent preference', undefined, false],
  ] as const)('renders %s from the Session projection before any history is loaded', async (_scenario, preference, visible) => {
    const { rt, add } = await setup()
    const session = await add('restored', preference)
    const slot = rt.renderSlot('conversation.input.model', { locked: false }, { session })
    const trigger = slot.view.getByRole('button', { name: /Select model, current GPT-5/ })
    expectFast(trigger, visible)
    expect(trigger.textContent).toBe('GPT-5High')
  })

  it('follows live preference and route updates without changing another chat or losing saved state', async () => {
    const { rt, add } = await setup()
    const sessionA = await add('a', true)
    const sessionB = await add('b', false)
    const slot = rt.renderSlot('conversation.input.model', { locked: false }, { session: sessionA })
    const button = () => slot.view.getByRole('button', { name: /Select model/ })
    expectFast(button(), true)

    await rt.sessions.setProjection('a', 'codexFastMode', false)
    expectFast(button(), false)
    await rt.sessions.setProjection('a', 'codexFastMode', true)
    expectFast(button(), true)
    await rt.sessions.setProjection('a', 'modelSelection', { lastUsed: codex, next: external })
    expectFast(button(), false)
    await rt.sessions.setProjection('a', 'modelSelection', { lastUsed: external, next: codex })
    expectFast(button(), true)

    slot.update({ locked: false }, { session: sessionB })
    expectFast(button(), false)
    await rt.sessions.setProjection('a', 'codexFastMode', false)
    expectFast(button(), false)
    await rt.sessions.setProjection('b', 'codexFastMode', true)
    expectFast(button(), true)
    slot.update({ locked: false }, { session: sessionA })
    expectFast(button(), false)
    await rt.sessions.setProjection('a', 'codexFastMode', true)
    expectFast(button(), true)
  })

  it('retains the indicator for a missing Codex model and removes registrations on unload', async () => {
    const { rt, feature, add, command } = await setup()
    const session = await add('missing', true)
    await rt.sessions.setProjection('missing', 'modelSelection', {
      lastUsed: null, next: { provider: 'openai-codex', model: 'removed-model' },
    })
    const slot = rt.renderSlot('conversation.input.model', { locked: false }, { session })
    expectFast(slot.view.getByRole('button', { name: /openai-codex\/removed-model/ }), true)
    await feature.dispose()
    expect(slot.view.queryByRole('button')).toBeNull()
    expect(command()).toBeUndefined()
    expect(rt.slots.entries('conversation.input.model')).toHaveLength(0)
  })
})
