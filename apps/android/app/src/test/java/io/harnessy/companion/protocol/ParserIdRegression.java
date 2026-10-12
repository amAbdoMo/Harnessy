package io.harnessy.companion.protocol;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Collections;
import java.util.Map;

/** Dependency-free JVM parser regressions; fixtures contain public keys and synthetic invitation bytes only. */
public final class ParserIdRegression {
    private static final String ID16 = Protocol.encodeBase64Url(new byte[16]);
    private static final String ID32 = Protocol.encodeBase64Url(new byte[32]);
    private static final String PUBLIC_SPKI = Protocol.encodeBase64Url(hex(
        "3059301306072a8648ce3d020106082a8648ce3d03010703420004"
        + "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
        + "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"));
    private static final String SIGNATURE_DER = Protocol.encodeBase64Url(hex("3006020101020101"));

    private ParserIdRegression() { }

    public static void main(String[] args) throws GeneralSecurityException {
        pcIssued32ByteIdentifiersAreAccepted();
        opaqueIdentifiersArePreservedWithoutBase64Decoding();
        identifiersOutsideNodeSchemaAreRejected();
        subscriptionsRetainNode16ByteSchema();
        phoneOwnedIdentifiersRetain16ByteSchema();
    }

    private static void pcIssued32ByteIdentifiersAreAccepted() throws GeneralSecurityException {
        assertIdentifierAccepted(ID32);
    }

    private static void opaqueIdentifiersArePreservedWithoutBase64Decoding() throws GeneralSecurityException {
        // Node parseId accepts length 1 and 128, all allowed characters, and noncanonical base64 text.
        String[] identifiers = { "A", "AB", "-_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
            repeated('Z', 128), ID16 };
        for (String identifier : identifiers) assertIdentifierAccepted(identifier);
    }

    private static void assertIdentifierAccepted(String identifier) throws GeneralSecurityException {
        equal(identifier, Protocol.parseId(identifier));
        try (Protocol.Authorization grant = Protocol.Authorization.grant(identifier, 1);
             Protocol.Authorization invitation = Protocol.Authorization.invitation(identifier, new byte[32])) {
            equal(identifier, grant.id);
            equal(identifier, invitation.id);
        }
        equal(identifier, Protocol.record(Protocol.parseClientHello(hello("grant", identifier)).get("authorization")).get("grantId"));
        equal(identifier, Protocol.record(Protocol.parseClientHello(hello("invitation", identifier)).get("authorization")).get("invitationId"));
        equal(identifier, Protocol.parsePcWelcome(welcome(identifier)).get("grantId"));
        equal(identifier, Protocol.parseEncryptedFrame(frame(identifier)).get("grantId"));
        try (Invitation invitation = Invitation.parse(invitationLink(identifier), 1);
             Protocol.Authorization authorization = invitation.authorization()) {
            equal(identifier, invitation.invitationId);
            equal(identifier, authorization.id);
        }
    }

    private static void identifiersOutsideNodeSchemaAreRejected() throws GeneralSecurityException {
        // Empty/129 characters, punctuation, whitespace, Unicode, and non-string JSON are invalid.
        Object[] identifiers = { "", repeated('Z', 129), "a.b", "a:b", "a/b", "a+b", "a=", "a b", "a\n", "é", 1, null };
        for (Object identifier : identifiers) {
            rejected(() -> Protocol.parseId(identifier));
            rejected(() -> Protocol.parseClientHello(hello("grant", identifier)));
            rejected(() -> Protocol.parseClientHello(hello("invitation", identifier)));
            rejected(() -> Protocol.parsePcWelcome(welcome(identifier)));
            rejected(() -> Protocol.parseEncryptedFrame(frame(identifier)));
            rejected(() -> Invitation.parse(invitationLink(identifier), 1));
            if (identifier == null || identifier instanceof String) {
                rejected(() -> Protocol.Authorization.grant((String) identifier, 1));
                rejected(() -> Protocol.Authorization.invitation((String) identifier, new byte[32]));
            }
        }
    }

    private static void subscriptionsRetainNode16ByteSchema() throws GeneralSecurityException {
        equal(ID16, ApplicationCodec.result(StrictJson.stringify(watching(ID16))).subscriptionId);
        equal(ID16, ApplicationCodec.result(StrictJson.stringify(progress(ID16))).subscriptionId);
        equal(ID16, ApplicationCodec.result(StrictJson.stringify(cancelled(ID16))).subscriptionId);
        equal(ID16, ApplicationCodec.parseRequest(ApplicationCodec.cancelRead(ID16, ID16)).get("subscriptionId"));
        String[] invalidSubscriptions = { "A", "AB", ID32, repeated('Z', 128), ID16 + "=" };
        for (String identifier : invalidSubscriptions) {
            rejected(() -> ApplicationCodec.parseResult(StrictJson.stringify(watching(identifier))));
            rejected(() -> ApplicationCodec.parseResult(StrictJson.stringify(progress(identifier))));
            rejected(() -> ApplicationCodec.parseResult(StrictJson.stringify(cancelled(identifier))));
            rejected(() -> ApplicationCodec.cancelRead(ID16, identifier));
        }
    }

