/** Real encrypted-channel ordering, confirmation, tamper, concurrency, and bounded-use behavior. */
import { describe, expect, it } from 'vitest'
import {
  decodeCounter, encodeBase64Url, encodeCounter, KEY_USE_LIMIT, MAX_APPLICATION_BYTES,
} from '../src/index.ts'
import { assertKeyUse } from '../src/channel.ts'
import type { EncryptedFrame } from '../src/index.ts'
import { capturedApplication, confirmChannels, connectedGrant } from './harness.ts'

const frameMutations: readonly [string, (frame: EncryptedFrame) => object][] = [
  ['version', frame => ({ ...frame, v: 2 })],
  ['direction reflection', frame => ({ ...frame, direction: 'pc-to-phone' })],
  ['channel', frame => ({ ...frame, channelId: 'other-channel' })],
  ['grant', frame => ({ ...frame, grantId: 'other-grant' })],
  ['generation', frame => ({ ...frame, generation: 2 })],
  ['counter gap', frame => ({ ...frame, counter: encodeCounter(2n) })],
  ['counter number', frame => ({ ...frame, counter: 1 })],
  ['ciphertext', frame => ({ ...frame, ciphertext: encodeBase64Url(Buffer.alloc(8)) })],
  ['tag', frame => ({ ...frame, tag: encodeBase64Url(Buffer.alloc(16)) })],
  ['extra property', frame => ({ ...frame, ignored: true })],
]

describe('confirmed companion channel', () => {
  it('does not expose confirmation plaintext and only dispatches after both confirmations', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    let phoneConfirmation: EncryptedFrame | undefined
    await phoneChannel.sendConfirmation(async (frame) => { phoneConfirmation = frame })
    const received = await pcChannel.receive(phoneConfirmation)
    expect(received).toEqual({ kind: 'confirmation' })
    expect(pcChannel.confirmed).toBe(false)
    await pcChannel.sendConfirmation(async (frame) => { await phoneChannel.receive(frame) })
    expect(phoneChannel.confirmed).toBe(true)
    expect(pcChannel.confirmed).toBe(true)
    const application = await capturedApplication(phoneChannel)
    expect(application.counter).toBe(encodeCounter(1n))
    expect(await pcChannel.receive(application)).toEqual({ kind: 'application', plaintext: Buffer.from('command') })
  })

  it('closes instead of encrypting application bytes before mutual confirmation', async () => {
    const { phoneChannel } = connectedGrant()
    let wrote = false
    await expect(phoneChannel.sendApplication(Buffer.from('command'), async () => { wrote = true })).rejects.toThrow('confirmation')
    expect(wrote).toBe(false)
    await expect(phoneChannel.sendConfirmation(async () => {})).rejects.toThrow('closed')
  })

  it.each(frameMutations)('fails terminally on frame mutation: %s', async (_label, mutate) => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    const frame = await capturedApplication(phoneChannel)
    await expect(pcChannel.receive(mutate(frame))).rejects.toThrow()
    expect(pcChannel.confirmed).toBe(false)
    await expect(pcChannel.receive(frame)).rejects.toThrow('closed')
  })

  it('rejects duplicate authenticated records rather than advancing past a replay', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    const frame = await capturedApplication(phoneChannel)
    expect((await pcChannel.receive(frame)).kind).toBe('application')
    await expect(pcChannel.receive(frame)).rejects.toThrow('order')
  })

  it('rejects reflected own ciphertext even if the attacker rewrites the direction', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    const frame = await capturedApplication(phoneChannel)
    await expect(phoneChannel.receive({ ...frame, direction: 'pc-to-phone' })).rejects.toThrow()
    await expect(phoneChannel.receive(frame)).rejects.toThrow('closed')
  })

  it('rejects ciphertext from a prior handshake even when route and grant are reused', async () => {
    const previous = connectedGrant()
    const current = connectedGrant(previous.keys)
    await confirmChannels(previous.phoneChannel, previous.pcChannel)
    await confirmChannels(current.phoneChannel, current.pcChannel)
    const frame = await capturedApplication(previous.phoneChannel)
    await expect(current.pcChannel.receive(frame)).rejects.toThrow()
  })

  it('serializes encryption through transport settlement and serializes queued decryption', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    const frames: EncryptedFrame[] = []
    let releaseFirst: (() => void) | undefined
    let enteredFirst: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve })
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = phoneChannel.sendApplication(Buffer.from('first'), async (frame) => {
      frames.push(frame)
      enteredFirst?.()
      await gate
    })
    const second = phoneChannel.sendApplication(Buffer.from('second'), async (frame) => { frames.push(frame) })
    await entered
    expect(frames.map(frame => decodeCounter(frame.counter))).toEqual([1n])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(frames.map(frame => decodeCounter(frame.counter))).toEqual([1n, 2n])
    const received = await Promise.all(frames.map(frame => pcChannel.receive(frame)))
    expect(received).toEqual([
      { kind: 'application', plaintext: Buffer.from('first') },
      { kind: 'application', plaintext: Buffer.from('second') },
    ])
  })

  it('copies plaintext before queueing and closes all queued writes after transport failure', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    const plaintext = Buffer.from('original')
    const send = phoneChannel.sendApplication(plaintext, async (frame) => {
      expect(await pcChannel.receive(frame)).toEqual({ kind: 'application', plaintext: Buffer.from('original') })
      throw new Error('transport failed after write')
    })
    plaintext.fill(0)
    const queued = phoneChannel.sendApplication(Buffer.from('queued'), async () => { throw new Error('must not write') })
    const settled = await Promise.allSettled([send, queued])
    expect(settled.map(entry => entry.status)).toEqual(['rejected', 'rejected'])
    expect(phoneChannel.confirmed).toBe(false)
    await expect(phoneChannel.sendConfirmation(async () => {})).rejects.toThrow('closed')
  })

  it('permits empty and exact-limit payloads and closes on one byte over the limit', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    await confirmChannels(phoneChannel, pcChannel)
    for (const length of [0, MAX_APPLICATION_BYTES]) {
      const frame = await capturedApplication(phoneChannel, Buffer.alloc(length, 4))
      expect(await pcChannel.receive(frame)).toEqual({ kind: 'application', plaintext: Buffer.alloc(length, 4) })
    }
    await expect(phoneChannel.sendApplication(Buffer.alloc(MAX_APPLICATION_BYTES + 1), async () => {})).rejects.toThrow('limit')
    expect(phoneChannel.confirmed).toBe(false)
  })

  it('accepts the last permitted invocation but rejects exhaustion and unsigned overflow', () => {
    expect(() => { assertKeyUse(KEY_USE_LIMIT - 1n) }).not.toThrow()
    for (const counter of [-1n, KEY_USE_LIMIT, 0xffffffffffffffffn]) {
      expect(() => { assertKeyUse(counter) }).toThrow('limit')
    }
  })

  it('rejects confirmation replay and duplicate local confirmation', async () => {
    const { phoneChannel, pcChannel } = connectedGrant()
    let confirmation: EncryptedFrame | undefined
    await phoneChannel.sendConfirmation(async (frame) => { confirmation = frame })
    expect(await pcChannel.receive(confirmation)).toEqual({ kind: 'confirmation' })
    await expect(pcChannel.receive(confirmation)).rejects.toThrow('order')
    await expect(phoneChannel.sendConfirmation(async () => {})).rejects.toThrow('Duplicate')
  })
})
