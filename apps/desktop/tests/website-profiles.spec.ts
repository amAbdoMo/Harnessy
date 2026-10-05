/** Behavioral coverage for main-owned website/account metadata and its revocable observation permission. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopWebsiteProfiles } from '../src/website-profiles.ts'

const MCP_BINDING = { identity: 'a'.repeat(64), endpoint: 'https://portal.example.test/wp-json/mcp' }
const PAIRING = { inspect: async () => MCP_BINDING, confirm: async () => {}, enroll: async () => {} }
const PAIRED = { name: 'Portal', accountLabel: 'operations', url: 'https://portal.example.test', mcpServerName: 'portal' }
const OTHER = { name: 'Console', accountLabel: '', url: 'https://console.example.test', mcpServerName: 'console' }
const STORED_PORTAL = { id: '11111111-2222-4333-8444-555555555555', name: 'Portal', accountLabel: 'operations',
  url: 'https://portal.example.test/', mcpServerName: 'portal', loginConfirmed: false, cleanupPending: false, mcpBinding: MCP_BINDING }
const UNAVAILABLE = 'Website profile is unavailable'
const BLOCKED = 'Website profile data must be cleared successfully before it can be used'
const PAUSED = 'Website observation is paused; wait for the user to resume control'
const UNSAFE_ADDRESS = 'Website profile address cannot contain credentials, query parameters or fragments'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** @returns a metadata path inside a private directory this suite removes after the test. */
async function metadataPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-website-profiles-'))
  roots.push(root)
  return join(root, 'website-profiles.json')
}

/** Reads the committed file exactly as the store wrote it. */
async function storedProfiles(filename: string): Promise<Array<Record<string, unknown>>> {
  const document = JSON.parse(await readFile(filename, 'utf8')) as { version: unknown; profiles: Array<Record<string, unknown>> }
  expect(document.version).toBe(1)
  return document.profiles
}

/** Counts observed events so a test can wait for an exact arrival instead of sleeping. */
function arrivalCounter(): { arrived: () => void; waitFor: (target: number) => Promise<void> } {
  let observed = 0
  const waiters: Array<{ target: number; resolve: () => void }> = []
  return {
    arrived: () => {
      observed += 1
      for (const waiter of waiters.splice(0)) {
        if (waiter.target <= observed) waiter.resolve()
        else waiters.push(waiter)
      }
    },
    waitFor: (target: number) => observed >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ target, resolve }) }),
  }
}

/** Storage cleanup that records every call and holds it until the test settles it. */
function heldCleanup() {
  const calls: DesktopWebsiteProfileId[] = []
  const arrivals = arrivalCounter()
  const pending = new Map<DesktopWebsiteProfileId, (error?: Error) => void>()
  return {
    calls,
    /** @param count - cleanup calls that must have been entered. */
    waitForCalls: arrivals.waitFor,
    clear: (id: DesktopWebsiteProfileId): Promise<void> => new Promise<void>((resolve, reject) => {
      calls.push(id)
      pending.set(id, (error) => { if (error === undefined) resolve(); else reject(error) })
      arrivals.arrived()
    }),
    /** @param id - profile whose held cleanup completes. @param error - failure to report instead of success. */
    settle: (id: DesktopWebsiteProfileId, error?: Error): void => {
      const settle = pending.get(id)
      if (settle === undefined) throw new Error(`website profile cleanup for ${id} is not pending`)
      pending.delete(id)
      settle(error)
    },
  }
}

/** A metadata file the store must refuse to use. */
type UnusableFile = readonly [scenario: string, content: string, failure: string | ErrorConstructor]

const unusableFiles: readonly UnusableFile[] = [
  ['a future version', JSON.stringify({ version: 2, profiles: [] }),
    'Website profile file has an unsupported version or profile list'],
  ['a malformed document', '{"version":1,"profiles":[}', SyntaxError],
  ['an unknown profile field', JSON.stringify({ version: 1, profiles: [{ ...STORED_PORTAL, cookies: 'session=1' }] }),
    'Website profile contains unsupported fields'],
  ['duplicate identities', JSON.stringify({ version: 1, profiles: [STORED_PORTAL, { ...STORED_PORTAL, name: 'Copy' }] }),
    'Website profile identities are duplicated'],
]

