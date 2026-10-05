import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { credentialKey } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

it('admits cooperating operations across keys after a failed operation settles', async () => {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const firstKey = credentialKey('test', 'first')
  const secondKey = credentialKey('test', 'second')
  const first = ctx.credentials.withRecords(async () => {
    await ctx.credentials.modifyRecord(firstKey, () => Promise.resolve({ kind: 'api-key', key: 'first' }))
    entered.resolve(undefined)
    await release.promise
    throw new Error('fixture operation failed')
  })
  const failure = expect(first).rejects.toThrow('fixture operation failed')
  let admitted = false
  const second = ctx.credentials.withRecords(async () => {
    admitted = true
    await ctx.credentials.modifyRecord(secondKey, () => Promise.resolve({ kind: 'api-key', key: 'second' }))
    return 'committed'
  })
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() =>{  reject(new Error('fixture interleaving did not settle')) }, 2000)
  })
  try {
    await Promise.race([entered.promise, timeout])
    await setImmediate()
    expect(admitted).toBe(false)
    release.resolve(undefined)
    await failure
    await expect(Promise.race([second, timeout])).resolves.toBe('committed')
    expect(await ctx.credentials.readRecord(firstKey)).toEqual({ kind: 'api-key', key: 'first' })
    expect(await ctx.credentials.readRecord(secondKey)).toEqual({ kind: 'api-key', key: 'second' })
  } finally {
    clearTimeout(timer)
    release.resolve(undefined)
    await Promise.allSettled([first, second, failure])
    await ctx.fiber.dispose()
  }
})
