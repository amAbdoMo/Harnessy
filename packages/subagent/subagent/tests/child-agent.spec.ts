import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { WIDER_MODES } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  captureDelegatedPolicyOverrides,
  narrowSandboxMode,
  resolveChildAgentOptions,
} from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * A parent whose sandbox-policy service resolves `effective` and reports
 * `override` as the session's explicit mode. Omit the service entirely to model
 * a deployment that enforces no sandbox.
 */
function policyParent(options: {
  effective?: SandboxMode
  override?: SandboxMode
  approval?: boolean
  withoutPolicy?: boolean
} = {}): Agent {
  const agent = parentAgent()
  const sandboxPolicy = {
    resolve: () => ({ mode: options.effective ?? 'read-only', workspaceRoot: '/workspace' }),
    overrideOf: (): SandboxMode | undefined => options.override,
  }
  Object.assign(agent, {
    ctx: {
      get: (name: string) => {
        if (name === 'sandboxPolicy') return options.withoutPolicy === true ? undefined : sandboxPolicy
        if (name === 'approval') {
          return options.approval === true ? { overrideOf: (): undefined => undefined } : undefined
        }
        return undefined
      },
    },
  })
  return agent
}

describe('narrowSandboxMode', () => {
  it('returns the narrower mode and never widens', () => {
    expect(narrowSandboxMode('danger-full-access', 'read-only')).toBe('read-only')
    expect(narrowSandboxMode('read-only', 'danger-full-access')).toBe('read-only')
    expect(narrowSandboxMode('workspace-write', 'workspace-write')).toBe('workspace-write')
    expect(narrowSandboxMode('read-only', 'workspace-write')).toBe('read-only')
    expect(narrowSandboxMode('workspace-write', 'danger-full-access')).toBe('workspace-write')
  })

  it('agrees with the escalation ladder about which mode is wider', () => {
    for (const outer of MODES) {
      for (const inner of MODES) {
        if (outer === inner) continue
        const escalatesOutward = (WIDER_MODES[outer] ?? []).includes(inner)
        // `inner` is strictly wider than `outer`, so the narrower of the pair is `outer`.
        expect(narrowSandboxMode(outer, inner)).toBe(escalatesOutward ? outer : inner)
      }
    }
  })
})

describe('captureDelegatedPolicyOverrides', () => {
  it("records the parent override verbatim for the default 'inherit' access", () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ override: 'workspace-write' }))).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: undefined,
    })
  })

  it("records nothing for 'inherit' without a parent override", () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ effective: 'workspace-write' }))).toEqual({
      sandboxMode: undefined,
      approvalPolicy: undefined,
    })
  })

  it("treats an explicit 'inherit' exactly as an omitted access", () => {
    const parent = policyParent({ override: 'danger-full-access' })
    expect(captureDelegatedPolicyOverrides(parent, 'inherit'))
      .toEqual(captureDelegatedPolicyOverrides(parent))
  })

  it('narrows the parent effective mode, including a deployment default with no override', () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ effective: 'workspace-write' }), 'read-only'))
      .toEqual({ sandboxMode: 'read-only', approvalPolicy: undefined })
  })

  it('prevents a child from widening a full-access parent', () => {
    const parent = policyParent({ effective: 'danger-full-access', override: 'danger-full-access' })
    expect(captureDelegatedPolicyOverrides(parent, 'read-only')).toMatchObject({ sandboxMode: 'read-only' })
    expect(captureDelegatedPolicyOverrides(parent, 'workspace-write')).toMatchObject({ sandboxMode: 'workspace-write' })
  })

  it('keeps the parent mode when the requested access is wider', () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ effective: 'read-only' }), 'danger-full-access'))
      .toMatchObject({ sandboxMode: 'read-only' })
  })

  it('still pins approval regardless of the requested access', () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ effective: 'read-only', approval: true }), 'read-only'))
      .toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
  })

  it('records a requested access verbatim when no sandbox policy is composed', () => {
    expect(captureDelegatedPolicyOverrides(policyParent({ withoutPolicy: true }), 'workspace-write'))
      .toEqual({ sandboxMode: 'workspace-write', approvalPolicy: undefined })
  })
})
