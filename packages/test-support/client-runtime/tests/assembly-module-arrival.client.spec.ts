/** Independent module imports arrive together and settle before a failed assembly returns. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ClientRoster } from '../src/assembly/roster.ts'
import { loadPluginModules } from '../src/assembly/modules.ts'

const arrivals = vi.hoisted(() => ({
  left: Promise.withResolvers<undefined>(),
  right: Promise.withResolvers<undefined>(),
  release: Promise.withResolvers<undefined>(),
}))

vi.mock('@deepseek-ai/dsh-client-ui-brand-official/client', async () => {
  arrivals.left.resolve(undefined)
  await arrivals.release.promise
  return { apply() {} }
})
vi.mock('@deepseek-ai/dsh-client-ui-theme/client', async () => {
  arrivals.right.resolve(undefined)
  await arrivals.release.promise
  return { apply() {} }
})

it('drains parallel module arrivals on failure and retains roster order on success', async () => {
  const left = '@deepseek-ai/dsh-client-ui-brand-official'
  const right = '@deepseek-ai/dsh-client-ui-theme'
  const missing = '@deepseek-ai/dsh-client-missing-arrival-fixture'
  const row = (name: string) => ({ name, inject: [], immediately: false })
  const roster = ClientRoster.of([row(left), row(missing), row(right)])
  const loading = loadPluginModules({ roster })
  let settled = false
  const outcome = loading.then(
    () => { settled = true; return undefined },
    (error: unknown) => { settled = true; return error },
  )
  onTestFinished(async () => {
    arrivals.release.resolve(undefined)
    await outcome
  })
  await Promise.all([arrivals.left.promise, arrivals.right.promise])
  expect(settled).toBe(false)
  arrivals.release.resolve(undefined)
  const error = await outcome
  if (!(error instanceof Error)) throw new Error('Missing module unexpectedly resolved')
  expect(error.message).toContain(`cannot import ${missing}/client`)
  const modules = await loadPluginModules({ roster: ClientRoster.of([row(right), row(left)]) })
  expect([...modules.keys()]).toEqual([right, left])
})
