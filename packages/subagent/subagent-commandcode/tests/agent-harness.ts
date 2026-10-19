/** Real Agent, Session, and directory services owned by each test context. */
import { afterEach } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  }
})

/** Allocate real directories for committed execution-directory changes. */
export async function directoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'commandcode-directory-'))
  roots.push(root)
  const captured = join(root, 'captured')
  const preflight = join(root, 'preflight')
  const permit = join(root, 'permit')
  await Promise.all([captured, preflight, permit].map(path => mkdir(path)))
  return { root, captured, preflight, permit }
}

/** Mount production services and register cleanup before asynchronous setup. */
export async function agentHarness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  return { ctx, agents }
}

/** An explicitly entered asynchronous operation that the test releases. */
export function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  return {
    entered: entered.promise,
    release: () => { released.resolve(undefined) },
    wait: async () => {
      entered.resolve(undefined)
      await released.promise
    },
  }
}
