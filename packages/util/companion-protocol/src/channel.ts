/** Serialized AES-GCM channel; any parse, authentication, ordering, or send failure is terminal. */
import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import {
  canonicalBytes, decodeBase64Url, decodeCounter, encodeBase64Url, encodeCounter,
  KEY_USE_LIMIT, MAX_APPLICATION_BYTES,
} from './bytes.ts'
import {
  deriveDirectionMaterial, frameAdditionalData, frameNonce, handshakeTranscriptHash,
} from './transcripts.ts'
import type { DirectionMaterial } from './transcripts.ts'
import { parseEncryptedFrame } from './wire.ts'
import type { ChannelBudget } from './channel-budget.ts'
import type { ChannelId, ClientHello, Direction, EncryptedFrame, GrantId, PcWelcome, Role } from './types.ts'

/**
 * Local writes must settle in delivery order; failure or deadline closes the channel.
 * @param frame - Complete immutable encrypted JSON envelope.
 * @param signal - Channel lifecycle signal; the transport owner must abort pending local writes on cancellation.
 * @returns Local write settlement, never peer dispatch or acknowledgement; do not await this same channel.
 */
export type FrameSender = (frame: EncryptedFrame, signal: AbortSignal) => Promise<void>
/** Only application results contain dispatchable plaintext. */
export type ChannelReceive = { readonly kind: 'confirmation' } | { readonly kind: 'application'; readonly plaintext: Buffer }

/** Confirmed cryptographic channel; authorization revocation remains a caller duty. */
export interface EncryptedChannel {
  /** Immutable authenticated channel routing id. */
  readonly channelId: ChannelId
  /** Immutable PC authorization record id. */
  readonly grantId: GrantId
  /** Immutable PC authorization generation. */
  readonly generation: number
  /** True only after both encrypted key confirmations succeed; false after terminal failure. */
  readonly confirmed: boolean
  /**
   * Send the first encrypted record; caller must invoke this exactly once per fresh channel.
   * @param send - Local transport write; must not await peer acknowledgement or call this channel from the callback.
   * @returns Completion after the transport write succeeds; failure closes the channel.
   */
  sendConfirmation(send: FrameSender): Promise<void>
  /**
   * Send opaque application bytes after both confirmations; admission precedes the plaintext copy.
   * @param plaintext - At most 65536 bytes; the caller owns application encoding and authorization.
   * @param send - Local transport write; must not await peer acknowledgement or call this channel from the callback.
   * @returns Completion after encryption and write; failure closes the channel.
   */
  sendApplication(plaintext: Uint8Array, send: FrameSender): Promise<void>
  /**
   * Authenticate before advancing the exact expected counter; never dispatch confirmation bytes.
   * @param wire - Untrusted decoded JSON; bounded parsing snapshots fields before queue admission.
   * @returns Confirmation or dispatchable application bytes; all failures close the channel.
   */
  receive(wire: unknown): Promise<ChannelReceive>
  /** Abort local writes, erase owned buffers, and promptly reject all calls; transport quiescence is caller-owned. */
  close(): void
}

interface ChannelRequest {
  readonly role: Role
  readonly sharedSecret: Uint8Array
  readonly hello: ClientHello
  readonly welcome: PcWelcome
  readonly channelBudget: ChannelBudget
}

type QueueDirection = 'send' | 'receive'
interface QueueUsage {
  bytes: number
  count: number
}

function channelError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Companion channel operation failed')
}

class AuthenticatedChannel implements EncryptedChannel {
  readonly channelId: ChannelId
  readonly grantId: GrantId
  readonly generation: number
  readonly #sendDirection: Direction
  readonly #receiveDirection: Direction
  readonly #sendMaterial: DirectionMaterial
  readonly #receiveMaterial: DirectionMaterial
  readonly #transcriptHash: Buffer
  #sendCounter = 0n
  #receiveCounter = 0n
  #sentConfirmation = false
  #receivedConfirmation = false
  readonly #lifecycle = new AbortController()
  readonly #budget: ChannelBudget
  readonly #usage: Record<QueueDirection, QueueUsage> = { send: { bytes: 0, count: 0 }, receive: { bytes: 0, count: 0 } }
  readonly #pending = new Set<(error: Error) => void>()
  #tail: Promise<void> = Promise.resolve()

