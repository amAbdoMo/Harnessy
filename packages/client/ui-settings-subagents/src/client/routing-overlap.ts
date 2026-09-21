/** Similarity checks for roles the agent may invoke without asking. */

import type { SubagentDefinition } from '@deepseek-ai/dsh-api-remotes/client'

const ROUTING_STOP_WORDS = new Set([
  'agent', 'role', 'task', 'tasks', 'this', 'that', 'when', 'with', 'from', 'into',
  'use', 'using', 'work', 'should', 'receive', 'automatic', 'automatically',
])

function routingWords(role: SubagentDefinition): Set<string> {
  const words = `${role.purpose} ${role.whenToUse}`
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? []
  return new Set(words.filter(word => !ROUTING_STOP_WORDS.has(word)))
}

/** One pair of automatic roles whose routing guidance substantially overlaps. */
export interface RoutingOverlap {
  readonly first: string
  readonly second: string
}

/**
 * Find automatic roles that use substantially the same routing terms.
 *
 * The comparison requires at least two shared meaningful terms and 60% of the
 * smaller role's vocabulary, so generic words cannot create a warning alone.
 *
 * @param roles - stored role definitions.
 * @returns overlapping role-name pairs in storage order.
 */
export function routingOverlaps(roles: readonly SubagentDefinition[]): RoutingOverlap[] {
  const automatic = roles
    .filter(role => role.enabled && role.invocation === 'automatic')
    .map(role => ({ role, words: routingWords(role) }))
  const overlaps: RoutingOverlap[] = []
  for (let left = 0; left < automatic.length; left += 1) {
    for (let right = left + 1; right < automatic.length; right += 1) {
      const first = automatic[left]
      const second = automatic[right]
      if (first === undefined || second === undefined) continue
      const smaller = Math.min(first.words.size, second.words.size)
      if (smaller < 2) continue
      const shared = [...first.words].filter(word => second.words.has(word)).length
      if (shared < 2 || shared / smaller < 0.6) continue
      overlaps.push({ first: first.role.name, second: second.role.name })
    }
  }
  return overlaps
}
