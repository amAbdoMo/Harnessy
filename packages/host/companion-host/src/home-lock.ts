/** Kernel-owned exclusion for the PC identity home; a paused owner cannot lose a timed lease. */
import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'

interface WindowsFiles {
  readonly create: (path: string, access: number, sharing: number, security: null,
    creation: number, attributes: number, template: number) => number
  readonly close: (handle: number) => number
  readonly error: () => number
}

let windowsFiles: WindowsFiles | undefined

async function windows(): Promise<WindowsFiles> {
  if (windowsFiles !== undefined) return windowsFiles
  const koffi = (await import('koffi')).default
  const kernel = koffi.load('kernel32.dll')
  windowsFiles = {
    create: kernel.func('__stdcall', 'CreateFileW', 'intptr', ['str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr']) as WindowsFiles['create'],
    close: kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as WindowsFiles['close'],
    error: kernel.func('__stdcall', 'GetLastError', 'uint', []) as WindowsFiles['error'],
  }
  return windowsFiles
}

function windowsError(operation: string, code: number): Error {
  return new Error(`companion-host: ${operation} failed (Win32 ${code})`)
}

/**
 * Hold a non-expiring OS lock until quiescent Host teardown releases it.
 * @param canonicalHome - Existing realpath of the private PC identity home.
 * @returns Idempotent asynchronous release; crashes release the kernel handle, never a stale-timer takeover.
 */
export async function acquireHomeLock(canonicalHome: string): Promise<() => Promise<void>> {
  const path = join(canonicalHome, '.companion-host-owner')
  if (process.platform === 'win32') {
    const api = await windows()
    // Zero sharing forbids another process opening or replacing the owned file across logon sessions.
    const handle = api.create(toNamespacedPath(path), 0xc0000000, 0, null, 4, 0x80, 0)
    if (handle === -1 || handle === 0) throw windowsError('CreateFileW', api.error())
    let release: Promise<void> | undefined
    return () => release ??= Promise.resolve().then(() => {
      if (api.close(handle) === 0) throw windowsError('CloseHandle', api.error())
    })
  }
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
  let held: FileHandle | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(path, 'a+', 0o600)
    try {
      await tryLockExclusive(handle.fd)
      const inode = await handle.stat({ bigint: true })
      const current = await stat(path, { bigint: true }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (current !== undefined && current.ino === inode.ino && current.dev === inode.dev) {
        held = handle
        break
      }
    } catch (error) {
      await handle.close()
      throw error
    }
    await handle.close()
  }
  if (held === undefined) throw new Error('companion-host: identity lock was replaced during acquisition')
  const handle = held
  let release: Promise<void> | undefined
  // Keep the lock inode after release; deleting it would allow concurrent ownership of a replacement.
  return () => release ??= handle.close()
}
