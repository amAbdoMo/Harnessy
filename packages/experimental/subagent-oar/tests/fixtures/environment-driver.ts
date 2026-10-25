/** Exercise real OAR native probes and Claude environment construction in an isolated host process. */

import { defaultRuntimes } from '@botiverse/oar'
import { promptAndWait } from '@botiverse/oar/observe'
import { oarEnvironment } from '../../src/environment.ts'

for (const runtimeId of ['codex', 'claude']) {
  const runtime = defaultRuntimes.require(runtimeId)
  const env = oarEnvironment({
    OAR_FIXTURE_RUNTIME: runtimeId,
    OAR_FIXTURE_EXPLICIT_TOKEN: 'explicit-fixture-value',
    OAR_FIXTURE_DELETE: null,
  })
  const installation = await runtime.installation?.({ env })
  if (installation?.kind !== 'available') throw new Error('Fixture installation unavailable')
  if (runtimeId === 'codex') {
    for (const override of [undefined, 'workspace-write']) {
      let refused = false
      try {
        await runtime.session(installation, {
          cwd: process.cwd(),
          env: { ...env, ...override === undefined ? {} : { OAR_CODEX_SANDBOX: override } },
        })
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes('fixture initialization refused')) throw error
        refused = true
      }
      if (!refused) throw new Error('Fixture should refuse native startup')
    }
    continue
  }
  const session = await runtime.session(installation, {
    cwd: process.cwd(), env, launchArgs: ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'],
  })
  try {
    const result = await promptAndWait(session, 'Return the fixture answer.', { timeoutMs: 10_000 })
    if (result.kind !== 'ended' || result.outcome.kind !== 'completed') throw new Error('Fixture turn did not complete')
  } finally {
    await session.dispose()
  }
}
