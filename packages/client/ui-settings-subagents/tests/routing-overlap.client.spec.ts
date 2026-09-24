import { describe, expect, it } from 'vitest'
import type { SubagentDefinition } from '@deepseek-ai/dsh-api-remotes/client'
import { routingOverlaps } from '../src/client/routing-overlap.ts'

function role(name: string, guidance: string, invocation: SubagentDefinition['invocation'] = 'automatic'): SubagentDefinition {
  return {
    id: name.toLowerCase(),
    name,
    enabled: true,
    purpose: guidance,
    whenToUse: guidance,
    invocation,
    model: { mode: 'fixed' },
    access: 'read-only',
    instructions: '',
    execution: { backend: 'spawn', background: 'auto' },
  }
}

describe('automatic role routing overlap', () => {
  it('reports substantially shared routing guidance', () => {
    expect(routingOverlaps([
      role('Code', 'Implement scoped workspace code changes'),
      role('Architecture', 'Plan scoped workspace code changes'),
    ])).toEqual([{ first: 'Code', second: 'Architecture' }])
  })

  it('ignores distinct, disabled, and ask-first roles', () => {
    const disabled = { ...role('Disabled', 'Implement scoped workspace code changes'), enabled: false }
    expect(routingOverlaps([
      role('Code', 'Implement scoped workspace code changes'),
      role('Research', 'Compare external documentation and evidence'),
      role('Review', 'Implement scoped workspace code changes', 'ask-first'),
      disabled,
    ])).toEqual([])
  })
})
