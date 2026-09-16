import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cached: boolean | undefined

/**
 * Whether this host can create a real symbolic link.
 *
 * A Windows host needs Developer Mode or SeCreateSymbolicLinkPrivilege, so the
 * answer is a capability, never a platform: a Windows machine holding the
 * privilege runs every test this gates. Creating with an explicit `file` type
 * is what makes the probe honest — Windows refuses when it cannot make a real
 * symlink rather than silently substituting a junction.
 *
 * The probe creates one link inside a fresh temporary directory, removes that
 * directory, and caches the answer for the process. It never throws: an
 * unreadable temporary directory is reported as an unusable capability.
 * @returns whether a real symbolic link can be created on this host.
 */
export function symlinksUsable(): boolean {
  cached ??= probeSymlink()
  return cached
}

/**
 * Create one real symbolic link inside a fresh temporary directory, then remove
 * that directory on both the success and failure paths.
 * @returns whether the link is a symbolic link, or false when any step fails.
 */
function probeSymlink(): boolean {
  if (process.platform !== 'win32') return true
  let tempDir: string | undefined
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-symlink-probe-'))
    const target = join(tempDir, 'target')
    const link = join(tempDir, 'link')
    writeFileSync(target, '')
    symlinkSync(target, link, 'file')
    return lstatSync(link).isSymbolicLink()
  } catch {
    // Every failure mode — no SeCreateSymbolicLinkPrivilege, an unreadable
    // temporary directory, a link that did not come out symbolic — is the same
    // answer for a caller, and none of them may surface as a thrown error.
    return false
  } finally {
    if (tempDir !== undefined) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Cleanup cannot change the capability answer, so it cannot throw.
      }
    }
  }
}
