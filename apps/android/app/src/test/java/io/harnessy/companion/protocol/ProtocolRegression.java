package io.harnessy.companion.protocol;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Source-only, dependency-free JVM regression entry. Not invoked by the Android app or by this change. */
public final class ProtocolRegression {
    private static final String ORIGIN = "https://relay.example";
    private ProtocolRegression() { }
    private interface Checked { void run() throws Exception; }

    public static void main(String[] arguments) throws Exception {
        hostileJsonIsRejectedAndCollectionsAreFrozen();
        canonicalPrimitivesRejectAlternates();
        invitationPinsIdentityAndCopiesTransientSecret();
        relayProofRequiresExpectedConnectionAndExactEnvelopes();
        applicationVariantsAreBoundedAndExact();
        completeHandshakeRequiresPinnedSignatureAndGrant();
        independentPeerConfirmsAndAuthenticatesBothDirections();
        sendsSerializeCountersAcrossThreads();
        allChannelFailuresAreTerminal();
    }

    private static void hostileJsonIsRejectedAndCollectionsAreFrozen() throws Exception {
        String[] rejected = { "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}", "[1,]", "{\"a\":1,}",
            "01", "+1", "NaN", "1e309", "1e-309", "true false", "\ufeff{}", "\"\\ud800\"", "\"\\udc00\"", "\"\n\"" };
        for (String json : rejected) rejects(() -> StrictJson.parse(json));
        rejects(() -> StrictJson.parse(new byte[] { (byte) 0xc0, (byte) 0xaf }));
        rejects(() -> StrictJson.parse("1234", 3));
        String deep = "0";
        for (int i = 0; i < 33; i++) deep = "[" + deep + "]";
        final String tooDeep = deep;
        rejects(() -> StrictJson.parse(tooDeep));
        List<Object> tooMany = new ArrayList<>(Collections.nCopies(513, 0));
        rejects(() -> StrictJson.stringify(tooMany));
        Map<String, Object> frozen = Protocol.record(StrictJson.parse("{\"rows\":[{\"text\":\"\\ud83d\\ude00\"}]}"));
        rejects(() -> frozen.put("extra", true));
        List<?> rows = (List<?>) frozen.get("rows");
        rejects(rows::clear);
        rejects(() -> Protocol.record(rows.get(0)).put("text", "changed"));
        check(StrictJson.utf8Length(Protocol.string(Protocol.record(rows.get(0)).get("text"))) == 4, "Supplementary UTF-8 byte count");
    }

