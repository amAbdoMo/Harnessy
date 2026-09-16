#!/usr/bin/env node
/** Inspect the composed Harnessy delegation rows without running Command Code. */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from './spawn-counter.ts'
import { COMMAND_CODE_DELEGATION_NAMESPACE } from '../../../src/settings.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

/** The model-facing tools the two mounted delegation rows contribute. */
const DELEGATION_TOOLS = ['commandcode_delegate', 'delegate', 'list_commandcode_lanes', 'list_subagents']

/** Settings namespace the unified roster owns. */
const ROSTER_NAMESPACE = 'subagent-roster'

/** Attempts one read waits for the load-time migration's write to reach the document. */
const SETTLE_ATTEMPTS = 200

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('Harnessy delegation Loader composition driver requires the overlay path')
}

const ctx = await bootProductionProfile({
  binName: 'harnessy-delegation-loader-composition',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})

/** Read the count the fixture's process owner wrapper maintains. */
function spawnCount(): number {
  return globalThis.__commandCodeSpawnCount ?? 0
}

/** One namespace's stored user section, or undefined while it holds none. */
function storedSection(context: Context, namespace: string): unknown {
  return context.settings.describe().find(descriptor => String(descriptor.ns) === namespace)?.user
}

/**
 * Wait for the roster's load-time migration to land in the settings document.
 *
 * The migration follows its settings registration asynchronously, so a read
 * taken the moment the tree settles can precede the write. A tree where it
 * never lands reports `undefined` for the roster section, which the caller
 * asserts against.
 * @param context - the booted tree.
 * @returns the stored roster document and the stored lane section beside it.
 */
async function settledSections(context: Context): Promise<{ roster: unknown; legacy: unknown }> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const roster = storedSection(context, ROSTER_NAMESPACE)
    if (roster !== undefined) break
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  return {
    roster: storedSection(context, ROSTER_NAMESPACE),
    legacy: storedSection(context, COMMAND_CODE_DELEGATION_NAMESPACE),
  }
}

try {
  const spawnsAtLoad = spawnCount()
  const handle = await ctx.agents.create({
    sessionId: SessionId('loader-composition-harnessy-delegation'),
    setup: async () => {},
  })
  try {
    const tools = ctx.tools.schemas(handle.agent)
      .map(schema => schema.name)
      .filter(name => DELEGATION_TOOLS.includes(name))
      .sort()
    const sections = await settledSections(ctx)

    process.stdout.write(`${JSON.stringify({ spawnsAtLoad, tools, providers: ctx.subagents.list(), ...sections })}\n`)
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
}
