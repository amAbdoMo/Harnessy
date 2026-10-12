/** Fresh socket-bound relay proofs do not confer PC operation authorization. */
import { describe, expect, it } from 'vitest'
import {
  createRelayChallenge, derivePcId, encodeBase64Url, exportPublicKey, generateP256KeyPair,
  parseHttpsOrigin, parseId, signRelayChallenge, verifyRelayChallenge,
} from '../src/index.ts'
import type { RelayChallenge, SocketGeneration } from '../src/index.ts'
import { origin } from './harness.ts'

const mutations: readonly [string, (challenge: RelayChallenge) => RelayChallenge][] = [
  ['role', challenge => ({ ...challenge, role: 'pc' })],
  ['origin', challenge => ({ ...challenge, httpsOrigin: parseHttpsOrigin('https://other.example') })],
  ['identity', challenge => ({ ...challenge, identityKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['target', challenge => ({ ...challenge, targetPcId: derivePcId(exportPublicKey(generateP256KeyPair().publicKey)) })],
  ['socket', challenge => ({ ...challenge, socketGeneration: parseId<SocketGeneration>('socket-other') })],
  ['challenge', challenge => ({ ...challenge, challenge: encodeBase64Url(Buffer.alloc(32, 9)) })],
]

function fixture() {
  const keys = generateP256KeyPair()
  const identityKey = exportPublicKey(keys.publicKey)
  const challenge = createRelayChallenge({
    role: 'phone', httpsOrigin: origin, identityKey, targetPcId: derivePcId(identityKey),
    socketGeneration: parseId<SocketGeneration>('socket-1'),
  })
  return { keys, challenge, proof: signRelayChallenge(keys.privateKey, challenge) }
}

describe('relay connection possession proof', () => {
  it.each(mutations)('binds %s to the stored pending socket challenge', (_name, mutate) => {
    const { challenge, proof } = fixture()
    expect(verifyRelayChallenge(challenge, proof)).toBe(true)
    expect(verifyRelayChallenge(mutate(challenge), proof)).toBe(false)
  })

  it('rejects replay on a fresh challenge for the same identity, origin and socket name', () => {
    const { challenge, proof } = fixture()
    const fresh = createRelayChallenge({
      role: challenge.role, httpsOrigin: challenge.httpsOrigin, identityKey: challenge.identityKey,
      targetPcId: challenge.targetPcId, socketGeneration: challenge.socketGeneration,
    })
    expect(fresh.challenge).not.toBe(challenge.challenge)
    expect(verifyRelayChallenge(fresh, proof)).toBe(false)
  })

  it('rejects extra proof fields, wrong versions and a challenge targeting another signing key', () => {
    const { challenge, proof } = fixture()
    expect(() => verifyRelayChallenge(challenge, { ...proof, challenge })).toThrow('fields')
    expect(() => verifyRelayChallenge(challenge, { ...proof, v: 2 })).toThrow('version')
    expect(() => signRelayChallenge(generateP256KeyPair().privateKey, challenge)).toThrow('identity')
  })
})