    private static void phoneOwnedIdentifiersRetain16ByteSchema() throws GeneralSecurityException {
        equal(ID16, Protocol.parseClientHello(hello("grant", ID32)).get("channelId"));
        equal(ID16, ApplicationCodec.parseRequest(ApplicationCodec.listSessions(ID16, 1, null)).get("requestId"));
        equal(ID16, ApplicationCodec.parseRequest(ApplicationCodec.submitText(ID16, "session-1", "text", ID16)).get("submissionId"));
        String[] identifiers = { "A", ID32 };
        for (String identifier : identifiers) {
            rejected(() -> Protocol.parseId16(identifier));
            rejected(() -> ApplicationCodec.listSessions(identifier, 1, null));
            rejected(() -> ApplicationCodec.submitText(ID16, "session-1", "text", identifier));
        }
    }

    private static Map<String, Object> hello(String kind, Object identifier) {
        Map<String, Object> authorization = "grant".equals(kind)
            ? Protocol.object("kind", kind, "grantId", identifier, "generation", 1)
            : Protocol.object("kind", kind, "invitationId", identifier);
        return Protocol.object("v", 1, "type", "hello", "suite", Protocol.SUITE, "role", "phone",
            "httpsOrigin", "https://example.com", "channelId", ID16,
            "phoneIdentityKey", PUBLIC_SPKI, "pcIdentityKey", PUBLIC_SPKI, "nonce", ID32,
            "ephemeralKey", PUBLIC_SPKI, "authorization", authorization,
            "pairingProof", "grant".equals(kind) ? "" : ID32, "signature", SIGNATURE_DER);
    }

    private static Map<String, Object> welcome(Object grantId) {
        return Protocol.object("v", 1, "type", "welcome", "suite", Protocol.SUITE, "role", "pc",
            "channelId", ID16, "nonce", ID32, "ephemeralKey", PUBLIC_SPKI,
            "grantId", grantId, "generation", 1, "signature", SIGNATURE_DER);
    }

    private static Map<String, Object> frame(Object grantId) {
        return Protocol.object("v", 1, "type", "encrypted", "direction", "pc-to-phone",
            "channelId", ID16, "grantId", grantId, "generation", 1,
            "counter", Protocol.encodeCounter(0), "ciphertext", "", "tag", ID16);
    }

    private static String invitationLink(Object invitationId) throws GeneralSecurityException {
        Map<String, Object> invitation = Protocol.object("v", 1, "httpsOrigin", "https://example.com",
            "pcId", Protocol.derivePcId(PUBLIC_SPKI), "pcIdentityKey", PUBLIC_SPKI,
            "invitationId", invitationId, "expiresAt", 2, "secret", ID32);
        return "harnessy://pair#" + Protocol.encodeBase64Url(StrictJson.stringify(invitation).getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> watching(String subscriptionId) {
        return Protocol.object("v", 1, "type", "watching", "requestId", ID16,
            "sessionId", "session-1", "subscriptionId", subscriptionId);
    }

    private static Map<String, Object> progress(String subscriptionId) {
        return Protocol.object("v", 1, "type", "progress", "subscriptionId", subscriptionId,
            "sessionId", "session-1", "rows", Collections.emptyList(), "status", "idle");
    }

    private static Map<String, Object> cancelled(String subscriptionId) {
        return Protocol.object("v", 1, "type", "cancelled", "requestId", ID16, "subscriptionId", subscriptionId);
    }

    private static String repeated(char character, int count) {
        StringBuilder identifier = new StringBuilder(count);
        for (int index = 0; index < count; index++) identifier.append(character);
        return identifier.toString();
    }

    private static byte[] hex(String encoded) {
        byte[] bytes = new byte[encoded.length() / 2];
        for (int index = 0; index < bytes.length; index++) {
            bytes[index] = (byte) Integer.parseInt(encoded.substring(index * 2, index * 2 + 2), 16);
        }
        return bytes;
    }

    private static void equal(Object expected, Object actual) {
        if (!expected.equals(actual)) throw new AssertionError("Parser did not preserve identifier");
    }

    private static void rejected(ParserAction action) throws GeneralSecurityException {
        try {
            action.parse();
        } catch (IllegalArgumentException invalidIdentifier) {
            return;
        }
        throw new AssertionError("Parser accepted identifier outside its schema");
    }

    private interface ParserAction {
        void parse() throws GeneralSecurityException;
    }
}
