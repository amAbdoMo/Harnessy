/** Main-only protected storage for saved website login values. */
import { open } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SafeStorage } from 'electron'
import type { DesktopWebsiteProfileId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Login values accepted only from the trusted Desktop account editor. */
export interface DesktopWebsiteLoginSecret {
  readonly username: string
  readonly password: string
}

/** OS-backed string protection used by the local credential vault. */
export interface DesktopWebsiteCredentialProtector {
  /** @returns whether protected encryption is currently available. */
  available(): Promise<boolean>
  /** @param plaintext - bounded private payload. @returns protected bytes for local persistence. */
  encrypt(plaintext: string): Promise<Buffer>
  /** @param protectedValue - previously protected bytes. @returns decrypted private payload. */
  decrypt(protectedValue: Buffer): Promise<string>
}

interface StoredCredential {
  readonly profile: DesktopWebsiteProfileId
  readonly protectedValue: string
}

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_FILE_BYTES = 256 * 1024
const MAX_CREDENTIALS = 64
const MAX_USERNAME_BYTES = 1024
const MAX_PASSWORD_BYTES = 16 * 1024

function exactRecord(input: unknown, keys: readonly string[], description: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))) throw new Error(`${description} contains unsupported fields`)
  return input as Record<string, unknown>
}

function profileId(input: unknown): DesktopWebsiteProfileId {
  if (typeof input !== 'string' || !PROFILE_ID.test(input)) throw new Error('Website credential profile identity is invalid')
  return input as DesktopWebsiteProfileId
}

function protectedValue(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_FILE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new Error('Website credential protected value is invalid')
  }
  const bytes = Buffer.from(input, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== input) throw new Error('Website credential protected value is invalid')
  return input
}

function parseSecret(input: unknown): DesktopWebsiteLoginSecret {
  const fields = exactRecord(input, ['username', 'password'], 'Website login')
  if (typeof fields.username !== 'string' || Buffer.byteLength(fields.username, 'utf8') > MAX_USERNAME_BYTES
    || /[\x00\r\n]/.test(fields.username)) throw new Error('Website login username is invalid')
  if (typeof fields.password !== 'string' || fields.password.length === 0
    || Buffer.byteLength(fields.password, 'utf8') > MAX_PASSWORD_BYTES || fields.password.includes('\0')) {
    throw new Error('Website login password is invalid')
  }
  return { username: fields.username, password: fields.password }
}

function parseCredentials(text: string): StoredCredential[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('Website credential file exceeds its size limit')
  const document = exactRecord(JSON.parse(text), ['version', 'credentials'], 'Website credential file')
  if (document.version !== 1 || !Array.isArray(document.credentials) || document.credentials.length > MAX_CREDENTIALS) {
    throw new Error('Website credential file has an unsupported version or credential list')
  }
  const credentials = document.credentials.map((input): StoredCredential => {
    const fields = exactRecord(input, ['profile', 'protectedValue'], 'Website credential')
    return { profile: profileId(fields.profile), protectedValue: protectedValue(fields.protectedValue) }
  })
  if (new Set(credentials.map(credential => credential.profile)).size !== credentials.length) {
    throw new Error('Website credential profile identities are duplicated')
  }
  return credentials
}

/**
 * Adapts Electron 44 asynchronous safeStorage without enabling its insecure Linux plaintext backend.
 * @param storage - Electron Main safeStorage singleton after app readiness.
 * @param platform - current operating system, injectable for focused tests.
 * @returns a protector that refuses unavailable or plaintext protection.
 */
