/** Serve immutable Android deltas from the Desktop owner's local home. */
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ANDROID_UPDATE_CHUNK_BYTES, parseAndroidUpdateOffer } from '@deepseek-ai/dsh-companion-protocol'
import type { AndroidUpdateProvider } from './types.ts'

const DIGEST = /^[0-9a-f]{64}$/u
const MANIFEST_LIMIT = 2_048
const CHUNK_INTERVAL_MS = 180

/**
 * Use the staging owner's prepared delta directory with one shared byte-rate schedule.
 * @param home - private Desktop data home, selected by the launcher.
 * @returns Authenticated request handler inputs for one Desktop Host incarnation.
 */
export function createAndroidUpdateProvider(home: string): AndroidUpdateProvider {
  const directory = join(home, 'android-updates')
  let nextChunkAt = 0
  return {
    async offer(baseSha256, signal) {
      signal.throwIfAborted()
      if (!DIGEST.test(baseSha256)) throw new Error('Invalid Android update base')
      const file = await open(join(directory, `${baseSha256}.json`), 'r').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (file === undefined) return null
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size < 1 || stat.size > MANIFEST_LIMIT) throw new Error('Invalid Android update manifest')
        const bytes = Buffer.alloc(stat.size)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        signal.throwIfAborted()
        if (bytesRead !== bytes.length) throw new Error('Android update manifest changed')
        const offer = parseAndroidUpdateOffer(JSON.parse(bytes.toString('utf8')))
        if (offer.baseSha256 !== baseSha256) throw new Error('Android update base does not match its manifest')
        return offer
      } finally { await file.close() }
    },
    async chunk(offer, offset, signal) {
      signal.throwIfAborted()
      if (!DIGEST.test(offer.artifactId) || !Number.isSafeInteger(offset) || offset < 0 || offset >= offer.patchBytes
        || offset % ANDROID_UPDATE_CHUNK_BYTES !== 0) throw new Error('Invalid Android update chunk')
      const now = performance.now()
      const startAt = Math.max(now, nextChunkAt)
      nextChunkAt = startAt + CHUNK_INTERVAL_MS
      if (startAt > now) await delay(startAt - now, undefined, { signal, ref: false })
      const file = await open(join(directory, `${offer.artifactId}.hyd`), 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== offer.patchBytes) throw new Error('Android update delta changed')
        const bytes = Buffer.alloc(Math.min(ANDROID_UPDATE_CHUNK_BYTES, offer.patchBytes - offset))
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
        signal.throwIfAborted()
        if (bytesRead !== bytes.length) throw new Error('Android update delta is incomplete')
        return bytes.toString('base64')
      } finally { await file.close() }
    },
  }
}
