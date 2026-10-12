/** Real native-crypto fixtures; no relay, network, persistence, or simulated authorization service. */
import {
  acceptClientHello, createPhoneHandshake, exportPublicKey, generateP256KeyPair, parseChannelBudget, parseHttpsOrigin, parseId,
} from '../src/index.ts'
import type { AuthorizedHandshake, ChannelBudget, ChannelId, EncryptedChannel, EncryptedFrame, GrantId, InvitationId } from '../src/index.ts'

export const origin = parseHttpsOrigin('https://relay.example')
export const grantId = parseId<GrantId>('grant-test')
export const invitationId = parseId<InvitationId>('invitation-test')
export const channelId = parseId<ChannelId>('channel-test')
export const channelBudget = parseChannelBudget({
  maxQueuedSendBytes: 1_048_576, maxQueuedReceiveBytes: 1_048_576,
  maxPendingSends: 32, maxPendingReceives: 32, sendTimeoutMs: 5000,
})

export function identities() {
  return { phone: generateP256KeyPair(), pc: generateP256KeyPair() }
}

export function pendingGrant(keys = identities(), limits: ChannelBudget = channelBudget) {
  const pending = createPhoneHandshake({ channelBudget: limits,
    identityPrivateKey: keys.phone.privateKey, pcIdentityKey: exportPublicKey(keys.pc.publicKey),
    httpsOrigin: origin, channelId, authorization: { kind: 'grant', grantId, generation: 1 },
  })
  const authorization: AuthorizedHandshake = {
    kind: 'grant', phoneIdentityKey: exportPublicKey(keys.phone.publicKey), grantId, generation: 1,
  }
  return { keys, pending, authorization }
}

export function connectedGrant(keys = identities(), limits: ChannelBudget = channelBudget) {
  const fixture = pendingGrant(keys, limits)
  const accepted = acceptClientHello({ channelBudget: limits,
    hello: fixture.pending.hello, identityPrivateKey: fixture.keys.pc.privateKey,
    httpsOrigin: origin, authorization: fixture.authorization,
  })
  return { ...fixture, accepted, phoneChannel: fixture.pending.complete(accepted.welcome), pcChannel: accepted.channel }
}

export async function confirmChannels(phone: EncryptedChannel, pc: EncryptedChannel): Promise<void> {
  let phoneFrame: EncryptedFrame | undefined
  let pcFrame: EncryptedFrame | undefined
  await phone.sendConfirmation(async (frame) => { phoneFrame = frame })
  await pc.sendConfirmation(async (frame) => { pcFrame = frame })
  await phone.receive(pcFrame)
  await pc.receive(phoneFrame)
}

export async function capturedApplication(channel: EncryptedChannel, plaintext = Buffer.from('command')): Promise<EncryptedFrame> {
  let captured: EncryptedFrame | undefined
  await channel.sendApplication(plaintext, async (frame) => { captured = frame })
  if (captured === undefined) throw new Error('Channel did not emit an application frame')
  return captured
}
