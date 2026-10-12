/** Signed-transcript mutations and caller-owned authorization checks. */
import { describe, expect, it } from 'vitest'
import {
  acceptClientHello, createPhoneHandshake, encodeBase64Url, exportPublicKey, generateP256KeyPair,
  helloSignatureBytes, parseHttpsOrigin, parseId, signBytes, verifyClientHello,
} from '../src/index.ts'
import type { ChannelId, ClientHello, GrantId, InvitationId, PcWelcome } from '../src/index.ts'
import { channelBudget, channelId, grantId, identities, invitationId, origin, pendingGrant } from './harness.ts'

const helloMutations: readonly [string, (hello: ClientHello) => object][] = [
  ['version', hello => ({ ...hello, v: 2 })],
  ['suite', hello => ({ ...hello, suite: 'other' })],
  ['role reflection', hello => ({ ...hello, role: 'pc' })],
  ['origin', hello => ({ ...hello, httpsOrigin: 'https://other.example' })],
  ['channel', hello => ({ ...hello, channelId: parseId<ChannelId>('other-channel') })],
  ['phone identity', hello => ({ ...hello, phoneIdentityKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['pc identity', hello => ({ ...hello, pcIdentityKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['nonce', hello => ({ ...hello, nonce: encodeBase64Url(Buffer.alloc(32, 9)) })],
  ['ephemeral key', hello => ({ ...hello, ephemeralKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['grant', hello => ({ ...hello, authorization: { kind: 'grant', grantId: parseId<GrantId>('other-grant'), generation: 1 } })],
  ['generation', hello => ({ ...hello, authorization: { kind: 'grant', grantId, generation: 2 } })],
  ['authorization kind', hello => ({ ...hello, authorization: { kind: 'invitation', invitationId }, pairingProof: encodeBase64Url(Buffer.alloc(32)) })],
  ['proof on grant', hello => ({ ...hello, pairingProof: encodeBase64Url(Buffer.alloc(32)) })],
  ['extra property', hello => ({ ...hello, extra: true })],
]

const welcomeMutations: readonly [string, (welcome: PcWelcome) => object][] = [
  ['version', welcome => ({ ...welcome, v: 2 })],
  ['suite', welcome => ({ ...welcome, suite: 'other' })],
  ['role reflection', welcome => ({ ...welcome, role: 'phone' })],
  ['channel', welcome => ({ ...welcome, channelId: 'other-channel' })],
  ['nonce', welcome => ({ ...welcome, nonce: encodeBase64Url(Buffer.alloc(32, 9)) })],
  ['ephemeral key', welcome => ({ ...welcome, ephemeralKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['grant', welcome => ({ ...welcome, grantId: 'other-grant' })],
  ['generation', welcome => ({ ...welcome, generation: 2 })],
  ['extra property', welcome => ({ ...welcome, extra: true })],
]

const pairingMutations: readonly [string, (hello: ClientHello) => ClientHello][] = [
  ['origin', hello => ({ ...hello, httpsOrigin: parseHttpsOrigin('https://other.example') })],
  ['channel', hello => ({ ...hello, channelId: parseId<ChannelId>('other-channel') })],
  ['nonce', hello => ({ ...hello, nonce: encodeBase64Url(Buffer.alloc(32, 9)) })],
  ['ephemeral key', hello => ({ ...hello, ephemeralKey: exportPublicKey(generateP256KeyPair().publicKey) })],
  ['invitation', hello => ({ ...hello, authorization: { kind: 'invitation', invitationId: parseId<InvitationId>('other-invitation') } })],
]

describe('companion signed handshake', () => {
  it.each(pairingMutations)('rejects re-signed hello reusing a pairing proof after %s mutation', (_label, mutate) => {
    const keys = identities()
    const pairingSecret = Buffer.alloc(32, 7)
    const pending = createPhoneHandshake({ channelBudget,
      identityPrivateKey: keys.phone.privateKey, pcIdentityKey: exportPublicKey(keys.pc.publicKey),
      httpsOrigin: origin, channelId, authorization: { kind: 'invitation', invitationId, pairingSecret },
    })
    const mutated = mutate(pending.hello)
    if (mutated.authorization.kind !== 'invitation') throw new Error('Expected invitation test fixture')
    const mutatedInvitationId = mutated.authorization.invitationId
    const resigned = { ...mutated, signature: signBytes(keys.phone.privateKey, helloSignatureBytes(mutated)) }
    expect(() => acceptClientHello({ channelBudget,
      hello: resigned, identityPrivateKey: keys.pc.privateKey, httpsOrigin: mutated.httpsOrigin,
      authorization: {
        kind: 'invitation', invitationId: mutatedInvitationId, pairingSecret,
        phoneIdentityKey: mutated.phoneIdentityKey, grantId, generation: 1,
      },
    })).toThrow('pairing')
  })

  it.each(helloMutations)('rejects hello mutation: %s', (_label, mutate) => {
    const { pending, keys } = pendingGrant()
    expect(() => verifyClientHello({
      wire: mutate(pending.hello), pcIdentityKey: exportPublicKey(keys.pc.publicKey), httpsOrigin: origin,
    })).toThrow()
  })

  it.each(welcomeMutations)('consumes pending attempt on welcome mutation: %s', (_label, mutate) => {
    const { pending, keys, authorization } = pendingGrant()
    const accepted = acceptClientHello({ channelBudget,
      hello: pending.hello, identityPrivateKey: keys.pc.privateKey, httpsOrigin: origin, authorization })
    expect(() => pending.complete(mutate(accepted.welcome))).toThrow()
    expect(() => pending.complete(accepted.welcome)).toThrow('already consumed')
  })

  it('binds welcome to the exact complete hello, not only the channel id', () => {
    const { pending, keys, authorization } = pendingGrant()
    const differentAttempt = createPhoneHandshake({ channelBudget,
      identityPrivateKey: keys.phone.privateKey, pcIdentityKey: exportPublicKey(keys.pc.publicKey),
      httpsOrigin: origin, channelId, authorization: { kind: 'grant', grantId, generation: 1 },
    })
    const accepted = acceptClientHello({ channelBudget,
      hello: pending.hello, identityPrivateKey: keys.pc.privateKey, httpsOrigin: origin, authorization })
    expect(() => differentAttempt.complete(accepted.welcome)).toThrow('signature')
  })

  it('requires the caller decision to match the signed phone and current grant generation', () => {
    const { pending, keys, authorization } = pendingGrant()
    const request = { hello: pending.hello, identityPrivateKey: keys.pc.privateKey, httpsOrigin: origin }
    expect(() => acceptClientHello({ channelBudget, ...request, authorization: { ...authorization, generation: 2 } })).toThrow('grant')
    expect(() => acceptClientHello({ channelBudget, ...request, authorization: {
      ...authorization, phoneIdentityKey: exportPublicKey(generateP256KeyPair().publicKey),
    } })).toThrow('identity')
  })

  it('authenticates the full pairing hello with the external invitation secret', () => {
    const keys = identities()
    const pairingSecret = Buffer.alloc(32, 7)
    const pending = createPhoneHandshake({ channelBudget,
      identityPrivateKey: keys.phone.privateKey, pcIdentityKey: exportPublicKey(keys.pc.publicKey), httpsOrigin: origin,
      channelId, authorization: { kind: 'invitation', invitationId, pairingSecret },
    })
    const authorization = {
      kind: 'invitation', invitationId, pairingSecret, phoneIdentityKey: exportPublicKey(keys.phone.publicKey), grantId, generation: 1,
    } as const
    const request = { hello: pending.hello, identityPrivateKey: keys.pc.privateKey, httpsOrigin: origin }
    expect(() => acceptClientHello({ channelBudget, ...request, authorization: { ...authorization, pairingSecret: Buffer.alloc(32, 8) } })).toThrow('pairing')
    expect(() => acceptClientHello({ channelBudget, ...request, authorization: {
      ...authorization, invitationId: parseId<InvitationId>('other-invitation'),
    } })).toThrow('pairing')
    expect(() => acceptClientHello({ channelBudget, ...request, hello: { ...pending.hello, pairingProof: encodeBase64Url(Buffer.alloc(32)) }, authorization })).toThrow('signature')
    const accepted = acceptClientHello({ channelBudget, ...request, authorization })
    const channel = pending.complete(accepted.welcome)
    expect(channel.confirmed).toBe(false)
    channel.close()
    accepted.channel.close()
  })

  it('pins the caller origin rather than treating a canonical origin as authorized', () => {
    const { pending, keys, authorization } = pendingGrant()
    expect(() => acceptClientHello({ channelBudget,
      hello: pending.hello, identityPrivateKey: keys.pc.privateKey,
      httpsOrigin: parseHttpsOrigin('https://other.example'), authorization,
    })).toThrow('origin')
  })

  it('reconnects with fresh nonces and ephemeral keys on both sides', () => {
    const { pending, keys, authorization } = pendingGrant()
    const accept = () => acceptClientHello({ channelBudget,
      hello: pending.hello, identityPrivateKey: keys.pc.privateKey, httpsOrigin: origin, authorization })
    const first = accept()
    const second = accept()
    expect(first.welcome.nonce).not.toBe(second.welcome.nonce)
    expect(first.welcome.ephemeralKey).not.toBe(second.welcome.ephemeralKey)
    const next = createPhoneHandshake({ channelBudget,
      identityPrivateKey: keys.phone.privateKey, pcIdentityKey: exportPublicKey(keys.pc.publicKey),
      httpsOrigin: origin, channelId, authorization: { kind: 'grant', grantId, generation: 1 },
    })
    expect(next.hello.nonce).not.toBe(pending.hello.nonce)
    expect(next.hello.ephemeralKey).not.toBe(pending.hello.ephemeralKey)
    next.close()
    first.channel.close()
    second.channel.close()
  })
})