describe('desktop website profiles', () => {
  it('does not save a pairing after the human cancels confirmation', async () => {
    const filename = await metadataPath()
    const confirm = vi.fn(async () => { throw new Error('Website pairing was cancelled') })
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING, confirm }, async () => {})
    await expect(profiles.create(PAIRED)).rejects.toThrow('Website pairing was cancelled')
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ ...PAIRED, url: `${PAIRED.url}/` }, MCP_BINDING)
    expect(await profiles.list()).toEqual([])
    expect(existsSync(filename)).toBe(false)
  })

  it('refuses a configuration change during confirmation and never commits the stale pairing', async () => {
    const filename = await metadataPath()
    const inspect = vi.fn().mockResolvedValueOnce(MCP_BINDING)
      .mockResolvedValue({ ...MCP_BINDING, identity: 'b'.repeat(64) })
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING, inspect }, async () => {})
    await expect(profiles.create(PAIRED)).rejects.toThrow('Website MCP endpoint or project changed')
    expect(await profiles.list()).toEqual([])
    expect(existsSync(filename)).toBe(false)
  })

  it('refuses acquire and Resume when the saved project or endpoint no longer matches', async () => {
    const filename = await metadataPath()
    let binding = MCP_BINDING
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING, inspect: async () => binding }, async () => {})
    const created = await profiles.create(PAIRED)
    await profiles.setControl(created.id, 'agent')
    const epoch = profiles.assertAgent(created.id)
    binding = { ...MCP_BINDING, identity: 'b'.repeat(64) }
    await expect(profiles.acquire(created.id)).rejects.toThrow('Website MCP endpoint or project changed')
    await expect(profiles.setControl(created.id, 'agent')).rejects.toThrow('Website MCP endpoint or project changed')
    expect(() => profiles.assertAgent(created.id, epoch)).toThrow(PAUSED)
    expect((await profiles.list())[0]?.control).toBe('human')
  })

  it('installs paired-namespace protection before saving or publishing a newly approved account', async () => {
    const filename = await metadataPath()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const installed: PromiseWithResolvers<void> = Promise.withResolvers()
    onTestFinished(() =>{  installed.resolve() })
    const enroll = vi.fn(async () => { entered.resolve(); await installed.promise })
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING, enroll }, async () => {})
    const notified = vi.fn()
    profiles.subscribe(notified)
    const creating = profiles.create(PAIRED)
    await entered.promise
    expect(existsSync(filename)).toBe(false)
    expect(notified).not.toHaveBeenCalled()
    expect(await profiles.list()).toEqual([])
    installed.resolve()
    const created = await creating
    expect(enroll).toHaveBeenCalledWith([{ id: created.id, name: created.name, accountLabel: created.accountLabel,
      url: created.url, serverName: 'portal', mcpBinding: MCP_BINDING }])
    expect(created.control).toBe('human')
    expect(notified).toHaveBeenCalledOnce()
  })

  it('does not save a new account when paired-namespace protection fails', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING,
      enroll: async () => { throw new Error('Host enrollment failed') } }, async () => {})
    await expect(profiles.create(PAIRED)).rejects.toThrow('Host enrollment failed')
    expect(existsSync(filename)).toBe(false)
    expect(await profiles.list()).toEqual([])
  })

  it('does not prompt or write when MCP inspection fails', async () => {
    const filename = await metadataPath()
    const confirm = vi.fn(async () => {})
    const inspect = vi.fn(async () => { throw new Error('Website pairing requires an enabled, connected MCP server') })
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, { ...PAIRING, inspect, confirm }, async () => {})
    await expect(profiles.create(PAIRED)).rejects.toThrow('enabled, connected MCP server')
    expect(confirm).not.toHaveBeenCalled()
    expect(existsSync(filename)).toBe(false)
  })

  it('bounds the full UTF-8 metadata before publishing or replacing the committed file', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, {
      ...PAIRING, inspect: async () => ({ ...MCP_BINDING, endpoint: '界'.repeat(2048) }),
    }, async () => {})
    const large = { ...PAIRED, name: '界'.repeat(120), accountLabel: '界'.repeat(120) }
    let committed = ''
    for (let index = 0; index < 64; index++) {
      try { await profiles.create(large) }
      catch (error) {
        expect(error).toEqual(new Error('Website profile file exceeds its size limit'))
        expect(await readFile(filename, 'utf8')).toBe(committed)
        const saved = await storedProfiles(filename)
        expect(await profiles.list()).toHaveLength(saved.length)
        expect(await new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {}).list()).toHaveLength(saved.length)
        return
      }
      committed = await readFile(filename, 'utf8')
      expect(Buffer.byteLength(committed)).toBeLessThanOrEqual(256 * 1024)
    }
    throw new Error('multibyte fixture did not reach the complete-file bound')
  })

  it('saves a new pairing in human control and refuses credentials, query or fragment in its address', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})

    expect(() => profiles.create({ ...PAIRED, url: 'https://user:secret@portal.example.test' })).toThrow(UNSAFE_ADDRESS)
    expect(() => profiles.create({ ...PAIRED, url: 'https://portal.example.test/?tenant=1' })).toThrow(UNSAFE_ADDRESS)
    expect(() => profiles.create({ ...PAIRED, url: 'https://portal.example.test/#/home' })).toThrow(UNSAFE_ADDRESS)
    expect(existsSync(filename)).toBe(false)

    const created = await profiles.create(PAIRED)
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(created).toEqual({ ...PAIRED, id: created.id, url: 'https://portal.example.test/', control: 'human' })
    expect(() => profiles.assertAgent(created.id)).toThrow(PAUSED)
    expect(await profiles.list()).toEqual([created])
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id }])
    expect(await readdir(dirname(filename))).toEqual([basename(filename)])
  })

  it('reacquires a persisted profile identity from a new instance without restoring observation permission', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)

    await profiles.setControl(created.id, 'agent')
    expect(profiles.assertAgent(created.id)).toBe(1)
    expect(await profiles.acquire(created.id)).toEqual({ ...created, control: 'agent' })
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id, loginConfirmed: true }])

    const restarted = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})
    expect(await restarted.list()).toEqual([{ ...created, control: 'human' }])
    expect(await restarted.acquire(created.id)).toEqual({ ...created, control: 'human' })
    expect(() => restarted.assertAgent(created.id)).toThrow(PAUSED)
    await restarted.setControl(created.id, 'agent')
    expect(restarted.assertAgent(created.id)).toBe(1)

    await expect(profiles.acquire('22222222-3333-4444-8555-666666666666')).rejects.toThrow(UNAVAILABLE)
    await expect(profiles.acquire('not-a-profile')).rejects.toThrow('Website profile identity is invalid')
  })

  it('revokes a captured observation generation when the user takes over', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)
    await profiles.setControl(created.id, 'agent')
    const captured = profiles.assertAgent(created.id)

    await profiles.setControl(created.id, 'human')
    expect(() => profiles.assertAgent(created.id, captured)).toThrow(PAUSED)
    expect(() => profiles.assertAgent(created.id)).toThrow(PAUSED)
    expect(await profiles.acquire(created.id)).toEqual({ ...created, control: 'human' })

    await profiles.setControl(created.id, 'agent')
    expect(profiles.assertAgent(created.id)).toBe(captured + 2)
    expect(() => profiles.assertAgent(created.id, captured)).toThrow(PAUSED)
  })

  it('blocks use while cleanup is pending and returns the profile to human control when it completes', async () => {
    const filename = await metadataPath()
    const cleanup = heldCleanup()
    const profiles = new DesktopWebsiteProfiles(filename, cleanup.clear, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)
    await profiles.setControl(created.id, 'agent')

    const signingOut = profiles.signOut(created.id)
    await cleanup.waitForCalls(1)
    expect(cleanup.calls).toEqual([created.id])
    expect(await profiles.list()).toEqual([{ ...created, control: 'clearing' }])
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id, cleanupPending: true }])
    await expect(profiles.acquire(created.id)).rejects.toThrow(BLOCKED)
    expect(() => profiles.assertAgent(created.id)).toThrow(PAUSED)
    await expect(profiles.forget(created.id)).rejects.toThrow('Website profile cleanup is already in progress')

    cleanup.settle(created.id)
    await signingOut
    expect(await profiles.list()).toEqual([{ ...created, control: 'human' }])
    expect(await profiles.acquire(created.id)).toEqual({ ...created, control: 'human' })
    expect(cleanup.calls).toEqual([created.id])
  })

  it('keeps a failed cleanup visible and blocked until a retry succeeds', async () => {
    const filename = await metadataPath()
    const cleanup = heldCleanup()
    const profiles = new DesktopWebsiteProfiles(filename, cleanup.clear, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)
    await profiles.setControl(created.id, 'agent')

    const forgetting = profiles.forget(created.id)
    const refusal = expect(forgetting).rejects.toThrow('storage unavailable')
    await cleanup.waitForCalls(1)
    cleanup.settle(created.id, new Error('storage unavailable'))
    await refusal

    expect(await profiles.list()).toEqual([{ ...created, control: 'cleanup-failed' }])
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id, cleanupPending: true }])
    await expect(profiles.acquire(created.id)).rejects.toThrow(BLOCKED)
    await expect(profiles.setControl(created.id, 'agent')).rejects.toThrow(BLOCKED)
    expect(() => profiles.assertAgent(created.id)).toThrow(PAUSED)

    const retried = profiles.forget(created.id)
    await cleanup.waitForCalls(2)
    cleanup.settle(created.id)
    await retried
    expect(cleanup.calls).toEqual([created.id, created.id])
    expect(await profiles.list()).toEqual([])
    expect(await storedProfiles(filename)).toEqual([])
  })

  it('keeps interrupted cleanup blocked after restart and clears the durable marker only after retry', async () => {
    const filename = await metadataPath()
    const cleanup = heldCleanup()
    const profiles = new DesktopWebsiteProfiles(filename, cleanup.clear, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)
    const pending = profiles.signOut(created.id)
    const failed = expect(pending).rejects.toThrow('interrupted')
    await cleanup.waitForCalls(1)
    const clear = vi.fn(async () => {})
    const restarted = new DesktopWebsiteProfiles(filename, clear, PAIRING, async () => {})
    expect(await restarted.list()).toEqual([{ ...created, control: 'cleanup-failed' }])
    await expect(restarted.acquire(created.id)).rejects.toThrow(BLOCKED)
    await expect(restarted.setControl(created.id, 'agent')).rejects.toThrow(BLOCKED)
    expect(() => restarted.assertAgent(created.id)).toThrow(PAUSED)
    cleanup.settle(created.id, new Error('interrupted'))
    await failed
    await restarted.signOut(created.id)
    expect(clear).toHaveBeenCalledExactlyOnceWith(created.id)
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id }])
    expect(await new DesktopWebsiteProfiles(filename, clear, PAIRING, async () => {}).list()).toEqual([{ ...created, control: 'human' }])
  })

  it('removes a saved association only after its storage cleanup completes', async () => {
    const filename = await metadataPath()
    const cleanup = heldCleanup()
    const profiles = new DesktopWebsiteProfiles(filename, cleanup.clear, PAIRING, async () => {})
    const created = await profiles.create(PAIRED)

    const forgetting = profiles.forget(created.id)
    await cleanup.waitForCalls(1)
    expect(await profiles.list()).toEqual([{ ...created, control: 'clearing' }])
    expect(await storedProfiles(filename)).toEqual([{ ...STORED_PORTAL, id: created.id, cleanupPending: true }])

    cleanup.settle(created.id)
    await forgetting
    expect(await profiles.list()).toEqual([])
    expect(await storedProfiles(filename)).toEqual([])
    await expect(profiles.acquire(created.id)).rejects.toThrow(UNAVAILABLE)
    expect(() => profiles.assertAgent(created.id)).toThrow(UNAVAILABLE)
    expect(await new DesktopWebsiteProfiles(filename, cleanup.clear, PAIRING, async () => {}).list()).toEqual([])
  })

  it.each(unusableFiles)('rejects %s and never rewrites the file', async (_scenario, content, failure) => {
    const filename = await metadataPath()
    await writeFile(filename, content)
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})

    await expect(profiles.list()).rejects.toThrow(failure)
    await expect(profiles.create(PAIRED)).rejects.toThrow(failure)
    expect(await readFile(filename, 'utf8')).toBe(content)
    expect(await readdir(dirname(filename))).toEqual([basename(filename)])
  })

  it('rejects an unreadable metadata path without replacing it', async () => {
    const filename = await metadataPath()
    await mkdir(filename)
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})

    await expect(profiles.list()).rejects.toThrow(/EISDIR/)
    await expect(profiles.create(PAIRED)).rejects.toThrow(/EISDIR/)
    expect((await stat(filename)).isDirectory()).toBe(true)
    expect(await readdir(dirname(filename))).toEqual([basename(filename)])
  })

  it('serializes concurrent creations without losing a saved profile', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})

    const created = await Promise.all([profiles.create(PAIRED), profiles.create(OTHER), profiles.create(PAIRED)])
    expect(created.map(profile => profile.name)).toEqual(['Portal', 'Console', 'Portal'])
    expect(new Set(created.map(profile => profile.id)).size).toBe(3)
    expect((await storedProfiles(filename)).map(profile => profile.id)).toEqual(created.map(profile => profile.id))
    expect(await new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {}).list()).toEqual(created)
  })

  it('notifies subscribers of committed changes until they unsubscribe', async () => {
    const filename = await metadataPath()
    const profiles = new DesktopWebsiteProfiles(filename, async () => {}, PAIRING, async () => {})
    const listener = vi.fn()
    const unsubscribe = profiles.subscribe(listener)

    const created = await profiles.create(PAIRED)
    expect(listener).toHaveBeenCalledTimes(1)
    // The pause is published when control leaves agent, and the commit when the resume completes.
    await profiles.setControl(created.id, 'agent')
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    await profiles.setControl(created.id, 'human')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('keeps human control when a takeover lands while a resume is still saving', async () => {
    const filename = await metadataPath()
    const cleanup = heldCleanup()
    const pairing = { ...PAIRING, inspect: async (namespace: string) => namespace === 'portal' ? MCP_BINDING
      : { identity: 'b'.repeat(64), endpoint: 'https://console.example.test/mcp' } }
    const profiles = new DesktopWebsiteProfiles(filename, cleanup.clear, pairing, async () => {})
    const account = await profiles.create(PAIRED)
    const blocker = await profiles.create(OTHER)
    const invalidations = arrivalCounter()
    const unsubscribe = profiles.subscribe(invalidations.arrived)

    // Hold the save queue so the resume cannot commit until after the takeover.
    const signingOut = profiles.signOut(blocker.id)
    await cleanup.waitForCalls(1)
    await invalidations.waitFor(1)

    const resuming = profiles.setControl(account.id, 'agent')
    await invalidations.waitFor(2)
    const takeover = profiles.setControl(account.id, 'human')
    await invalidations.waitFor(3)
    expect(await profiles.list()).toEqual([{ ...account, control: 'human' }, { ...blocker, control: 'clearing' }])

    cleanup.settle(blocker.id)
    await signingOut
    await resuming
    await takeover

    expect(await profiles.list()).toEqual([{ ...account, control: 'human' }, { ...blocker, control: 'human' }])
    expect(() => profiles.assertAgent(account.id)).toThrow(PAUSED)

    // The profile stays usable, and the next resume reports a generation beyond the stale capture.
    await profiles.setControl(account.id, 'agent')
    expect(profiles.assertAgent(account.id)).toBe(3)
    expect(() => profiles.assertAgent(account.id, 2)).toThrow(PAUSED)
    unsubscribe()
  })
})
