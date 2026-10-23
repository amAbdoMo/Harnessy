package io.harnessy.companion.protocol;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
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
        navigationRequestsOptInWithoutChangingLegacyReads();
        navigationRowsPreserveLegacyAndNullableMetadata();
        navigationRequiresAtomicExactNestedFields();
        navigationNumbersRequireNonnegativeSafeIntegers();
        navigationUnicodeAndEnvelopeBudgetsRemainStrict();
        ManagementCodecRegression.main(args);
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

    private static void navigationRequestsOptInWithoutChangingLegacyReads() throws GeneralSecurityException {
        for (String cursor : new String[] { null, "cGFnZQ" }) {
            Map<String, Object> legacy = ApplicationCodec.parseRequest(ApplicationCodec.listSessions(ID16, 1, cursor));
            Map<String, Object> navigation = ApplicationCodec.parseRequest(ApplicationCodec.listSessionNavigation(ID16, 1, cursor));
            equal(false, legacy.containsKey("view"));
            equal(cursor == null ? 4 : 5, legacy.size());
            equal("listSessions", navigation.get("type"));
            equal("navigation", navigation.get("view"));
            equal(cursor == null ? 5 : 6, navigation.size());
            if (cursor != null) equal(cursor, navigation.get("cursor"));
        }
        for (Object view : new Object[] { null, true, 1, "", "Navigation", "legacy", Collections.emptyList() }) {
            rejected(() -> ApplicationCodec.parseRequest(StrictJson.stringify(Protocol.object("v", 1, "type", "listSessions",
                "requestId", ID16, "limit", 1, "view", view))));
        }
        rejected(() -> ApplicationCodec.listSessionNavigation(ID32, 1, null));
        rejected(() -> ApplicationCodec.parseRequest(StrictJson.stringify(Protocol.object("v", 1, "type", "readHistory",
            "requestId", ID16, "sessionId", "s1", "limit", 1, "view", "navigation"))));
    }

    private static void navigationRowsPreserveLegacyAndNullableMetadata() {
        Map<String, Object> legacy = Protocol.object("sessionId", "legacy", "title", "old", "status", "closed");
        Map<String, Object> rich = Protocol.object("sessionId", "rich", "title", "new", "status", "idle", "navigation",
            Protocol.object("updatedAt", 9_007_199_254_740_991L, "pinOrder", 0, "workspace",
                Protocol.object("id", "W._:-1", "title", "工作 🧭", "order", 9_007_199_254_740_991L)));
        ApplicationCodec.Result parsed = ApplicationCodec.result(StrictJson.stringify(Protocol.object("v", 1, "type", "sessions",
            "requestId", ID16, "sessions", java.util.Arrays.asList(legacy, rich))));
        equal(ApplicationCodec.Type.SESSIONS, parsed.type);
        equal(true, parsed.sessions.get(0).navigation == null);
        ApplicationCodec.SessionNavigation navigation = parsed.sessions.get(1).navigation;
        equal(9_007_199_254_740_991L, navigation.updatedAt);
        equal(0L, navigation.pinOrder);
        equal("W._:-1", navigation.workspace.id);
        equal("工作 🧭", navigation.workspace.title);
        equal(9_007_199_254_740_991L, navigation.workspace.order);
        ApplicationCodec.SessionNavigation loose = ApplicationCodec.result(navigationResult(
            "{\"updatedAt\":0,\"pinOrder\":null,\"workspace\":null}")).sessions.get(0).navigation;
        equal(0L, loose.updatedAt);
        equal(true, loose.pinOrder == null && loose.workspace == null);
    }

    private static void navigationRequiresAtomicExactNestedFields() throws GeneralSecurityException {
        String[] malformed = {
            "null", "false", "[]", "\"navigation\"", "{}",
            "{\"pinOrder\":null,\"workspace\":null}",
            "{\"updatedAt\":0,\"workspace\":null}",
            "{\"updatedAt\":0,\"pinOrder\":null}",
            "{\"updatedAt\":0,\"pinOrder\":null,\"workspace\":null,\"extra\":0}",
            "{\"updatedAt\":0,\"updatedAt\":1,\"pinOrder\":null,\"workspace\":null}"
        };
        for (String navigation : malformed) rejected(() -> ApplicationCodec.result(navigationResult(navigation)));
        for (String workspace : new String[] { "false", "[]", "\"workspace\"", "{}",
            "{\"title\":\"W\",\"order\":0}", "{\"id\":\"w\",\"order\":0}", "{\"id\":\"w\",\"title\":\"W\"}",
            "{\"id\":\"w\",\"title\":\"W\",\"order\":0,\"extra\":0}",
            "{\"id\":\"w\",\"title\":\"W\",\"title\":\"duplicate\",\"order\":0}" }) {
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspace))));
        }
    }

    private static void navigationNumbersRequireNonnegativeSafeIntegers() throws GeneralSecurityException {
        // Zero and the safe maximum are inclusive; nullable pin is distinct from absent/invalid numbers.
        for (String valid : new String[] { "0", "9007199254740991", "1.0", "1e3" }) {
            ApplicationCodec.result(navigationResult(navigationJson(valid, valid, workspaceJson("\"w\"", "\"W\"", valid))));
        }
        for (String invalid : new String[] { "-1", "0.1", "true", "false", "\"0\"", "[]", "{}",
            "9007199254740992", "9007199254740991.1", "9223372036854775808", "1e309", "NaN", "Infinity" }) {
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson(invalid, "null", "null"))));
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", invalid, "null"))));
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspaceJson("\"w\"", "\"W\"", invalid)))));
        }
        rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("null", "null", "null"))));
        rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspaceJson("\"w\"", "\"W\"", "null")))));
    }

    private static void navigationUnicodeAndEnvelopeBudgetsRemainStrict() throws GeneralSecurityException {
        String emoji = new String(Character.toChars(0x1F9ED));
        String title = String.join("", Collections.nCopies(256, emoji));
        ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspaceJson(
            "\"" + repeated('W', 128) + "\"", StrictJson.stringify(title), "0"))));
        rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null",
            workspaceJson("\"w\"", StrictJson.stringify(title + "a"), "0")))));
        for (String id : new String[] { "", repeated('W', 129), "-w", "w/1", "w 1", "工作" }) {
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspaceJson(StrictJson.stringify(id), "\"W\"", "0")))));
        }
        for (String badTitle : new String[] { "null", "true", "1", "\"\\ud800\"", "\"\\udc00\"" }) {
            rejected(() -> ApplicationCodec.result(navigationResult(navigationJson("0", "null", workspaceJson("\"w\"", badTitle, "0")))));
        }
        String compact = navigationResult(navigationJson("0", "null", "null"));
        String atLimit = compact + repeated(' ', ApplicationCodec.MAX_JSON_BYTES - compact.getBytes(StandardCharsets.UTF_8).length);
        ApplicationCodec.result(atLimit.getBytes(StandardCharsets.UTF_8));
        rejected(() -> ApplicationCodec.result((atLimit + " ").getBytes(StandardCharsets.UTF_8)));
        List<Object> rows = new ArrayList<>();
        for (int index = 0; index < 50; index++) rows.add(Protocol.object("sessionId", "s" + index, "title", "S", "status", "idle",
            "navigation", Protocol.object("updatedAt", 0, "pinOrder", null, "workspace", Protocol.object("id", "w", "title", title, "order", 0))));
        String multibyteEnvelope = StrictJson.stringify(Protocol.object("v", 1, "type", "sessions", "requestId", ID16, "sessions", rows));
        equal(true, multibyteEnvelope.length() < ApplicationCodec.MAX_JSON_BYTES);
        rejected(() -> ApplicationCodec.result(multibyteEnvelope));
        rejected(() -> ApplicationCodec.result(multibyteEnvelope.getBytes(StandardCharsets.UTF_8)));
    }

    private static String navigationResult(String navigation) {
        return "{\"v\":1,\"type\":\"sessions\",\"requestId\":\"" + ID16
            + "\",\"sessions\":[{\"sessionId\":\"s1\",\"title\":\"S\",\"status\":\"idle\",\"navigation\":" + navigation + "}]}";
    }

    private static String navigationJson(String updatedAt, String pinOrder, String workspace) {
        return "{\"updatedAt\":" + updatedAt + ",\"pinOrder\":" + pinOrder + ",\"workspace\":" + workspace + "}";
    }

    private static String workspaceJson(String id, String title, String order) {
        return "{\"id\":" + id + ",\"title\":" + title + ",\"order\":" + order + "}";
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
        if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }

    private static void rejected(ParserAction action) throws GeneralSecurityException {
        try {
            action.parse();
        } catch (IllegalArgumentException invalidMessage) {
            return;
        }
        throw new AssertionError("Parser accepted input outside its schema");
    }

    private interface ParserAction {
        void parse() throws GeneralSecurityException;
    }
}