export function electronWebsiteCredentialProtector(
  storage: Pick<SafeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync' | 'getSelectedStorageBackend'>,
  platform: NodeJS.Platform = process.platform,
): DesktopWebsiteCredentialProtector {
  const available = async (): Promise<boolean> => {
    if (platform === 'linux' && storage.getSelectedStorageBackend() === 'basic_text') return false
    return storage.isAsyncEncryptionAvailable()
  }
  const requireAvailable = async (): Promise<void> => {
    if (!await available()) throw new Error('Protected website credential storage is unavailable')
  }
  return {
    available,
    encrypt: async (plaintext) => { await requireAvailable(); return storage.encryptStringAsync(plaintext) },
    decrypt: async (value) => {
      await requireAvailable()
      const decrypted = await storage.decryptStringAsync(value)
      return decrypted.result
    },
  }
}

/** Owns encrypted website credentials; decrypted values are scoped to a void Main-process consumer. */
export class DesktopWebsiteCredentials {
  private credentials: readonly StoredCredential[] = []
  private loading: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  /** @param filename - private credential-vault path. @param protector - required OS-backed encryption. */
  constructor(private readonly filename: string, private readonly protector: DesktopWebsiteCredentialProtector) {}

  /** @param profile - saved website identity. @returns whether protected login values exist. */
  async has(profile: DesktopWebsiteProfileId): Promise<boolean> {
    await this.load()
    return this.credentials.some(credential => credential.profile === profile)
  }

  /**
   * Encrypts before the first vault write and never persists a plaintext fallback.
   * @param profile - saved website identity.
   * @param input - private login values from the trusted editor.
   * @returns after protected bytes are committed.
   */
  save(profile: DesktopWebsiteProfileId, input: unknown): Promise<void> {
    const secret = parseSecret(input)
    return this.serial(async () => {
      await this.load()
      if (!await this.protector.available()) throw new Error('Protected website credential storage is unavailable')
      const encrypted = await this.protector.encrypt(JSON.stringify(secret))
      const next = this.credentials.filter(credential => credential.profile !== profile)
      next.push({ profile, protectedValue: encrypted.toString('base64') })
      await this.persist(next)
    })
  }

  /** @param profile - profile whose protected entry should be removed. */
  remove(profile: DesktopWebsiteProfileId): Promise<void> {
    return this.serial(async () => {
      await this.load()
      if (!this.credentials.some(credential => credential.profile === profile)) return
      await this.persist(this.credentials.filter(credential => credential.profile !== profile))
    })
  }

  /**
   * Decrypts only for a Main-owned consumer and does not return credential values.
   * @param profile - saved website identity.
   * @param consumer - fixed login adapter; it must not log, retain or forward the secret.
   * @returns false when no saved login exists.
   */
  use(profile: DesktopWebsiteProfileId, consumer: (secret: DesktopWebsiteLoginSecret) => Promise<void>): Promise<boolean> {
    return this.serial(async () => {
      await this.load()
      const credential = this.credentials.find(candidate => candidate.profile === profile)
      if (credential === undefined) return false
      if (!await this.protector.available()) throw new Error('Protected website credential storage is unavailable')
      const plaintext = await this.protector.decrypt(Buffer.from(credential.protectedValue, 'base64'))
      let decoded: unknown
      try { decoded = JSON.parse(plaintext) }
      catch (_error: unknown) { throw new Error('Saved website login could not be decoded') }
      const secret = parseSecret(decoded)
      await consumer(secret)
      return true
    })
  }

  private load(): Promise<void> {
    return this.loading ??= (async () => {
      let text: string
      try {
        const file = await open(this.filename, 'r')
        try {
          const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, null)
            if (read.bytesRead === 0) break
            length += read.bytesRead
          }
          if (length > MAX_FILE_BYTES) throw new Error('Website credential file exceeds its size limit')
          text = bytes.subarray(0, length).toString('utf8')
        } finally { await file.close() }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      this.credentials = parseCredentials(text)
    })()
  }

  private async persist(credentials: readonly StoredCredential[]): Promise<void> {
    const text = `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('Website credential file exceeds its size limit')
    await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 })
    this.credentials = credentials
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.then(() => {}, () => {})
    return pending
  }
}
