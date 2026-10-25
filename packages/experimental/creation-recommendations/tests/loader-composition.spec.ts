/** Real Loader composition of the card service and this kind with a scripted model, package installation and HMR. */
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { symlinksUsable } from '@deepseek-ai/dsh-platform-probe'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, loadProfileDirectory, readProfilePatches, readProfileManifest, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as ActionCards from '@deepseek-ai/dsh-experimental-action-cards'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Recommendations from '../src/index.ts'
import { RESULT_TEXT, writeBundle } from './fixture.ts'

it.each(['portable-bundle', 'foreign-nested-row'] as const)('validates and installs through pnpm/HMR: %s', async (scenario) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-creation-loader-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  const base = join(home, 'fixture-base')
  const anchor = join(home, 'package.json')
  await mkdir(base)
  await writeFile(anchor, JSON.stringify({ name: 'installation', dependencies: {} }))
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'fixture-base', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(base, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    ['session', 'sessions'], ['projection', 'projections'], ['llm', 'llm'], ['prompt', 'prompt'], ['tools', 'tools'],
    ['fs', 'fs'], ['working-directory', 'workingDirectory'], ['skills', 'skills'], ['tool-skill', 'toolSkill'],
    ['agents', 'agents'], ['manager', 'manager'], ['action-cards', 'actionCards'], ['recommendations', 'recommendations'],
  ].map(([id, name]) => ({ id, name: 'cordis:' + name! })) }]))
  initProfile(dir, ['fixture-base'])
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  await writeFile(manifestPath, JSON.stringify({ ...manifest, dependencies: { 'fixture-base': 'file:' + base } }))
  await mkdir(join(dir, 'node_modules'))
  await symlink(base, join(dir, 'node_modules', 'fixture-base'), 'junction')
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, home, cwd: home, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor,
    startedBundles: loadProfileDirectory('test', dir, anchor).layers.map(layer => layer.packageName),
    overlays: [], telemetryDisabledEnv: undefined,
  }
  const starts: SubagentStartRequest[] = []
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
    ctx.provide('subagents', { start: async (provider: string, spec: SubagentStartRequest): Promise<SubagentRun> => {
      expect(provider).toBe('spawn')
      starts.push(spec)
      const instructions = JSON.parse(spec.prompt.find(block => block.type === 'text')!.text) as { packageName: string }
      await writeBundle(spec.childSetup!.cwd, instructions.packageName)
      if (scenario === 'foreign-nested-row') {
        await writeFile(join(spec.childSetup!.cwd, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
          id: instructions.packageName + ':group', name: instructions.packageName, group: true,
          config: [{ id: 'manager', name: instructions.packageName }],
        }] }]))
      } else if (symlinksUsable()) {
        await rename(join(spec.childSetup!.cwd, 'index.js'), join(spec.childSetup!.cwd, 'runtime.mjs'))
        await symlink('./runtime.mjs', join(spec.childSetup!.cwd, 'index.js'))
      }
      return { localAgent: undefined, id: spec.childSetup!.sessionId, dispose: async () => {},
        result: Promise.resolve({ output: [], stopReason: 'completed', structured: { ready: true } }) }
    } })
    Object.assign(ctx.loader.builtins, { sessions: Sessions, projections: Projections, llm: Llm, prompt: SystemPrompt, tools: Tools,
      fs: FsLocal, workingDirectory: WorkingDirectory, skills: Skills, toolSkill: SkillTool, agents: Agents,
      manager: PluginManager, actionCards: ActionCards, recommendations: Recommendations })
  })
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await ctx.hmr.runExclusive(async () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  const callId = ToolCallId('call-card')
  const adapter = new MockAdapter([
    toolCallResponse('call-skill', 'skill', { name: 'personalized-pages' }),
    toolCallResponse('call-card', 'propose_action', { action: 'create_personalized_page', title: 'Counter',
      brief: 'Keep a counter in the right sidebar.', details: { slot: 'sidebar-right' } }),
    textResponse('After you click Create below, I will build it in the background.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('creation-live'), { provider: 'mock', model: 'mock' }, { cwd: home })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'I want a counter that stays visible.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
  // The card tool is declared only from the step after the card skill loaded; the addition is logged.
  const declared = adapter.requests.map(request => (request.tools ?? []).some(tool => tool.name === 'propose_action'))
  expect(declared).toEqual([false, true, true])
  expect(agent.session.snapshotEvents().flatMap(event => event.type === 'developer/message' ? event.data.message.content : []))
    .toContainEqual({ type: 'tool-addition', toolName: 'propose_action' })
  const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  expect(results.map(message => message.isError === true)).toEqual([false, false])
  expect(results[1]?.content).toEqual([{ type: 'text', text: RESULT_TEXT }])
  const receipt = () => ctx.actionCards.view(agent.session).decisions[callId]
  expect(ctx.actionCards.view(agent.session).proposals[callId]).toMatchObject({ action: 'create_personalized_page', title: 'Counter' })
  expect(starts).toHaveLength(0)
  const access = [...ctx.loader.entries()].find(entry => entry.options.id === 'manager')
  expect(await ctx.actionCards.act(agent, callId, 'create', { slot: 'page' })).toEqual({ status: 'accepted' })
  if (scenario === 'foreign-nested-row') {
    await vi.waitFor(() => { expect(receipt()?.phase).toBe('failed') })
    expect([...ctx.loader.entries()].find(entry => entry.options.id === 'manager')).toBe(access)
    expect(access?.options.name).toBe('cordis:manager')
    expect(access?.fiber).toBeDefined()
    expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['fixture-base'])
    return
  }
  await vi.waitFor(() => { expect(receipt()?.phase).toBe('installed') }, { timeout: 20_000 })
  expect(receipt()?.data?.application).toBe('applied')
  expect(starts[0]?.childSetup?.agentPreset).toBe('cordis')
  expect(starts[0]?.childSetup?.cwd.startsWith(join(home, '.dsh-created-plugins'))).toBe(true)
  await rm(starts[0]!.childSetup!.cwd, { recursive: true })
  const name = receipt()?.data?.bundleName
  if (typeof name !== 'string') throw new Error('the installed card records no bundle name')
  await ctx.pluginManager.setBundleEnabled(name, false)
  expect((await ctx.pluginManager.setBundleEnabled(name, true)).application).toBe('applied')
  const live = () => [...ctx.loader.entries()].find(entry => entry.options.id === name + ':counter')?.fiber
  expect(live()).toBeDefined()
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain(name)
  await ctx.actionCards.act(agent, callId, 'keep')
  expect(receipt()?.phase).toBe('kept')
  expect(live()).toBeDefined()
  await ctx.actionCards.act(agent, callId, 'undo')
  expect(receipt()?.phase).toBe('removed')
  expect(live()).toBeUndefined()
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['fixture-base'])
  expect((await ctx.pluginManager.listBundles()).find(bundle => bundle.name === name)?.installed).not.toBe(true)
  const feature = [...ctx.loader.entries()].find(entry => entry.options.id === 'recommendations')
  expect(feature?.fiber).toBeDefined()
  await feature!.fiber!.dispose()
  expect(await ctx.skills.list()).toEqual([])
  expect(await ctx.actionCards.act(agent, callId, 'restore')).toEqual({ status: 'refused', reason: 'unavailable' })
}, 30_000)
