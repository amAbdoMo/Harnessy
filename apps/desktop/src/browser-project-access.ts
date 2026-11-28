/** Installation-local, Main-owned access to native Browser tools by Workspace ID. */
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { BrowserProjectId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** @param value - project identity from IPC or disk. @returns a validated Workspace ID. */
export function browserProjectId(value: unknown): BrowserProjectId {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('Invalid browser project identity')
  }
  return value as BrowserProjectId
}

/** Main serializes local preference changes and reads the last committed set. */
export class BrowserProjectAccess {
  private initial: Promise<void> | undefined
  private disabled = new Set<BrowserProjectId>()
  private tail = Promise.resolve()

  /** @param path - Main-owned file in this installation's user data. */
  constructor(private readonly path: string) {}

  /** @returns the set of projects with native agent browser access turned off. */
  async list(): Promise<readonly BrowserProjectId[]> {
    await this.tail
    await this.load()
    return [...this.disabled]
  }

  /** @param projectId - project to check. @returns whether access is enabled. */
  async allows(projectId: BrowserProjectId): Promise<boolean> {
    await this.load()
    return !this.disabled.has(projectId)
  }

  /** @param projectId - target project. @param enabled - requested setting.
   * @param revoked - fences pending native work at commit time.
   * @returns the updated list after durable replacement.
   */
  set(projectId: BrowserProjectId, enabled: boolean, revoked: () => void): Promise<readonly BrowserProjectId[]> {
    const transaction = this.tail.then(async () => {
      await this.load()
      const wasEnabled = !this.disabled.has(projectId)
      if (enabled !== wasEnabled) {
        const next = new Set(this.disabled)
        if (enabled) next.delete(projectId)
        else next.add(projectId)
        await writeFileAtomic(this.path, JSON.stringify([...next]) + '\n', { mode: 0o600, dirMode: 0o700 })
        this.disabled = next
        if (!enabled) revoked()
      }
      return [...this.disabled]
    })
    this.tail = transaction.then(() => {}, () => {})
    return transaction
  }

  private load(): Promise<void> {
    return this.initial ??= this.read().catch((error: unknown) => {
      this.initial = undefined
      throw error
    })
  }

  private async read(): Promise<void> {
    const raw = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]'
      throw error
    })
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) throw new Error('Invalid project browser access preferences')
    this.disabled = new Set(rows.map(browserProjectId))
  }
}
