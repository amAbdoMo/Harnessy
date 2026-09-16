#!/usr/bin/env node
/** Inspect the composed Command Code delegation plugin without running Command Code. */

import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../../../src/index.ts'
import type {} from './spawn-counter.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('subagent-commandcode Loader composition driver requires the overlay path')
}

const ctx = await bootProductionProfile({
  binName: 'subagent-commandcode-loader-composition',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})

/** Read the count the fixture's process owner wrapper maintains. */
function spawnCount(): number {
  return globalThis.__commandCodeSpawnCount ?? 0
}

try {
  const spawnsAtLoad = spawnCount()
  const settings = ctx.settings.get('commandcode-delegation')
  const handle = await ctx.agents.create({
    sessionId: SessionId('loader-composition-commandcode'),
    setup: async () => {},
  })
  try {
    const schemas = ctx.tools.schemas(handle.agent)
      .map(schema => ({ name: schema.name, parameters: schema.parameters }))
      .filter(schema => schema.name.startsWith('commandcode') || schema.name.startsWith('list_commandcode'))

    // The probe is the only path that may start a Command Code process, and it
    // must happen when a caller asks for it rather than at load.
    const health = await ctx.commandCodeController.health(new AbortController().signal)

    process.stdout.write(`${JSON.stringify({
      spawnsAtLoad,
      spawnsAfterProbe: spawnCount(),
      health,
      settings,
      tools: schemas,
    })}\n`)
  } finally {
    await handle.dispose()
  }
} finally {
  await ctx.fiber.dispose()
}
