package io.harnessy.companion.protocol;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.IDN;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Pure Java phone protocol. Trust storage, transport lifetime and application admission belong to callers.
 * Close erases owned byte buffers best effort; immutable strings and provider-internal key copies cannot be erased.
 */
public final class Protocol {
    public static final String SUITE = "P256-SHA256-HKDF-A256GCM";
    public static final int MAX_APPLICATION_BYTES = 65_536;
    public static final long KEY_USE_LIMIT = 1_048_576L;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final byte[] SPKI_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d03010703420004");
    private static final BigInteger FIELD = new BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16);
    private static final BigInteger A = FIELD.subtract(BigInteger.valueOf(3));
    private static final BigInteger B = new BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16);
    private static final BigInteger ORDER = new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    private static final BigInteger GX = new BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16);
    private static final BigInteger GY = new BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16);

    private Protocol() { }

    /** Signs the supplied transcript with a caller-owned identity, without exporting its private key. */
    public interface Signer {
        byte[] sign(byte[] transcript) throws GeneralSecurityException, IOException;
    }

    /** Must accept the complete text into a local ordered queue, never wait for peer acknowledgement or reenter Channel. */
    public interface Sender {
        boolean send(String serializedFrame) throws IOException;
    }

    public static final class Authorization implements AutoCloseable {
        public final String kind;
        public final String id;
        public final long generation;
        private byte[] secret;
        private Authorization(String kind, String id, long generation, byte[] secret) {
            this.kind = kind;
            this.id = parseId(id);
            this.generation = generation;
            this.secret = secret == null ? null : secret.clone();
        }
        public static Authorization grant(String grantId, long generation) {
            integer(generation, 1, 0xffffffffL);
            return new Authorization("grant", grantId, generation, null);
        }
        public static Authorization invitation(String invitationId, byte[] secret32) {
            if (secret32 == null || secret32.length != 32) throw invalid("Expected invitation secret32");
            return new Authorization("invitation", invitationId, 0, secret32);
        }
        private synchronized byte[] secretCopy() {
            if (secret == null) throw invalid("Invitation authorization closed");
            return secret.clone();
        }
        public synchronized void close() { erase(secret); secret = null; }
        private Map<String, Object> reference() {
            return "grant".equals(kind) ? object("kind", kind, "grantId", id, "generation", generation)
                : object("kind", kind, "invitationId", id);
        }
    }

    /** Immutable public inputs; the transient Authorization secret remains caller-owned until close. */
    public static final class Inputs {
        public final String publicPhoneSpki;
        public final Signer signer;
        public final String origin;
        public final String pinnedPcSpki;
        public final String channelId;
        public final Authorization authorization;
        public Inputs(String publicPhoneSpki, Signer signer, String origin, String pinnedPcSpki,
                      String channelId, Authorization authorization) throws GeneralSecurityException {
            if (signer == null || authorization == null) throw invalid("Missing handshake inputs");
            this.publicPhoneSpki = parsePublicKey(publicPhoneSpki);
            this.signer = signer;
            this.origin = parseHttpsOrigin(origin);
            this.pinnedPcSpki = parsePublicKey(pinnedPcSpki);
            this.channelId = parseId16(channelId);
            this.authorization = authorization;
        }
    }

    /** One fresh attempt. Success, failure and close consume its ephemeral private key exactly once. */
    public static final class Handshake implements AutoCloseable {
        private final Map<String, Object> hello;
        private PrivateKey ephemeral;
        public Handshake(Inputs inputs) throws GeneralSecurityException, IOException {
            if (inputs == null) throw invalid("Missing handshake inputs");
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            KeyPair pair = generator.generateKeyPair();
            PrivateKey privateKey = pair.getPrivate();
            byte[] secret = null;
            byte[] proof = null;
            try {
                Map<String, Object> unsigned = object("v", 1, "type", "hello", "suite", SUITE, "role", "phone",
                    "httpsOrigin", inputs.origin, "channelId", inputs.channelId,
                    "phoneIdentityKey", inputs.publicPhoneSpki, "pcIdentityKey", inputs.pinnedPcSpki,
                    "nonce", randomId(32), "ephemeralKey", parsePublicKey(encodeBase64Url(pair.getPublic().getEncoded())),
                    "authorization", inputs.authorization.reference());
                if ("invitation".equals(inputs.authorization.kind)) {
                    secret = inputs.authorization.secretCopy();
                    proof = hmac(secret, unsignedHelloBytes(unsigned));
                } else proof = new byte[0];
                Map<String, Object> proofBound = new LinkedHashMap<>(unsigned);
                proofBound.put("pairingProof", encodeBase64Url(proof));
                byte[] transcript = helloSignatureBytes(proofBound);
                byte[] signature = inputs.signer.sign(transcript.clone());
                validateSignature(signature);
                if (!verify(inputs.publicPhoneSpki, transcript, signature)) throw invalid("Signer does not match supplied public key");
                proofBound.put("signature", encodeBase64Url(signature));
                hello = parseClientHello(proofBound);
                ephemeral = privateKey;
                privateKey = null;
            } finally {
                erase(secret); erase(proof); destroy(privateKey);
            }
        }
        public Map<String, Object> hello() { return hello; }
        public String helloJson() { return StrictJson.stringify(hello); }
        public synchronized Channel complete(Object wire) throws GeneralSecurityException {
            PrivateKey captured = ephemeral;
            ephemeral = null;
            if (captured == null) throw invalid("Handshake already consumed");
            byte[] shared = null;
            try {
                Map<String, Object> welcome = parsePcWelcome(wire);
                if (!hello.get("channelId").equals(welcome.get("channelId"))
                    || !verify(string(hello.get("pcIdentityKey")), welcomeSignatureBytes(hello, welcome),
                        decodeSignature(welcome.get("signature")))) throw invalid("PC welcome authentication failed");
                Map<String, Object> authorization = record(hello.get("authorization"));
                if ("grant".equals(authorization.get("kind"))
                    && (!authorization.get("grantId").equals(welcome.get("grantId"))
                    || integer(authorization.get("generation"), 1, 0xffffffffL)
                        != integer(welcome.get("generation"), 1, 0xffffffffL))) throw invalid("Welcome grant mismatch");
                KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
                agreement.init(captured);
                agreement.doPhase(importPublicKey(welcome.get("ephemeralKey")), true);
                shared = agreement.generateSecret();
                if (shared.length != 32) throw invalid("Expected ECDH secret32");
                return new Channel(hello, welcome, shared);
            } finally { erase(shared); destroy(captured); }
        }
        public synchronized void close() { destroy(ephemeral); ephemeral = null; }
    }

    /** A single monitor serializes counters, local writes and authenticated receives; every failed operation is terminal. */
    public static final class Channel implements AutoCloseable {
        private final String channelId;
        private final String grantId;
        private final long generation;
        private byte[] sendKey;
        private byte[] receiveKey;
        private byte[] sendPrefix;
        private byte[] receivePrefix;
        private byte[] transcriptHash;
        private long sendCounter;
        private long receiveCounter;
        private boolean sentConfirmation;
        private boolean receivedConfirmation;
        private boolean closed;
        private boolean operating;

        private Channel(Map<String, Object> hello, Map<String, Object> welcome, byte[] shared) throws GeneralSecurityException {
            channelId = string(hello.get("channelId"));
            grantId = string(welcome.get("grantId"));
            generation = integer(welcome.get("generation"), 1, 0xffffffffL);
            byte[] salt = null;
            byte[] prk = null;
            try {
                transcriptHash = sha256(canonicalBytes("dsh-companion/transcript/v1",
                    welcomeSignatureBytes(hello, welcome), decodeSignature(welcome.get("signature"))));
                salt = sha256(canonicalBytes("dsh-companion/hkdf-salt/v1",
                    decodeBase64Url(hello.get("nonce"), 32), decodeBase64Url(welcome.get("nonce"), 32)));
                prk = hmac(salt, shared);
                sendKey = derive(prk, "phone-to-pc", "aes-256-gcm-key", 32);
                sendPrefix = derive(prk, "phone-to-pc", "aes-256-gcm-nonce-prefix", 4);
                receiveKey = derive(prk, "pc-to-phone", "aes-256-gcm-key", 32);
                receivePrefix = derive(prk, "pc-to-phone", "aes-256-gcm-nonce-prefix", 4);
            } catch (GeneralSecurityException | RuntimeException | Error failure) {
                close(); throw failure;
            } finally { erase(salt); erase(prk); }
        }
        private byte[] derive(byte[] prk, String direction, String label, int length) throws GeneralSecurityException {
            byte[] info = canonicalBytes("dsh-companion/hkdf-info/v1", transcriptHash, direction, label);
            byte[] output = hmac(prk, concat(info, new byte[] { 1 }));
            try { return Arrays.copyOf(output, length); } finally { erase(output); }
        }
        public String channelId() { return channelId; }
        public String grantId() { return grantId; }
        public long generation() { return generation; }
        public synchronized boolean confirmed() { return !closed && sentConfirmation && receivedConfirmation; }
        public synchronized boolean isClosed() { return closed; }
        public synchronized void close() {
            closed = true;
            erase(sendKey); erase(receiveKey); erase(sendPrefix); erase(receivePrefix); erase(transcriptHash);
        }
        private void begin() {
            if (closed || operating) throw invalid("Channel closed or callback reentered channel");
            operating = true;
        }
        public synchronized void sendConfirmation(Sender sender) throws GeneralSecurityException, IOException {
            byte[] payload = null;
            try {
                begin();
                if (sentConfirmation) throw invalid("Duplicate key confirmation");
                payload = concat(new byte[] { 0 }, confirmation("phone-to-pc"));
                write(payload, sender);
                sentConfirmation = true;
            } catch (GeneralSecurityException | IOException | RuntimeException | Error failure) {
                close(); throw failure;
            } finally { erase(payload); operating = false; }
        }
        public synchronized void sendApplication(byte[] plaintext, Sender sender) throws GeneralSecurityException, IOException {
            byte[] payload = null;
            try {
                begin();
                if (plaintext == null || plaintext.length > MAX_APPLICATION_BYTES) throw invalid("Application payload exceeds limit");
                if (!confirmed()) throw invalid("Mutual confirmation required");
                payload = concat(new byte[] { 1 }, plaintext);
                write(payload, sender);
            } catch (GeneralSecurityException | IOException | RuntimeException | Error failure) {
                close(); throw failure;
            } finally { erase(payload); operating = false; }
        }
        private void write(byte[] plaintext, Sender sender) throws GeneralSecurityException, IOException {
            assertKeyUse(sendCounter);
            if (sender == null) throw invalid("Missing sender");
            Map<String, Object> metadata = object("v", 1, "type", "encrypted", "direction", "phone-to-pc",
                "channelId", channelId, "grantId", grantId, "generation", generation, "counter", encodeCounter(sendCounter));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(sendKey, "AES"), new GCMParameterSpec(128, nonce(sendPrefix, sendCounter)));
            cipher.updateAAD(frameAdditionalData(metadata));
            byte[] sealed = cipher.doFinal(plaintext);
            try {
                Map<String, Object> frame = new LinkedHashMap<>(metadata);
                frame.put("ciphertext", encodeBase64Url(Arrays.copyOf(sealed, sealed.length - 16)));
                frame.put("tag", encodeBase64Url(Arrays.copyOfRange(sealed, sealed.length - 16, sealed.length)));
                if (!sender.send(StrictJson.stringify(frame))) throw new IOException("Local frame queue rejected send");
                if (closed) throw invalid("Channel closed during send");
                sendCounter++;
            } finally { erase(sealed); }
        }
        /** Returns a fresh application byte array, or null for verified confirmation; authentication precedes counter advancement. */
        public synchronized byte[] receive(Object wire) throws GeneralSecurityException {
            byte[] plaintext = null;
            try {
                begin();
                Map<String, Object> frame = parseEncryptedFrame(wire);
                assertKeyUse(receiveCounter);
                if (!"pc-to-phone".equals(frame.get("direction")) || !channelId.equals(frame.get("channelId"))
                    || !grantId.equals(frame.get("grantId")) || generation != integer(frame.get("generation"), 1, 0xffffffffL)
                    || !MessageDigest.isEqual(counterBytes(receiveCounter), decodeBase64Url(frame.get("counter"), 8))) {
                    throw invalid("Frame order or routing mismatch");
                }
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(receiveKey, "AES"),
                    new GCMParameterSpec(128, nonce(receivePrefix, receiveCounter)));
                cipher.updateAAD(frameAdditionalData(frame));
                plaintext = cipher.doFinal(concat(decodeBase64Url(frame.get("ciphertext"), -1, MAX_APPLICATION_BYTES + 1),
                    decodeBase64Url(frame.get("tag"), 16)));
                byte[] result;
                if (!receivedConfirmation) {
                    byte[] expected = concat(new byte[] { 0 }, confirmation("pc-to-phone"));
                    try {
                        if (!MessageDigest.isEqual(expected, plaintext)) throw invalid("Invalid encrypted key confirmation");
                    } finally { erase(expected); }
                    receivedConfirmation = true;
                    result = null;
                } else {
                    if (!confirmed() || plaintext.length == 0 || plaintext[0] != 1) throw invalid("Application before confirmation or invalid payload tag");
                    result = Arrays.copyOfRange(plaintext, 1, plaintext.length);
                }
                receiveCounter++;
                return result;
            } catch (GeneralSecurityException | RuntimeException | Error failure) {
                close(); throw failure;
            } finally { erase(plaintext); operating = false; }
        }
        private byte[] confirmation(String direction) {
            return canonicalBytes("dsh-companion/key-confirmation/v1", transcriptHash, direction);
        }
    }

    public static Map<String, Object> parseClientHello(Object wire) throws GeneralSecurityException {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "suite", "role", "httpsOrigin", "channelId",
            "phoneIdentityKey", "pcIdentityKey", "nonce", "ephemeralKey", "authorization", "pairingProof", "signature");
        fixed(row, "hello", "phone");
        parseHttpsOrigin(row.get("httpsOrigin")); parseId16(row.get("channelId"));
        parsePublicKey(row.get("phoneIdentityKey")); parsePublicKey(row.get("pcIdentityKey"));
        decodeBase64Url(row.get("nonce"), 32); parsePublicKey(row.get("ephemeralKey"));
        Map<String, Object> authorization = record(row.get("authorization"));
        if ("grant".equals(authorization.get("kind"))) {
            exactRecord(authorization, "kind", "grantId", "generation");
            parseId(authorization.get("grantId")); integer(authorization.get("generation"), 1, 0xffffffffL);
            decodeBase64Url(row.get("pairingProof"), 0);
        } else if ("invitation".equals(authorization.get("kind"))) {
            exactRecord(authorization, "kind", "invitationId");
            parseId(authorization.get("invitationId")); decodeBase64Url(row.get("pairingProof"), 32);
        } else throw invalid("Invalid authorization kind");
        decodeSignature(row.get("signature"));
        return row;
    }
    public static Map<String, Object> parsePcWelcome(Object wire) throws GeneralSecurityException {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "suite", "role", "channelId", "nonce", "ephemeralKey", "grantId", "generation", "signature");
        fixed(row, "welcome", "pc"); parseId16(row.get("channelId")); decodeBase64Url(row.get("nonce"), 32);
        parsePublicKey(row.get("ephemeralKey")); parseId(row.get("grantId"));
        integer(row.get("generation"), 1, 0xffffffffL); decodeSignature(row.get("signature"));
        return row;
    }
    public static Map<String, Object> parseEncryptedFrame(Object wire) {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "direction", "channelId", "grantId", "generation", "counter", "ciphertext", "tag");
        version(row);
        if (!"encrypted".equals(row.get("type")) || (!"phone-to-pc".equals(row.get("direction"))
            && !"pc-to-phone".equals(row.get("direction")))) throw invalid("Invalid encrypted frame type or direction");
        parseId16(row.get("channelId")); parseId(row.get("grantId")); integer(row.get("generation"), 1, 0xffffffffL);
        decodeBase64Url(row.get("counter"), 8); decodeBase64Url(row.get("ciphertext"), -1, MAX_APPLICATION_BYTES + 1);
        decodeBase64Url(row.get("tag"), 16);
        return row;
    }
    public static Map<String, Object> parseRelayChallenge(Object wire) throws GeneralSecurityException {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "role", "httpsOrigin", "identityKey", "targetPcId", "socketGeneration", "challenge");
        version(row);
        if (!"relay-challenge".equals(row.get("type")) || (!"phone".equals(row.get("role")) && !"pc".equals(row.get("role")))) throw invalid("Invalid relay challenge");
        parseHttpsOrigin(row.get("httpsOrigin")); parsePublicKey(row.get("identityKey")); parsePcId(row.get("targetPcId"));
        parseSocketGeneration(row.get("socketGeneration")); decodeBase64Url(row.get("challenge"), 32);
        if ("pc".equals(row.get("role")) && !derivePcId(string(row.get("identityKey"))).equals(row.get("targetPcId"))) throw invalid("PC relay identity mismatch");
        return row;
    }
    /** Validates every expected connection field before asking the identity signer to sign. */
    public static Map<String, Object> relayProof(Object wire, String publicPhoneSpki, Signer signer,
                                               String origin, String pcId, String socketGeneration)
        throws GeneralSecurityException, IOException {
        Map<String, Object> row = parseRelayChallenge(wire);
        if (!"phone".equals(row.get("role")) || !parsePublicKey(publicPhoneSpki).equals(row.get("identityKey"))
            || !parseHttpsOrigin(origin).equals(row.get("httpsOrigin")) || !parsePcId(pcId).equals(row.get("targetPcId"))
            || !parseSocketGeneration(socketGeneration).equals(row.get("socketGeneration"))) throw invalid("Relay challenge connection mismatch");
        byte[] transcript = relayChallengeBytes(row);
        byte[] signature = signer.sign(transcript.clone());
        validateSignature(signature);
        if (!verify(publicPhoneSpki, transcript, signature)) throw invalid("Relay signer identity mismatch");
        return object("v", 1, "type", "relay-proof", "signature", encodeBase64Url(signature));
    }
    public static Map<String, Object> relayRegistration(String publicPhoneSpki, String pcId) throws GeneralSecurityException {
        return object("v", 1, "type", "relay-register", "role", "phone", "identityKey", parsePublicKey(publicPhoneSpki),
            "targetPcId", parsePcId(pcId));
    }
    public static Map<String, Object> parseRelayReady(Object wire) {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "role", "targetPcId", "socketGeneration");
        version(row);
        if (!"relay-ready".equals(row.get("type")) || !"phone".equals(row.get("role"))) throw invalid("Invalid phone relay readiness");
        parsePcId(row.get("targetPcId")); parseSocketGeneration(row.get("socketGeneration")); return row;
    }
    /** Validates the PC-to-phone relay envelope; callers still compare all metadata with their current connection. */
    public static Map<String, Object> parseRelayData(Object wire) throws GeneralSecurityException {
        Map<String, Object> row = exactRecord(snapshot(wire), "v", "type", "channelId", "targetPcId", "sourceRole",
            "sourceIdentityKey", "sourceSocketGeneration", "targetSocketGeneration", "payload");
        version(row);
        if (!"relay-data".equals(row.get("type")) || !"pc".equals(row.get("sourceRole"))) throw invalid("Invalid inbound relay data");
        parseId16(row.get("channelId")); parsePcId(row.get("targetPcId")); parsePublicKey(row.get("sourceIdentityKey"));
        parseSocketGeneration(row.get("sourceSocketGeneration")); parseSocketGeneration(row.get("targetSocketGeneration"));
        Map<String, Object> payload = record(row.get("payload"));
        if ("welcome".equals(payload.get("type"))) parsePcWelcome(payload);
        else if ("encrypted".equals(payload.get("type"))) {
            parseEncryptedFrame(payload);
            if (!"pc-to-phone".equals(payload.get("direction"))) throw invalid("Invalid inbound payload direction");
        } else throw invalid("Invalid inbound relay payload type");
        if (!row.get("channelId").equals(payload.get("channelId"))) throw invalid("Relay and endpoint channel mismatch");
        if (!derivePcId(string(row.get("sourceIdentityKey"))).equals(row.get("targetPcId"))) throw invalid("Relay PC id mismatch");
        return row;
    }
    /** Produces the exact phone-to-relay envelope, distinct from the larger forwarded relay-data fields. */
    public static Map<String, Object> relayData(String channelId, String socketGeneration, Object wire) throws GeneralSecurityException {
        Map<String, Object> payload = record(snapshot(wire));
        if ("hello".equals(payload.get("type"))) payload = parseClientHello(payload);
        else if ("encrypted".equals(payload.get("type"))) {
            payload = parseEncryptedFrame(payload);
            if (!"phone-to-pc".equals(payload.get("direction"))) throw invalid("Invalid outbound payload direction");
        } else throw invalid("Invalid outbound relay payload type");
        if (!parseId16(channelId).equals(payload.get("channelId"))) throw invalid("Relay and endpoint channel mismatch");
        return object("v", 1, "type", "relay-data", "channelId", channelId,
            "socketGeneration", parseSocketGeneration(socketGeneration), "payload", payload);
    }
    public static byte[] relayChallengeBytes(Map<String, Object> row) {
        return canonicalBytes("dsh-companion/relay-proof/v1", "1", row.get("role"), row.get("httpsOrigin"),
            decodeBase64Url(row.get("identityKey"), 91), decodeBase64Url(row.get("targetPcId"), 32),
            row.get("socketGeneration"), decodeBase64Url(row.get("challenge"), 32));
    }

    public static byte[] unsignedHelloBytes(Map<String, Object> hello) {
        Map<String, Object> auth = record(hello.get("authorization"));
        Object[] common = new Object[] { "1", hello.get("suite"), hello.get("role"), hello.get("httpsOrigin"), hello.get("channelId"),
            decodeBase64Url(hello.get("phoneIdentityKey"), 91), decodeBase64Url(hello.get("pcIdentityKey"), 91),
            decodeBase64Url(hello.get("nonce"), 32), decodeBase64Url(hello.get("ephemeralKey"), 91) };
        Object[] fields = Arrays.copyOf(common, common.length + ("grant".equals(auth.get("kind")) ? 3 : 2));
        fields[common.length] = auth.get("kind");
        fields[common.length + 1] = auth.get("grant".equals(auth.get("kind")) ? "grantId" : "invitationId");
        if (fields.length == common.length + 3) fields[common.length + 2] = Long.toString(integer(auth.get("generation"), 1, 0xffffffffL));
        return canonicalBytes("dsh-companion/hello/v1", fields);
    }
    public static byte[] helloSignatureBytes(Map<String, Object> hello) {
        boolean invitation = "invitation".equals(record(hello.get("authorization")).get("kind"));
        return canonicalBytes("dsh-companion/hello-signature/v1", unsignedHelloBytes(hello),
            decodeBase64Url(hello.get("pairingProof"), invitation ? 32 : 0));
    }
    public static byte[] signedHelloBytes(Map<String, Object> hello) {
        return canonicalBytes("dsh-companion/signed-hello/v1", helloSignatureBytes(hello), decodeSignature(hello.get("signature")));
    }
    public static byte[] welcomeSignatureBytes(Map<String, Object> hello, Map<String, Object> welcome) {
        return canonicalBytes("dsh-companion/welcome-signature/v1", signedHelloBytes(hello), "1", welcome.get("suite"),
            welcome.get("role"), welcome.get("channelId"), decodeBase64Url(welcome.get("nonce"), 32),
            decodeBase64Url(welcome.get("ephemeralKey"), 91), welcome.get("grantId"),
            Long.toString(integer(welcome.get("generation"), 1, 0xffffffffL)));
    }
    public static byte[] frameAdditionalData(Map<String, Object> frame) {
        return canonicalBytes("dsh-companion/frame-aad/v1", "1", frame.get("direction"), frame.get("channelId"),
            frame.get("grantId"), Long.toString(integer(frame.get("generation"), 1, 0xffffffffL)), decodeBase64Url(frame.get("counter"), 8));
    }

    /** Exact 91-byte SPKI, finite on-curve point, full named-curve parameters, and byte-identical JCA re-export. */
    public static PublicKey importPublicKey(Object encoded) throws GeneralSecurityException {
        byte[] der = decodeBase64Url(encoded, 91, 91);
        for (int i = 0; i < SPKI_PREFIX.length; i++) if (der[i] != SPKI_PREFIX[i]) throw invalid("Expected canonical P-256 SPKI");
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(der, 27, 59));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(der, 59, 91));
        if (x.compareTo(FIELD) >= 0 || y.compareTo(FIELD) >= 0
            || !y.multiply(y).mod(FIELD).equals(x.multiply(x).multiply(x).add(A.multiply(x)).add(B).mod(FIELD))) throw invalid("Invalid P-256 point");
        PublicKey imported = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
        if (!(imported instanceof ECPublicKey)) throw invalid("Expected EC public key");
        ECPublicKey key = (ECPublicKey) imported;
        ECParameterSpec params = key.getParams();
        if (params == null || !(params.getCurve().getField() instanceof ECFieldFp)
            || !((ECFieldFp) params.getCurve().getField()).getP().equals(FIELD)
            || !params.getCurve().getA().equals(A) || !params.getCurve().getB().equals(B)
            || !params.getOrder().equals(ORDER) || params.getCofactor() != 1
            || !params.getGenerator().getAffineX().equals(GX) || !params.getGenerator().getAffineY().equals(GY)
            || !key.getW().getAffineX().equals(x) || !key.getW().getAffineY().equals(y)
            || !Arrays.equals(der, key.getEncoded())) throw invalid("Unexpected P-256 parameters or encoding");
        return key;
    }
    public static String parsePublicKey(Object encoded) throws GeneralSecurityException {
        importPublicKey(encoded); return string(encoded);
    }
    public static String derivePcId(String spki) throws GeneralSecurityException {
        parsePublicKey(spki);
        return encodeBase64Url(sha256(canonicalBytes("dsh-companion/pc-id/v1", decodeBase64Url(spki, 91))));
    }
    public static byte[] decodeSignature(Object encoded) {
        byte[] der = decodeBase64Url(encoded, -1, 72); validateSignature(der); return der;
    }
    public static void validateSignature(byte[] der) {
        if (der == null || der.length < 8 || der.length > 72 || der[0] != 0x30 || (der[1] & 255) != der.length - 2) throw invalid("Invalid ECDSA DER sequence");
        int end = signatureIntegerEnd(der, 2);
        if (signatureIntegerEnd(der, end) != der.length) throw invalid("Extra ECDSA DER bytes");
    }
    private static int signatureIntegerEnd(byte[] der, int offset) {
        if (offset + 2 > der.length || der[offset] != 2) throw invalid("Expected ECDSA integer");
        int length = der[offset + 1] & 255;
        if (length < 1 || length > 33 || offset + 2 + length > der.length) throw invalid("Invalid ECDSA scalar length");
        int first = der[offset + 2] & 255;
        if (first >= 128 || (first == 0 && (length == 1 || (der[offset + 3] & 255) < 128))) throw invalid("Noncanonical ECDSA scalar");
        BigInteger scalar = new BigInteger(1, Arrays.copyOfRange(der, offset + 2, offset + 2 + length));
        if (scalar.signum() == 0 || scalar.compareTo(ORDER) >= 0) throw invalid("ECDSA scalar outside P-256 order");
        return offset + 2 + length;
    }
    private static boolean verify(String spki, byte[] transcript, byte[] der) throws GeneralSecurityException {
        validateSignature(der);
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initVerify(importPublicKey(spki)); signature.update(transcript); return signature.verify(der);
    }

    public static String encodeBase64Url(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    public static byte[] decodeBase64Url(Object encoded, int length) {
        return decodeBase64Url(encoded, length, length < 0 ? MAX_APPLICATION_BYTES + 1 : length);
    }
    public static byte[] decodeBase64Url(Object encoded, int length, int maximum) {
        String text = string(encoded);
        if (maximum < 0 || maximum > StrictJson.MAX_BYTES || text.length() > (maximum * 4 + 2) / 3
            || !text.matches("[A-Za-z0-9_-]*")) throw invalid("Invalid base64url field");
        byte[] bytes;
        try { bytes = Base64.getUrlDecoder().decode(text); }
        catch (IllegalArgumentException malformedBase64) { throw invalid("Invalid base64url field"); }
        if (bytes.length > maximum || (length >= 0 && bytes.length != length) || !encodeBase64Url(bytes).equals(text)) throw invalid("Noncanonical base64url or length");
        return bytes;
    }
    public static String randomId(int bytes) {
        if (bytes != 16 && bytes != 32) throw invalid("Unsupported random id length");
        byte[] value = new byte[bytes]; RANDOM.nextBytes(value); return encodeBase64Url(value);
    }
    public static String parseId(Object value) {
        String identifier = string(value);
        if (!identifier.matches("[A-Za-z0-9_-]{1,128}")) throw invalid("Invalid companion identifier");
        return identifier;
    }
    public static String parseId16(Object value) { decodeBase64Url(value, 16); return string(value); }
    public static String parsePcId(Object value) { decodeBase64Url(value, 32); return string(value); }
    public static String parseSocketGeneration(Object value) { decodeBase64Url(value, 32); return string(value); }
    public static byte[] counterBytes(long counter) {
        if (counter < 0) throw invalid("Negative counter");
        return ByteBuffer.allocate(8).putLong(counter).array();
    }
    public static byte[] counterBytes(BigInteger counter) {
        if (counter == null || counter.signum() < 0 || counter.bitLength() > 64) throw invalid("Counter outside uint64");
        return ByteBuffer.allocate(8).putLong(counter.longValue()).array();
    }
    public static BigInteger decodeCounter(Object encoded) { return new BigInteger(1, decodeBase64Url(encoded, 8)); }
    public static String encodeCounter(long counter) { return encodeBase64Url(counterBytes(counter)); }
    public static String encodeCounter(BigInteger counter) { return encodeBase64Url(counterBytes(counter)); }
    public static void assertKeyUse(long counter) {
        if (counter < 0 || counter >= KEY_USE_LIMIT) throw invalid("Channel key-use limit exhausted");
    }
    public static byte[] canonicalBytes(String domain, Object... fields) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeField(out, domain);
        for (Object field : fields) writeField(out, field);
        return out.toByteArray();
    }
    private static void writeField(ByteArrayOutputStream out, Object value) {
        byte[] bytes;
        if (value instanceof byte[]) bytes = (byte[]) value;
        else { String text = string(value); StrictJson.requireText(text, StrictJson.MAX_BYTES); bytes = text.getBytes(StandardCharsets.UTF_8); }
        if (bytes.length > StrictJson.MAX_BYTES || out.size() > 4 * StrictJson.MAX_BYTES - bytes.length - 4) throw invalid("Transcript exceeds limit");
        byte[] prefix = ByteBuffer.allocate(4).putInt(bytes.length).array();
        out.write(prefix, 0, prefix.length); out.write(bytes, 0, bytes.length);
    }
    private static byte[] nonce(byte[] prefix, long counter) { return concat(prefix, counterBytes(counter)); }
    private static byte[] concat(byte[] first, byte[] second) {
        byte[] result = Arrays.copyOf(first, first.length + second.length);
        System.arraycopy(second, 0, result, first.length, second.length); return result;
    }
    private static byte[] sha256(byte[] bytes) throws GeneralSecurityException { return MessageDigest.getInstance("SHA-256").digest(bytes); }
    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256")); return mac.doFinal(data);
    }
    private static void erase(byte[] value) { if (value != null) Arrays.fill(value, (byte) 0); }
    private static void destroy(PrivateKey key) {
        if (key != null) {
            try { key.destroy(); }
            catch (javax.security.auth.DestroyFailedException | RuntimeException unavailableErasure) {
                // Some JCA providers cannot erase private keys; the caller also releases its reference.
            }
        }
    }
    private static byte[] hex(String value) {
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    /** Requires exact canonical ASCII HTTPS spelling, including canonical IP literals; does not resolve DNS. */
    public static String parseHttpsOrigin(Object value) {
        String text = string(value);
        if (text.length() > 2048 || !text.startsWith("https://")) throw invalid("Expected canonical HTTPS origin");
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c <= 32 || c >= 127 || c == '\\' || c == '%') throw invalid("Invalid origin character");
        }
        URI uri;
        try { uri = new URI(text); }
        catch (URISyntaxException invalidUri) { throw invalid("Invalid HTTPS origin"); }
        if (uri.isOpaque() || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
            || uri.getRawPath() == null || !uri.getRawPath().isEmpty()) throw invalid("Origin includes URL suffix or credentials");
        String authority = uri.getRawAuthority();
        if (authority == null || authority.isEmpty()) throw invalid("Missing origin host");
        String host;
        String port = "";
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) throw invalid("Invalid IPv6 host");
            host = authority.substring(0, close + 1);
            if (!host.equals("[" + canonicalIpv6(host.substring(1, host.length() - 1)) + "]")) throw invalid("Noncanonical IPv6 host");
            if (close + 1 < authority.length()) port = authority.substring(close + 1);
        } else {
            int colon = authority.indexOf(':');
            host = colon < 0 ? authority : authority.substring(0, colon);
            if (colon >= 0) port = authority.substring(colon);
            if (host.isEmpty() || !host.matches("[a-z0-9._-]+")) throw invalid("Noncanonical origin host");
            String withoutDot = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
            String[] pieces = withoutDot.split("\\.", -1);
            for (String piece : pieces) {
                if (piece.startsWith("xn--")) {
                    String decoded = IDN.toUnicode(piece);
                    if (decoded.equals(piece) || !IDN.toASCII(decoded).equals(piece)) throw invalid("Invalid origin A-label");
                }
            }
            String last = pieces[pieces.length - 1];
            if (last.matches("[0-9]+") || last.matches("0x[0-9a-f]*")) {
                if (pieces.length != 4 || !host.equals(withoutDot)) throw invalid("Noncanonical IPv4 host");
                for (String piece : pieces) {
                    if (!piece.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(piece) > 255) throw invalid("Noncanonical IPv4 host");
                }
            }
        }
        if (!port.isEmpty()) {
            if (!port.matches(":(0|[1-9][0-9]{0,4})")) throw invalid("Noncanonical HTTPS port");
            int number = Integer.parseInt(port.substring(1));
            if (number > 65535 || number == 443) throw invalid("Noncanonical HTTPS port");
        }
        if (!text.equals("https://" + host + port)) throw invalid("Noncanonical HTTPS origin");
        return text;
    }
    private static String canonicalIpv6(String address) {
        if (!address.matches("[0-9a-f:]+")) throw invalid("Invalid IPv6 address");
        int split = address.indexOf("::");
        if (split >= 0 && address.indexOf("::", split + 2) >= 0) throw invalid("Invalid IPv6 compression");
        String left = split < 0 ? address : address.substring(0, split);
        String right = split < 0 ? "" : address.substring(split + 2);
        String[] before = left.isEmpty() ? new String[0] : left.split(":", -1);
        String[] after = right.isEmpty() ? new String[0] : right.split(":", -1);
        int zeros = 8 - before.length - after.length;
        if ((split < 0 && zeros != 0) || (split >= 0 && zeros < 1)) throw invalid("Invalid IPv6 field count");
        int[] fields = new int[8];
        for (int i = 0; i < before.length; i++) fields[i] = ipv6Field(before[i]);
        for (int i = 0; i < after.length; i++) fields[8 - after.length + i] = ipv6Field(after[i]);
        int bestStart = -1, bestLength = 1;
        for (int i = 0; i < fields.length;) {
            if (fields[i] != 0) { i++; continue; }
            int start = i;
            while (i < fields.length && fields[i] == 0) i++;
            if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
        }
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < fields.length; i++) {
            if (i == bestStart) {
                result.append("::"); i += bestLength - 1;
            } else {
                if (result.length() > 0 && result.charAt(result.length() - 1) != ':') result.append(':');
                result.append(Integer.toHexString(fields[i]));
            }
        }
        return result.toString();
    }
    private static int ipv6Field(String field) {
        if (!field.matches("[0-9a-f]{1,4}")) throw invalid("Invalid IPv6 field");
        return Integer.parseInt(field, 16);
    }

    public static String string(Object value) {
        if (!(value instanceof String)) throw invalid("Expected JSON string");
        return (String) value;
    }
    public static long integer(Object value, long minimum, long maximum) {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double) throw invalid("Expected exact JSON integer");
        long parsed;
        try {
            if (value instanceof BigDecimal) parsed = ((BigDecimal) value).longValueExact();
            else if (value instanceof BigInteger) {
                BigInteger exact = (BigInteger) value;
                if (exact.bitLength() > 63) throw invalid("Expected exact JSON integer");
                parsed = exact.longValue();
            }
            else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) parsed = ((Number) value).longValue();
            else throw invalid("Unsupported numeric representation");
        } catch (ArithmeticException invalidInteger) { throw invalid("Expected exact JSON integer"); }
        if (parsed < minimum || parsed > maximum) throw invalid("Integer outside permitted range");
        return parsed;
    }
    @SuppressWarnings("unchecked")
    public static Map<String, Object> record(Object value) {
        if (!(value instanceof Map)) throw invalid("Expected JSON object");
        for (Object key : ((Map<?, ?>) value).keySet()) if (!(key instanceof String)) throw invalid("Expected string object key");
        return (Map<String, Object>) value;
    }
    public static Map<String, Object> exactRecord(Object value, String... keys) {
        Map<String, Object> row = record(value);
        if (row.size() != keys.length) throw invalid("Invalid object fields");
        for (String key : keys) if (!row.containsKey(key)) throw invalid("Missing object field");
        return row;
    }
    public static Map<String, Object> object(Object... pairs) {
        if (pairs.length % 2 != 0) throw invalid("Invalid object entries");
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            String key = string(pairs[i]);
            if (map.containsKey(key)) throw invalid("Duplicate object key");
            map.put(key, pairs[i + 1]);
        }
        return record(StrictJson.freeze(map));
    }
    private static Object snapshot(Object wire) { return StrictJson.freeze(wire); }
    public static void version(Map<String, Object> row) {
        if (integer(row.get("v"), 1, 1) != 1) throw invalid("Unsupported protocol version");
    }
    private static void fixed(Map<String, Object> row, String type, String role) {
        version(row);
        if (!type.equals(row.get("type")) || !role.equals(row.get("role")) || !SUITE.equals(row.get("suite"))) throw invalid("Invalid protocol type, suite or role");
    }
    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
}
