/**
 * The shipped role directory and run bounds a deployment starts from. Every
 * entry here is an ordinary editable definition: nothing in this package
 * privileges a built-in id, so a user may rename, disable, or delete any of
 * them, and a definition they add behaves identically.
 *
 * @module @deepseek-ai/dsh-subagent-roster/defaults
 */

import type {
  SubagentAutomaticRouting,
  SubagentDefinition,
  SubagentRunLimits,
  SubagentSettings,
} from './types.ts'

/** Provider this roster's shipped roles run on: the in-process spawn backend. */
export const DEFAULT_SUBAGENT_BACKEND = 'spawn'

/** Stored value that lets the parent size each independent delegation batch. */
export const ADAPTIVE_SUBAGENT_CONCURRENCY = 'adaptive' as const

/** Concurrency policy used when the user changes nothing. */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT_RUNS = ADAPTIVE_SUBAGENT_CONCURRENCY

/** Wall-clock bound for one delegation when the user changes nothing. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 3_600_000

/** Largest concurrency cap the settings schema and adaptive policy accept. */
export const MAX_SUBAGENT_CONCURRENT_RUNS = 16

/** Explicit route selection is off until the user authorizes routes. */
export const DEFAULT_SUBAGENT_AUTOMATIC_ROUTING: SubagentAutomaticRouting = {
  enabled: false,
  allowedModels: [],
}

/** Run bounds a fresh install starts from. */
export const DEFAULT_SUBAGENT_LIMITS: SubagentRunLimits = {
  maxConcurrentRuns: DEFAULT_SUBAGENT_MAX_CONCURRENT_RUNS,
  defaultTimeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
}

/**
 * Built-in roles a fresh install offers.
 *
 * Each one runs on the in-process `spawn` backend and fixes its model
 * (`model.mode: 'fixed'`) with no route of its own, so it inherits the calling
 * parent's resolved route and the parent still may not choose another. The
 * route stays unnamed because a shipped default cannot name an LLM provider and
 * model the deployment's catalog might not serve. Access follows the role's
 * risk: a role that changes the workspace gets `workspace-write`, a role that
 * only reads it gets `read-only`, and none of them may exceed the parent's own
 * effective mode.
 */
export const DEFAULT_SUBAGENT_DEFINITIONS: SubagentDefinition[] = [
  {
    id: 'code',
    name: 'Code',
    enabled: true,
    purpose: 'Implement or repair a scoped change in this workspace.',
    whenToUse: 'Use for a bounded implementation, edit, or bug fix whose exact change you can describe.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'workspace-write',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
  {
    id: 'review',
    name: 'Review',
    enabled: true,
    purpose: 'Review existing changes and report defects, risks, and gaps.',
    whenToUse: 'Use for a second opinion on a diff or design already present in the workspace.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'read-only',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
  {
    id: 'tests',
    name: 'Tests',
    enabled: true,
    purpose: 'Add or repair automated tests for a scoped behavior.',
    whenToUse: 'Use when the deliverable is test coverage for a behavior you can name.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'workspace-write',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
  {
    id: 'docs',
    name: 'Docs',
    enabled: true,
    purpose: 'Write or update documentation for a scoped subject.',
    whenToUse: 'Use when the deliverable is prose or a reference document rather than code.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'workspace-write',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
  {
    id: 'research',
    name: 'Research',
    enabled: true,
    purpose: 'Investigate a question in this workspace and report findings.',
    whenToUse: 'Use to answer a question by reading the workspace without changing it.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'read-only',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
  {
    id: 'architecture',
    name: 'Architecture',
    enabled: true,
    purpose: 'Analyze design trade-offs and propose a structure.',
    whenToUse: 'Use to weigh structural options before anyone commits to an implementation.',
    invocation: 'automatic',
    model: { mode: 'fixed' },
    access: 'read-only',
    instructions: '',
    execution: { backend: DEFAULT_SUBAGENT_BACKEND, background: 'auto' },
  },
]

/**
 * Every shipped definition, detached so a caller cannot mutate the module's copy.
 * @returns a fresh array of detached definition copies.
 */
export function defaultSubagentDefinitions(): SubagentDefinition[] {
  return DEFAULT_SUBAGENT_DEFINITIONS.map(definition => structuredClone(definition))
}

/**
 * The complete shipped settings document.
 * @returns a fresh, detached document a deployment or test may edit.
 */
export function defaultSubagentSettings(): SubagentSettings {
  return {
    subagents: defaultSubagentDefinitions(),
    overrides: {},
    automaticRouting: { ...DEFAULT_SUBAGENT_AUTOMATIC_ROUTING, allowedModels: [] },
    limits: { ...DEFAULT_SUBAGENT_LIMITS },
  }
}

/**
 * The shipped routing guidance for one built-in id, when it has one.
 * @param id - the definition id a migration is projecting.
 * @returns the shipped `whenToUse` text, or `undefined` for an unknown id.
 */
export function defaultWhenToUse(id: string): string | undefined {
  return DEFAULT_SUBAGENT_DEFINITIONS.find(definition => definition.id === id)?.whenToUse
}
