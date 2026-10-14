/** Session-local, model-hidden Codex priority requests and their human command. */
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ResolvedPiAiProviderProfile } from './config.ts'

const fastModeEventData = z.object({ enabled: z.boolean() })

const fastModeProjection = {
  key: 'codexFastMode',
  stateVersion: 1,
  stateSchema: z.boolean(),
  init: () => false,
  wire: { viewSchema: z.boolean(), view: enabled => enabled },
  apply: (enabled, event) => event.type === 'llm-pi-ai/fast-mode' ? fastModeEventData.parse(event.data).enabled : enabled,
} satisfies ProjectionDefinition<'codexFastMode'>

function codexConfigured(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): boolean {
  return [...profiles.values()].some(profile => profile.piProvider?.getModels().some(model =>
    model.api === 'openai-codex-responses' && !profile.modelErrors.has(model.id),
  ))
}

function fastModeOutcome(enabled: boolean): CommandResult {
  return {
    kind: 'success',
    text: enabled
      ? 'Fast mode enabled for this chat only: subsequent Codex conversation requests ask for priority service. Usage may be higher; other providers are unchanged.'
      : 'Fast mode disabled for this chat only: subsequent Codex conversation requests do not ask for priority service. Enabling it may increase usage; other providers are unchanged.',
  }
}

async function executeFast(
  ctx: Context,
  invocation: CommandInvocation,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): Promise<CommandResult> {
  if (invocation.signal.aborted) return { kind: 'error', text: 'Fast mode change cancelled.' }
  const argument = invocation.rawInput.trim()
  if (argument !== '' && argument !== 'on' && argument !== 'off' && argument !== 'status') {
    return { kind: 'error', text: 'Usage: /fast [on|off|status]' }
  }
  if (!codexConfigured(profiles())) {
    return { kind: 'error', text: 'Fast mode is unavailable: no serviceable Codex protocol is configured. No chat preference was changed.' }
  }
  const session = invocation.agent.session
  if (ctx.sessions.get(session.id) !== session) {
    return { kind: 'error', text: 'Fast mode is unavailable: this chat is not live. No preference was changed.' }
  }
  const current = ctx.sessionProjections.stateOf(session, 'codexFastMode')
  if (current === undefined) throw new Error('llm-pi-ai: required codexFastMode projection is unavailable')
  if (argument === 'status') return fastModeOutcome(current)
  const enabled = argument === '' ? !current : argument === 'on'
  session.append('llm-pi-ai/fast-mode', { enabled }, { ignorable: true })
  await ctx.sessions.flush(session)
  return fastModeOutcome(enabled)
}

/**
 * Register the optional chat preference projection and `/fast` while their live services can serve them.
 * @param ctx - plugin context owning both registrations.
 * @param profiles - current serviceable model protocols, resolved again at command execution.
 */
export function registerFastMode(
  ctx: Context,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): void {
  ctx.inject(['sessionProjections'], (projected) => {
    projected.sessionProjections.register(fastModeProjection)
    projected.inject(['commands', 'sessionProjections', 'sessions'], (commanded) => {
      commanded.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-llm-pi-ai/fast'),
        name: 'fast',
        description: 'Toggle Codex priority service for this chat only (may increase usage)',
        input: { hint: '[on | off | status]' },
        handler: invocation => executeFast(commanded, invocation, profiles),
      })
    })
  })
}