  constructor(request: ChannelRequest) {
    this.channelId = request.hello.channelId
    this.grantId = request.welcome.grantId
    this.generation = request.welcome.generation
    this.#budget = request.channelBudget
    this.#sendDirection = request.role === 'phone' ? 'phone-to-pc' : 'pc-to-phone'
    this.#receiveDirection = request.role === 'phone' ? 'pc-to-phone' : 'phone-to-pc'
    this.#sendMaterial = deriveDirectionMaterial(request.sharedSecret, request, this.#sendDirection)
    this.#receiveMaterial = deriveDirectionMaterial(request.sharedSecret, request, this.#receiveDirection)
    this.#transcriptHash = handshakeTranscriptHash(request.hello, request.welcome)
  }

  get confirmed(): boolean {
    return !this.#lifecycle.signal.aborted && this.#sentConfirmation && this.#receivedConfirmation
  }

  close(): void {
    this.#terminate(new Error('Companion channel is closed'))
  }

  #terminate(error: Error): void {
    if (this.#lifecycle.signal.aborted) return
    this.#lifecycle.abort(error)
    this.#sendMaterial.key.fill(0)
    this.#receiveMaterial.key.fill(0)
    this.#sendMaterial.noncePrefix.fill(0)
    this.#receiveMaterial.noncePrefix.fill(0)
    this.#transcriptHash.fill(0)
    this.#sentConfirmation = false
    this.#receivedConfirmation = false
    for (const reject of this.#pending) reject(error)
  }

  #requireOpen(): void {
    if (this.#lifecycle.signal.aborted) throw new Error('Companion channel is closed')
  }

  #reserve(direction: QueueDirection, bytes: number): () => void {
    this.#requireOpen()
    const usage = this.#usage[direction]
    const maxBytes = direction === 'send' ? this.#budget.maxQueuedSendBytes : this.#budget.maxQueuedReceiveBytes
    const maxCount = direction === 'send' ? this.#budget.maxPendingSends : this.#budget.maxPendingReceives
    if (usage.bytes + bytes > maxBytes || usage.count >= maxCount) throw new Error('Companion channel queue budget exhausted')
    usage.bytes += bytes
    usage.count++
    return () => { usage.bytes -= bytes; usage.count-- }
  }