    private static void canonicalPrimitivesRejectAlternates() throws Exception {
        check(Arrays.equals(Protocol.canonicalBytes("d", "é", new byte[] { 0, (byte) 255 }),
            hex("000000016400000002c3a90000000200ff")), "Length-prefixed raw/scalar transcript");
        for (String encoded : new String[] { "AA=", "AA==", "AB", "+w", "/w", "A", "é", " AA", "AA\n" }) {
            rejects(() -> Protocol.decodeBase64Url(encoded, -1));
        }
        for (String origin : new String[] { "http://relay.example", "https://relay.example/", "https://relay.example/path",
            "https://user@relay.example", "https://relay.example?x=1", "https://relay.example#x", "https://RELAY.example",
            "https://relay.example:443", " https://relay.example", "https://127.1", "https://0127.0.0.1",
            "https://[0:0:0:0:0:0:0:1]", "https://[::ffff:127.0.0.1]", "https://relay.example:", "https://xn--.example" }) {
            rejects(() -> Protocol.parseHttpsOrigin(origin));
        }
        for (String origin : new String[] { ORIGIN, "https://127.0.0.1", "https://[::1]", "https://[2001:db8::1]:8443",
            "https://relay.example:0", "https://xn--bcher-kva.example" }) {
            check(origin.equals(Protocol.parseHttpsOrigin(origin)), "Canonical origin admitted");
        }
        check(Protocol.integer(BigInteger.valueOf(Long.MIN_VALUE), Long.MIN_VALUE, Long.MAX_VALUE) == Long.MIN_VALUE,
            "Exact signed integer minimum is preserved");
        check(Protocol.integer(BigInteger.valueOf(Long.MAX_VALUE), Long.MIN_VALUE, Long.MAX_VALUE) == Long.MAX_VALUE,
            "Exact signed integer maximum is preserved");
        rejects(() -> Protocol.integer(BigInteger.valueOf(Long.MAX_VALUE).add(BigInteger.ONE), Long.MIN_VALUE, Long.MAX_VALUE));
        rejects(() -> Protocol.integer(BigInteger.valueOf(Long.MIN_VALUE).subtract(BigInteger.ONE), Long.MIN_VALUE, Long.MAX_VALUE));
        check("AAAAAAAAAAA".equals(Protocol.encodeCounter(0)), "Fixed counter encoding");
        BigInteger uint64Maximum = new BigInteger("ffffffffffffffff", 16);
        check("__________8".equals(Protocol.encodeCounter(uint64Maximum))
            && uint64Maximum.equals(Protocol.decodeCounter("__________8")), "Full unsigned uint64 counter encoding");
        rejects(() -> Protocol.encodeCounter(uint64Maximum.add(BigInteger.ONE)));
        Protocol.assertKeyUse(Protocol.KEY_USE_LIMIT - 1);
        rejects(() -> Protocol.assertKeyUse(-1));
        rejects(() -> Protocol.assertKeyUse(Protocol.KEY_USE_LIMIT));
        rejects(() -> Protocol.parseId16(Protocol.randomId(32)));
        for (String der : new String[] { "3006020100020101", "300702020001020101", "3006020180020101", "308106020101020101",
            "300602010102010100", "3006020101020100" }) rejects(() -> Protocol.validateSignature(hex(der)));
        byte[] order = hex("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
        byte[] outOfRange = join(hex("3026022100"), order, hex("020101"));
        rejects(() -> Protocol.validateSignature(outOfRange));
        KeyPair pair = keys();
        String spki = publicSpki(pair);
        Protocol.importPublicKey(spki);
        byte[] zeroPoint = Protocol.decodeBase64Url(spki, 91); Arrays.fill(zeroPoint, 27, 91, (byte) 0);
        rejects(() -> Protocol.importPublicKey(Protocol.encodeBase64Url(zeroPoint)));
        byte[] outsideField = Protocol.decodeBase64Url(spki, 91);
        System.arraycopy(hex("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff"), 0, outsideField, 27, 32);
        rejects(() -> Protocol.importPublicKey(Protocol.encodeBase64Url(outsideField)));
        byte[] wrongPrefix = Protocol.decodeBase64Url(spki, 91); wrongPrefix[26] = 2;
        rejects(() -> Protocol.importPublicKey(Protocol.encodeBase64Url(wrongPrefix)));
    }

    private static void invitationPinsIdentityAndCopiesTransientSecret() throws Exception {
        String spki = publicSpki(keys());
        byte[] secret = new byte[32]; Arrays.fill(secret, (byte) 0x55);
        Map<String, Object> row = Protocol.object("v", 1, "httpsOrigin", ORIGIN, "pcId", Protocol.derivePcId(spki),
            "pcIdentityKey", spki, "invitationId", Protocol.randomId(16), "expiresAt", 2000, "secret", Protocol.encodeBase64Url(secret));
        String link = link(row);
        try (Invitation invitation = Invitation.parse(link, 1000)) {
            byte[] copy = invitation.secret(); copy[0] = 0;
            check(invitation.secret()[0] == 0x55, "Invitation secret defensive copy");
            try (Protocol.Authorization authorization = invitation.authorization()) {
                KeyPair phone = keys();
                Protocol.Handshake handshake = new Protocol.Handshake(new Protocol.Inputs(publicSpki(phone), signer(phone),
                    ORIGIN, spki, Protocol.randomId(16), authorization));
                try {
                    check(MessageDigest.isEqual(mac(secret, referenceUnsignedHello(handshake.hello())),
                        Protocol.decodeBase64Url(handshake.hello().get("pairingProof"), 32)), "Invitation proof HMAC32");
                } finally { handshake.close(); }
            }
        }
        rejects(() -> Invitation.parse(link, 2000));
        rejects(() -> Invitation.parse(link + "=", 1000));
        rejects(() -> Invitation.parse(link.replace("harnessy://pair#", "https://relay.example/pair#"), 1000));
        Map<String, Object> mismatched = new LinkedHashMap<>(row); mismatched.put("pcId", Protocol.randomId(32));
        rejects(() -> Invitation.parse(link(mismatched), 1000));
        Map<String, Object> extra = new LinkedHashMap<>(row); extra.put("token", "unexpected");
        rejects(() -> Invitation.parse(link(extra), 1000));
        Invitation closed = Invitation.parse(link, 1000); closed.close(); rejects(closed::secret);
    }

    private static void relayProofRequiresExpectedConnectionAndExactEnvelopes() throws Exception {
        KeyPair phone = keys(), pc = keys();
        String phoneSpki = publicSpki(phone), pcSpki = publicSpki(pc);
        String pcId = Protocol.derivePcId(pcSpki), socket = Protocol.randomId(32);
        Map<String, Object> challenge = Protocol.object("v", 1, "type", "relay-challenge", "role", "phone", "httpsOrigin", ORIGIN,
            "identityKey", phoneSpki, "targetPcId", pcId, "socketGeneration", socket, "challenge", Protocol.randomId(32));
        Map<String, Object> proof = Protocol.relayProof(challenge, phoneSpki, signer(phone), ORIGIN, pcId, socket);
        Signature verifier = Signature.getInstance("SHA256withECDSA"); verifier.initVerify(phone.getPublic());
        verifier.update(lp("dsh-companion/relay-proof/v1", "1", "phone", ORIGIN, Protocol.decodeBase64Url(phoneSpki, 91),
            Protocol.decodeBase64Url(pcId, 32), socket, Protocol.decodeBase64Url(challenge.get("challenge"), 32)));
        check(verifier.verify(Protocol.decodeSignature(proof.get("signature"))), "Exact relay possession transcript");
        for (String field : new String[] { "role", "httpsOrigin", "identityKey", "targetPcId", "socketGeneration" }) {
            Map<String, Object> altered = new LinkedHashMap<>(challenge);
            altered.put(field, "role".equals(field) ? "pc" : "httpsOrigin".equals(field) ? "https://other.example"
                : "identityKey".equals(field) ? pcSpki : Protocol.randomId(32));
            rejects(() -> Protocol.relayProof(altered, phoneSpki, transcript -> { throw new AssertionError("Mismatched connection must not sign"); }, ORIGIN, pcId, socket));
        }
        Peer peer = new Peer();
        Map<String, Object> forwarded = Protocol.object("v", 1, "type", "relay-data", "channelId", peer.hello.get("channelId"),
            "targetPcId", Protocol.derivePcId(publicSpki(peer.pc)), "sourceRole", "pc", "sourceIdentityKey", publicSpki(peer.pc),
            "sourceSocketGeneration", Protocol.randomId(32), "targetSocketGeneration", socket, "payload", peer.welcome);
        Protocol.parseRelayData(forwarded);
        Map<String, Object> extra = new LinkedHashMap<>(forwarded); extra.put("socketGeneration", socket);
        rejects(() -> Protocol.parseRelayData(extra));
        Map<String, Object> wrongChannel = new LinkedHashMap<>(forwarded); wrongChannel.put("channelId", Protocol.randomId(16));
        rejects(() -> Protocol.parseRelayData(wrongChannel));
        Map<String, Object> outbound = Protocol.relayData(Protocol.string(peer.hello.get("channelId")), socket, peer.hello);
        check(outbound.size() == 5 && !outbound.containsKey("targetPcId"), "Distinct outbound relay envelope");
        Protocol.parseRelayReady(Protocol.object("v", 1, "type", "relay-ready", "role", "phone", "targetPcId", pcId, "socketGeneration", socket));
        peer.handshake.close();
    }

    private static void applicationVariantsAreBoundedAndExact() throws Exception {
        String request = Protocol.randomId(16), subscription = Protocol.randomId(16), submission = Protocol.randomId(16);
        Map<String, Object> row = Protocol.object("role", "assistant", "seq", Protocol.encodeCounter(0), "id", "row-1", "text", "literal <b>text</b>");
        Object[] valid = {
            Protocol.object("v", 1, "type", "sessions", "requestId", request, "sessions", Arrays.asList(Protocol.object("sessionId", "session-1", "title", "Title", "status", "idle"))),
            Protocol.object("v", 1, "type", "history", "requestId", request, "sessionId", "session-1", "rows", Arrays.asList(row)),
            Protocol.object("v", 1, "type", "watching", "requestId", request, "sessionId", "session-1", "subscriptionId", subscription),
            Protocol.object("v", 1, "type", "progress", "sessionId", "session-1", "subscriptionId", subscription, "rows", Arrays.asList(row), "status", "running"),
            Protocol.object("v", 1, "type", "submitted", "requestId", request, "sessionId", "session-1", "submissionId", submission, "admission", "inMemoryInbox"),
            Protocol.object("v", 1, "type", "cancelled", "requestId", request, "subscriptionId", subscription),
            Protocol.object("v", 1, "type", "error", "requestId", request, "code", "denied")
        };
        for (Object variant : valid) {
            String json = StrictJson.stringify(variant);
            Map<String, Object> parsed = ApplicationCodec.parseResult(json);
            rejects(() -> parsed.put("extra", "field"));
            Map<String, Object> extra = new LinkedHashMap<>(Protocol.record(variant)); extra.put("attachments", Collections.emptyList());
            rejects(() -> ApplicationCodec.parseResult(StrictJson.stringify(extra)));
        }
        byte[][] requests = { ApplicationCodec.listSessions(request, 128, null),
            ApplicationCodec.readHistory(request, "session-1", 128, null), ApplicationCodec.watchProgress(request, "session-1", "AA"),
            ApplicationCodec.submitText(request, "session-1", "text", submission), ApplicationCodec.cancelRead(request, subscription) };
        for (byte[] encoded : requests) ApplicationCodec.parseRequest(encoded);
        rejects(() -> ApplicationCodec.listSessions(request, 129, null));
        rejects(() -> ApplicationCodec.submitText(request, "session-1", "", submission));
        rejects(() -> ApplicationCodec.submitText(request, "session-1", repeat("é", 4097), submission));
        ApplicationCodec.submitText(request, "session-1", repeat("é", 4096), submission);
        Map<String, Object> duplicatedRows = new LinkedHashMap<>(Protocol.record(valid[1])); duplicatedRows.put("rows", Arrays.asList(row, row));
        rejects(() -> ApplicationCodec.parseResult(StrictJson.stringify(duplicatedRows)));
        Map<String, Object> wrongAdmission = new LinkedHashMap<>(Protocol.record(valid[4])); wrongAdmission.put("admission", "durable");
        rejects(() -> ApplicationCodec.parseResult(StrictJson.stringify(wrongAdmission)));
        List<Object> hugeRows = new ArrayList<>();
        for (int i = 0; i < 128; i++) hugeRows.add(Protocol.object("role", "notice", "seq", Protocol.encodeCounter(i), "id", "row-" + i, "text", repeat("x", 512)));
        Map<String, Object> huge = new LinkedHashMap<>(Protocol.record(valid[1])); huge.put("rows", hugeRows);
        rejects(() -> ApplicationCodec.parseResult(StrictJson.stringify(huge)));
    }

    private static void completeHandshakeRequiresPinnedSignatureAndGrant() throws Exception {
        Peer first = new Peer();
        Peer second = new Peer(first.phone, first.pc);
        check(!first.hello.get("nonce").equals(second.hello.get("nonce")), "Reconnect gets nonce32");
        check(!first.hello.get("ephemeralKey").equals(second.hello.get("ephemeralKey")), "Reconnect gets new ephemeral key");
        check(Arrays.equals(referenceUnsignedHello(first.hello), Protocol.unsignedHelloBytes(first.hello)), "Exact native unsigned transcript field order");
        check(Arrays.equals(referenceWelcomeInput(first.hello, first.welcome), Protocol.welcomeSignatureBytes(first.hello, first.welcome)), "Complete welcome transcript");
        Map<String, Object> altered = new LinkedHashMap<>(first.welcome); altered.put("grantId", Protocol.randomId(16));
        altered.put("signature", Protocol.encodeBase64Url(sign(first.pc, referenceWelcomeInput(first.hello, altered))));
        rejects(() -> first.handshake.complete(altered));
        rejects(() -> first.handshake.complete(first.welcome));
        second.handshake.close(); rejects(() -> second.handshake.complete(second.welcome));
        Peer untrusted = new Peer();
        Map<String, Object> badSignature = new LinkedHashMap<>(untrusted.welcome);
        badSignature.put("signature", Protocol.encodeBase64Url(sign(keys(), referenceWelcomeInput(untrusted.hello, untrusted.welcome))));
        rejects(() -> untrusted.handshake.complete(badSignature));
        KeyPair supplied = keys(), wrongSigner = keys(), pc = keys();
        rejects(() -> new Protocol.Handshake(new Protocol.Inputs(publicSpki(supplied), signer(wrongSigner), ORIGIN,
            publicSpki(pc), Protocol.randomId(16), Protocol.Authorization.grant(Protocol.randomId(16), 1))));
    }

    private static void independentPeerConfirmsAndAuthenticatesBothDirections() throws Exception {
        Peer peer = new Peer();
        try (Protocol.Channel channel = peer.handshake.complete(peer.welcome)) {
            check(!channel.confirmed(), "New channel unconfirmed");
            channel.sendConfirmation(serialized -> { peer.assertPhonePayload(serialized, peer.confirmation("phone-to-pc")); return true; });
            check(!channel.confirmed(), "Local queue acceptance is not mutual confirmation");
            check(channel.receive(peer.frame(peer.confirmation("pc-to-phone"))) == null, "Confirmation is not dispatchable plaintext");
            check(channel.confirmed(), "Both confirmations complete");
            byte[] text = "literal 中文".getBytes(StandardCharsets.UTF_8);
            channel.sendApplication(text, serialized -> { peer.assertPhonePayload(serialized, join(new byte[] { 1 }, text)); return true; });
            check(Arrays.equals(text, channel.receive(peer.frame(join(new byte[] { 1 }, text)))), "Authenticated inbound application");
            channel.sendApplication(new byte[0], serialized -> { peer.assertPhonePayload(serialized, new byte[] { 1 }); return true; });
            check(channel.receive(peer.frame(new byte[] { 1 })).length == 0, "Empty application is permitted");
        }
    }

    private static void sendsSerializeCountersAcrossThreads() throws Exception {
        Peer peer = new Peer();
        Protocol.Channel channel = confirmed(peer);
        ExecutorService executor = Executors.newFixedThreadPool(4);
        try {
            List<Future<?>> calls = new ArrayList<>();
            for (int i = 0; i < 16; i++) {
                calls.add(executor.submit(() -> {
                    try { channel.sendApplication(new byte[] { 7 }, serialized -> { peer.assertPhonePayload(serialized, new byte[] { 1, 7 }); return true; }); }
                    catch (Exception failure) { throw new RuntimeException(failure); }
                }));
            }
            for (Future<?> call : calls) call.get(10, TimeUnit.SECONDS);
            check(peer.phoneCounter == 17, "Concurrent send counters remain contiguous");
        } finally {
            channel.close(); executor.shutdownNow();
            check(executor.awaitTermination(10, TimeUnit.SECONDS), "Executor teardown reaches quiescence");
        }
    }

    private static void allChannelFailuresAreTerminal() throws Exception {
        Peer early = new Peer();
        Protocol.Channel premature = early.handshake.complete(early.welcome);
        rejects(() -> premature.sendApplication(new byte[0], serialized -> true)); check(premature.isClosed(), "Premature send closes");
        for (int scenario = 0; scenario < 6; scenario++) {
            Peer peer = new Peer(); Protocol.Channel channel = confirmed(peer);
            final int selected = scenario;
            if (selected == 0) rejects(() -> channel.sendApplication(new byte[Protocol.MAX_APPLICATION_BYTES + 1], serialized -> true));
            else if (selected == 1) rejects(() -> channel.sendApplication(new byte[0], serialized -> false));
            else if (selected == 2) rejects(() -> channel.sendConfirmation(serialized -> true));
            else if (selected == 3) rejects(() -> channel.receive(Protocol.object("v", 1, "type", "encrypted")));
            else if (selected == 4) {
                Map<String, Object> frame = new LinkedHashMap<>(peer.frame(new byte[] { 1 }));
                byte[] tag = Protocol.decodeBase64Url(frame.get("tag"), 16); tag[0] ^= 1;
                frame.put("tag", Protocol.encodeBase64Url(tag)); rejects(() -> channel.receive(frame));
            } else {
                Map<String, Object> frame = peer.frame(new byte[] { 1 }); channel.receive(frame); rejects(() -> channel.receive(frame));
            }
            check(channel.isClosed() && !channel.confirmed(), "Rejected operation permanently closes channel");
            rejects(() -> channel.sendApplication(new byte[0], serialized -> true));
            rejects(() -> channel.receive(peer.frame(new byte[] { 1 })));
        }
        Peer abrupt = new Peer(); Protocol.Channel channel = confirmed(abrupt);
        AssertionError senderFailure = new AssertionError("Queue accepted before abrupt sender failure");
        boolean propagated = false;
        try {
            channel.sendApplication(new byte[] { 9 }, serialized -> {
                abrupt.assertPhonePayload(serialized, new byte[] { 1, 9 });
                throw senderFailure;
            });
        } catch (AssertionError failure) {
            check(failure == senderFailure, "Sender Error propagates unchanged"); propagated = true;
        }
        check(propagated && channel.isClosed() && !channel.confirmed(), "Abrupt accepted send cannot reuse its nonce");
        rejects(() -> channel.sendApplication(new byte[] { 10 }, serialized -> true));
    }

    private static Protocol.Channel confirmed(Peer peer) throws Exception {
        Protocol.Channel channel = peer.handshake.complete(peer.welcome);
        channel.sendConfirmation(serialized -> { peer.assertPhonePayload(serialized, peer.confirmation("phone-to-pc")); return true; });
        channel.receive(peer.frame(peer.confirmation("pc-to-phone"))); return channel;
    }

    /** Independent PC-side JCA peer uses the frozen ordered field list, not Protocol's transcript/HKDF helpers. */
    private static final class Peer {
        final KeyPair phone;
        final KeyPair pc;
        final Protocol.Handshake handshake;
        final Map<String, Object> hello;
        final Map<String, Object> welcome;
        final byte[] transcript;
        final byte[] phoneKey;
        final byte[] phonePrefix;
        final byte[] pcKey;
        final byte[] pcPrefix;
        long phoneCounter;
        long pcCounter;
        Peer() throws Exception { this(keys(), keys()); }
        Peer(KeyPair phone, KeyPair pc) throws Exception {
            this.phone = phone; this.pc = pc;
            String grant = Protocol.randomId(16);
            handshake = new Protocol.Handshake(new Protocol.Inputs(publicSpki(phone), signer(phone), ORIGIN,
                publicSpki(pc), Protocol.randomId(16), Protocol.Authorization.grant(grant, 1)));
            hello = handshake.hello();
            KeyPair ephemeral = keys();
            Map<String, Object> unsigned = Protocol.object("v", 1, "type", "welcome", "suite", Protocol.SUITE, "role", "pc",
                "channelId", hello.get("channelId"), "nonce", Protocol.randomId(32), "ephemeralKey", publicSpki(ephemeral), "grantId", grant, "generation", 1);
            byte[] input = referenceWelcomeInput(hello, unsigned);
            byte[] signature = sign(pc, input);
            Map<String, Object> signed = new LinkedHashMap<>(unsigned); signed.put("signature", Protocol.encodeBase64Url(signature));
            welcome = Protocol.record(StrictJson.freeze(signed));
            transcript = digest(lp("dsh-companion/transcript/v1", input, signature));
            KeyAgreement ecdh = KeyAgreement.getInstance("ECDH"); ecdh.init(ephemeral.getPrivate());
            ecdh.doPhase(Protocol.importPublicKey(hello.get("ephemeralKey")), true);
            byte[] shared = ecdh.generateSecret();
            byte[] salt = digest(lp("dsh-companion/hkdf-salt/v1", Protocol.decodeBase64Url(hello.get("nonce"), 32), Protocol.decodeBase64Url(welcome.get("nonce"), 32)));
            byte[] prk = mac(salt, shared);
            try {
                phoneKey = expand(prk, transcript, "phone-to-pc", "aes-256-gcm-key", 32);
                phonePrefix = expand(prk, transcript, "phone-to-pc", "aes-256-gcm-nonce-prefix", 4);
                pcKey = expand(prk, transcript, "pc-to-phone", "aes-256-gcm-key", 32);
                pcPrefix = expand(prk, transcript, "pc-to-phone", "aes-256-gcm-nonce-prefix", 4);
            } finally { Arrays.fill(shared, (byte) 0); Arrays.fill(prk, (byte) 0); }
        }
        byte[] confirmation(String direction) throws IOException { return join(new byte[] { 0 }, lp("dsh-companion/key-confirmation/v1", transcript, direction)); }
        Map<String, Object> frame(byte[] plaintext) throws Exception {
            Map<String, Object> metadata = Protocol.object("v", 1, "type", "encrypted", "direction", "pc-to-phone",
                "channelId", hello.get("channelId"), "grantId", welcome.get("grantId"), "generation", 1, "counter", Protocol.encodeCounter(pcCounter));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(pcKey, "AES"), new GCMParameterSpec(128, join(pcPrefix, ByteBuffer.allocate(8).putLong(pcCounter).array())));
            cipher.updateAAD(referenceAad(metadata));
            byte[] sealed = cipher.doFinal(plaintext); pcCounter++;
            Map<String, Object> frame = new LinkedHashMap<>(metadata);
            frame.put("ciphertext", Protocol.encodeBase64Url(Arrays.copyOf(sealed, sealed.length - 16)));
            frame.put("tag", Protocol.encodeBase64Url(Arrays.copyOfRange(sealed, sealed.length - 16, sealed.length)));
            return frame;
        }
        void assertPhonePayload(String serialized, byte[] expected) throws IOException {
            try {
                Map<String, Object> frame = Protocol.record(StrictJson.parse(serialized));
                check("phone-to-pc".equals(frame.get("direction")), "Phone direction");
                check(Protocol.encodeCounter(phoneCounter).equals(frame.get("counter")), "Exact next send counter");
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(phoneKey, "AES"), new GCMParameterSpec(128, join(phonePrefix, ByteBuffer.allocate(8).putLong(phoneCounter).array())));
                cipher.updateAAD(referenceAad(frame));
                byte[] plaintext = cipher.doFinal(join(Protocol.decodeBase64Url(frame.get("ciphertext"), -1), Protocol.decodeBase64Url(frame.get("tag"), 16)));
                check(Arrays.equals(plaintext, expected), "Independent peer decrypts complete frame"); phoneCounter++;
            } catch (GeneralSecurityException failure) { throw new IOException(failure); }
        }
    }

    private static byte[] referenceUnsignedHello(Map<String, Object> hello) throws IOException {
        Map<String, Object> auth = Protocol.record(hello.get("authorization"));
        List<Object> fields = new ArrayList<>(Arrays.asList("1", Protocol.SUITE, "phone", hello.get("httpsOrigin"), hello.get("channelId"),
            Protocol.decodeBase64Url(hello.get("phoneIdentityKey"), 91), Protocol.decodeBase64Url(hello.get("pcIdentityKey"), 91),
            Protocol.decodeBase64Url(hello.get("nonce"), 32), Protocol.decodeBase64Url(hello.get("ephemeralKey"), 91), auth.get("kind")));
        if ("grant".equals(auth.get("kind"))) { fields.add(auth.get("grantId")); fields.add(Long.toString(Protocol.integer(auth.get("generation"), 1, 0xffffffffL))); }
        else fields.add(auth.get("invitationId"));
        return lp("dsh-companion/hello/v1", fields.toArray());
    }
    private static byte[] referenceWelcomeInput(Map<String, Object> hello, Map<String, Object> welcome) throws IOException {
        byte[] phoneInput = lp("dsh-companion/hello-signature/v1", referenceUnsignedHello(hello), Protocol.decodeBase64Url(hello.get("pairingProof"), -1));
        byte[] signed = lp("dsh-companion/signed-hello/v1", phoneInput, Protocol.decodeSignature(hello.get("signature")));
        return lp("dsh-companion/welcome-signature/v1", signed, "1", Protocol.SUITE, "pc", welcome.get("channelId"),
            Protocol.decodeBase64Url(welcome.get("nonce"), 32), Protocol.decodeBase64Url(welcome.get("ephemeralKey"), 91), welcome.get("grantId"),
            Long.toString(Protocol.integer(welcome.get("generation"), 1, 0xffffffffL)));
    }
    private static byte[] referenceAad(Map<String, Object> frame) throws IOException {
        return lp("dsh-companion/frame-aad/v1", "1", frame.get("direction"), frame.get("channelId"), frame.get("grantId"),
            Long.toString(Protocol.integer(frame.get("generation"), 1, 0xffffffffL)), Protocol.decodeBase64Url(frame.get("counter"), 8));
    }
    private static byte[] lp(String domain, Object... fields) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
        List<Object> all = new ArrayList<>(); all.add(domain); all.addAll(Arrays.asList(fields));
        for (Object field : all) {
            byte[] raw = field instanceof byte[] ? (byte[]) field : ((String) field).getBytes(StandardCharsets.UTF_8);
            out.writeInt(raw.length); out.write(raw);
        }
        return bytes.toByteArray();
    }
    private static byte[] expand(byte[] prk, byte[] transcript, String direction, String label, int length) throws Exception {
        return Arrays.copyOf(mac(prk, join(lp("dsh-companion/hkdf-info/v1", transcript, direction, label), new byte[] { 1 })), length);
    }
    private static KeyPair keys() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC"); generator.initialize(new ECGenParameterSpec("secp256r1")); return generator.generateKeyPair();
    }
    private static String publicSpki(KeyPair pair) { return Protocol.encodeBase64Url(pair.getPublic().getEncoded()); }
    private static Protocol.Signer signer(KeyPair pair) { return transcript -> sign(pair, transcript); }
    private static byte[] sign(KeyPair pair, byte[] transcript) throws GeneralSecurityException {
        Signature signature = Signature.getInstance("SHA256withECDSA"); signature.initSign(pair.getPrivate()); signature.update(transcript); return signature.sign();
    }
    private static byte[] mac(byte[] key, byte[] bytes) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256")); return mac.doFinal(bytes);
    }
    private static byte[] digest(byte[] bytes) throws GeneralSecurityException { return MessageDigest.getInstance("SHA-256").digest(bytes); }
    private static byte[] join(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); for (byte[] part : parts) out.write(part, 0, part.length); return out.toByteArray();
    }
    private static String link(Object row) { return "harnessy://pair#" + Protocol.encodeBase64Url(StrictJson.stringify(row).getBytes(StandardCharsets.UTF_8)); }
    private static String repeat(String text, int count) { StringBuilder out = new StringBuilder(); for (int i = 0; i < count; i++) out.append(text); return out.toString(); }
    private static byte[] hex(String text) {
        byte[] bytes = new byte[text.length() / 2]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16); return bytes;
    }
    private static void rejects(Checked operation) throws Exception {
        try { operation.run(); }
        catch (IllegalArgumentException | IllegalStateException | UnsupportedOperationException | GeneralSecurityException | IOException expected) { return; }
        throw new AssertionError("Invalid operation unexpectedly accepted");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