  #enqueue<T>(operation: () => Promise<T>, release: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = (error: Error): void => { finish(); reject(error) }
      const finish = (): void => {
        if (this.#pending.delete(cancel)) release()
      }
      this.#pending.add(cancel)
      const pending = this.#tail.then(async () => {
        try {
          this.#requireOpen()
          const received = await operation()
          this.#requireOpen()
          finish()
          resolve(received)
        } catch (error) {
          finish()
          reject(channelError(error))
          this.close()
        }
      })
      // Public cancellation settles promptly; the bounded internal queue drains after the aborted write.
      this.#tail = pending
    })
  }

  #rejected(error: unknown): Promise<never> {
    this.close()
    return Promise.reject(channelError(error))
  }

  sendConfirmation(send: FrameSender): Promise<void> {
    try {
      const size = 1 + 12 + Buffer.byteLength('dsh-companion/key-confirmation/v1')
        + this.#transcriptHash.length + Buffer.byteLength(this.#sendDirection)
      const release = this.#reserve('send', size)
      return this.#enqueue(async () => {
        if (this.#sentConfirmation) throw new Error('Duplicate key confirmation')
        await this.#write(Buffer.concat([Buffer.from([0]), this.#confirmation(this.#sendDirection)]), send)
        this.#sentConfirmation = true
      }, release)
    } catch (error) { return this.#rejected(error) }
  }

  sendApplication(plaintext: Uint8Array, send: FrameSender): Promise<void> {
    try {
      if (plaintext.length > MAX_APPLICATION_BYTES) throw new Error('Companion application payload exceeds limit')
      const release = this.#reserve('send', plaintext.byteLength + 1)
      const snapshot = Buffer.from(plaintext)
      return this.#enqueue(async () => {
        if (!this.confirmed) throw new Error('Encrypted key confirmation required')
        await this.#write(Buffer.concat([Buffer.from([1]), snapshot]), send)
      }, () => { snapshot.fill(0); release() })
    } catch (error) { return this.#rejected(error) }
  }

  #confirmation(direction: Direction): Buffer {
    return canonicalBytes('dsh-companion/key-confirmation/v1', [this.#transcriptHash, direction])
  }

  async #write(plaintext: Buffer, send: FrameSender): Promise<void> {
    assertKeyUse(this.#sendCounter)
    const metadata = {
      v: 1, type: 'encrypted', direction: this.#sendDirection, channelId: this.channelId,
      grantId: this.grantId, generation: this.generation, counter: encodeCounter(this.#sendCounter),
    } as const
    let frame: EncryptedFrame
    try {
      const cipher = createCipheriv('aes-256-gcm', this.#sendMaterial.key, frameNonce(this.#sendMaterial, this.#sendCounter), { authTagLength: 16 })
      cipher.setAAD(frameAdditionalData(metadata))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      frame = Object.freeze({ ...metadata, ciphertext: encodeBase64Url(ciphertext), tag: encodeBase64Url(cipher.getAuthTag()) })
    } finally { plaintext.fill(0) }
    await this.#boundedWrite(frame, send)
    this.#requireOpen()
    this.#sendCounter += 1n
  }

  async #boundedWrite(frame: EncryptedFrame, send: FrameSender): Promise<void> {
    const signal = this.#lifecycle.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = (): void => {}
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => { reject(new Error('Companion channel is closed')) }
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          const error = new Error('Companion local write deadline exceeded')
          reject(error)
          this.#terminate(error)
        }, this.#budget.sendTimeoutMs)
        try {
          send(frame, signal).then(resolve, (error: unknown) => { reject(channelError(error)) })
        } catch (error) { reject(channelError(error)) }
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  receive(wire: unknown): Promise<ChannelReceive> {
    try {
      this.#requireOpen()
      const frame = parseEncryptedFrame(wire)
      const release = this.#reserve('receive', Buffer.byteLength(JSON.stringify(frame)))
      return this.#enqueue(() => Promise.resolve(this.#read(frame)), release)
    } catch (error) { return this.#rejected(error) }
  }

  #read(frame: EncryptedFrame): ChannelReceive {
    assertKeyUse(this.#receiveCounter)
    if (frame.direction !== this.#receiveDirection || frame.channelId !== this.channelId
      || frame.grantId !== this.grantId || frame.generation !== this.generation
      || decodeCounter(frame.counter) !== this.#receiveCounter) throw new Error('Companion frame order or metadata mismatch')
    const decipher = createDecipheriv('aes-256-gcm', this.#receiveMaterial.key,
      frameNonce(this.#receiveMaterial, this.#receiveCounter), { authTagLength: 16 })
    decipher.setAAD(frameAdditionalData(frame))
    decipher.setAuthTag(decodeBase64Url(frame.tag, 16))
    const plaintext = Buffer.concat([decipher.update(decodeBase64Url(frame.ciphertext, null)), decipher.final()])
    const received = this.#classify(plaintext)
    this.#receiveCounter += 1n
    return received
  }

  #classify(plaintext: Buffer): ChannelReceive {
    if (!this.#receivedConfirmation) {
      const expected = Buffer.concat([Buffer.from([0]), this.#confirmation(this.#receiveDirection)])
      if (plaintext.length !== expected.length || !timingSafeEqual(plaintext, expected)) throw new Error('Invalid encrypted key confirmation')
      this.#receivedConfirmation = true
      return { kind: 'confirmation' }
    }
    if (!this.confirmed || plaintext[0] !== 1) throw new Error('Application before mutual confirmation or invalid payload type')
    return { kind: 'application', plaintext: plaintext.subarray(1) }
  }
}

/**
 * Enforce the fixed AES-GCM invocation cap; exhaustion requires a fresh handshake, never rekey/resume.
 * @param counter - Next invocation counter.
 * @returns Nothing; throws at the limit and outside the unsigned range.
 */
export function assertKeyUse(counter: bigint): void {
  if (counter < 0n || counter >= KEY_USE_LIMIT) throw new Error('Companion key-use limit exhausted')
}

/**
 * Internal channel constructor; only a verified, externally authorized handshake may call this.
 * @param request - Fresh ECDH secret and complete authenticated handshake.
 * @returns Unconfirmed channel; one queue serializes encryption, sending, and decryption.
 */
export function createChannel(request: ChannelRequest): EncryptedChannel {
  return new AuthenticatedChannel(request)
}
