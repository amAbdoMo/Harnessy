package io.harnessy.companion.protocol;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Synthetic management parser cases invoked by ParserIdRegression and its existing JUnit wrapper. */
public final class ManagementCodecRegression {
    private static final String REQUEST = Protocol.encodeBase64Url(new byte[16]);
    private static final String OPERATION = "AQEBAQEBAQEBAQEBAQEBAQ";
    private static final String CREATED = "mobile-" + OPERATION;
    private static final long SAFE_MAX = 9_007_199_254_740_991L;

    private ManagementCodecRegression() { }

    public static void main(String[] args) {
        encodersPreserveExactRequestsAndDesiredPinState();
        requestsRejectMissingExtraAndMistypedFields();
        workspaceResultsExposeImmutableTargetsAndDisabledState();
        workspaceTargetsRequireUniqueIdsAndSafeOrders();
        appliedResultsRequireMatchingNavigableRowsExceptArchive();
        rejectedAndUnknownResultsCannotCarryAppliedState();
        resultsRejectMissingExtraAndMistypedFields();
        managementMessagesRetainUnicodeAndWholeEnvelopeLimits();
    }

    private static void encodersPreserveExactRequestsAndDesiredPinState() {
        for (String cursor : new String[] { null, "cGFnZQ" }) {
            Map<String, Object> listing = request(ApplicationCodec.listManagementWorkspaces(REQUEST, 128, cursor));
            equal("listManagementWorkspaces", listing.get("type"));
            equal(128L, Protocol.integer(listing.get("limit"), 1, 128));
            equal(cursor, listing.get("cursor"));
            equal(cursor == null ? 4 : 5, listing.size());
        }
        equal(mutation("createSession", CREATED, "workspaceId", "W._:-1"),
            request(ApplicationCodec.createSession(REQUEST, OPERATION, CREATED, "W._:-1")));
        equal(mutation("renameSession", "s1", "title", "新 chat 🧭"),
            request(ApplicationCodec.renameSession(REQUEST, OPERATION, "s1", "新 chat 🧭")));
        equal(mutation("archiveSession", "s1"), request(ApplicationCodec.archiveSession(REQUEST, OPERATION, "s1")));
        for (boolean pinned : new boolean[] { true, false }) {
            equal(mutation("setSessionPinned", "s1", "pinned", pinned),
                request(ApplicationCodec.setSessionPinned(REQUEST, OPERATION, "s1", pinned)));
        }
        rejected(() -> ApplicationCodec.createSession(REQUEST, OPERATION, "s1", "w1"));
        rejected(() -> ApplicationCodec.createSession(REQUEST, REQUEST, CREATED, "w1"));
        rejected(() -> ApplicationCodec.listManagementWorkspaces(REQUEST, 0, null));
        rejected(() -> ApplicationCodec.listManagementWorkspaces(REQUEST, 129, null));
        rejected(() -> ApplicationCodec.listManagementWorkspaces(REQUEST, 1, "AB"));
    }

    private static void requestsRejectMissingExtraAndMistypedFields() {
        List<Map<String, Object>> requests = Arrays.asList(
            Protocol.object("v", 1, "type", "listManagementWorkspaces", "requestId", REQUEST, "limit", 1),
            mutation("createSession", CREATED, "workspaceId", "w1"),
            mutation("renameSession", "s1", "title", "New"), mutation("archiveSession", "s1"),
            mutation("setSessionPinned", "s1", "pinned", false));
        for (Map<String, Object> valid : requests) {
            ApplicationCodec.parseRequest(json(valid));
            for (String key : valid.keySet()) rejectedRequest(without(valid, key));
            rejectedRequest(with(valid, "extra", true));
            for (Object bad : new Object[] { null, 1, "A", REQUEST + "=", Protocol.encodeBase64Url(new byte[32]) }) {
                rejectedRequest(with(valid, "requestId", bad));
                if (valid.containsKey("operationId")) rejectedRequest(with(valid, "operationId", bad));
            }
            if (valid.containsKey("sessionId")) {
                for (Object bad : new Object[] { null, false, "", "-s", "s/1", "会话", repeat("s", 129) }) {
                    rejectedRequest(with(valid, "sessionId", bad));
                }
            }
            rejectedRequest(with(valid, "v", 2));
            rejectedRequest(with(valid, "type", "unknownManagement"));
        }
        Map<String, Object> create = requests.get(1), rename = requests.get(2), pin = requests.get(4);
        for (Object bad : new Object[] { null, false, "", "-w", "w/path", repeat("w", 129) }) {
            rejectedRequest(with(create, "workspaceId", bad));
        }
        ApplicationCodec.renameSession(REQUEST, OPERATION, "s1", "");
        for (Object bad : new Object[] { null, true, 1, repeat("é", 513) }) rejectedRequest(with(rename, "title", bad));
        for (Object bad : new Object[] { null, 0, 1, "false", "true" }) rejectedRequest(with(pin, "pinned", bad));
        rejectedRequest(with(requests.get(3), "pinned", true));
        rejectedRequest(with(requests.get(3), "title", "Archive"));
        for (Object bad : new Object[] { null, false, "1", 0, 129 }) rejectedRequest(with(requests.get(0), "limit", bad));
        rejected(() -> ApplicationCodec.parseRequest(json(requests.get(0)).replace("\"limit\":1", "\"limit\":0.5")));
        rejectedRequest(with(requests.get(0), "cursor", null));
        rejectedRequest(with(requests.get(0), "view", "navigation"));
    }

    private static void workspaceResultsExposeImmutableTargetsAndDisabledState() {
        Map<String, Object> workspace = workspace("W._:-1", "工作 🧭", SAFE_MAX);
        ApplicationCodec.Result parsed = result(with(workspaces(true, Collections.singletonList(workspace)), "cursor", "cGFnZQ"));
        equal(ApplicationCodec.Type.MANAGEMENT_WORKSPACES, parsed.type);
        equal(REQUEST, parsed.requestId);
        equal(true, parsed.enabled);
        equal("cGFnZQ", parsed.cursor);
        equal(1, parsed.workspaces.size());
        equal("W._:-1", parsed.workspaces.get(0).id);
        equal("工作 🧭", parsed.workspaces.get(0).title);
        equal(SAFE_MAX, parsed.workspaces.get(0).order);
        equal(null, parsed.session);
        equal(null, parsed.operationId);
        immutable(parsed.workspaces::clear);
        immutable(() -> parsed.wire.put("enabled", false));
        immutable(() -> Protocol.record(((List<?>) parsed.wire.get("workspaces")).get(0)).put("id", "other"));
        ApplicationCodec.Result disabled = result(workspaces(false, Collections.emptyList()));
        equal(false, disabled.enabled);
        equal(0, disabled.workspaces.size());
        equal(null, disabled.cursor);
        equal(0, result(workspaces(true, Collections.emptyList())).workspaces.size());
        rejectedResult(workspaces(false, Collections.singletonList(workspace)));
        rejectedResult(with(workspaces(false, Collections.emptyList()), "cursor", "AA"));
        ApplicationCodec.Result legacy = result(Protocol.object("v", 1, "type", "sessions", "requestId", REQUEST,
            "sessions", Collections.singletonList(Protocol.object("sessionId", "s1", "title", "Old", "status", "idle"))));
        equal(false, legacy.enabled);
        equal(0, legacy.workspaces.size());
        equal(null, legacy.session);
        equal(null, legacy.action);
        equal(null, legacy.outcome);
        equal(null, legacy.sessions.get(0).navigation);
    }

    private static void workspaceTargetsRequireUniqueIdsAndSafeOrders() {
        Map<String, Object> first = workspace("w1", "", 0);
        result(workspaces(true, Arrays.asList(first, workspace("w2", "W", SAFE_MAX))));
        rejectedResult(workspaces(true, Arrays.asList(first, workspace("w1", "Other", 1))));
        result(workspaces(true, Arrays.asList(first, workspace("w2", "Other", 0))));
        for (String key : first.keySet()) rejectedResult(workspaces(true, Collections.singletonList(without(first, key))));
        rejectedResult(workspaces(true, Collections.singletonList(with(first, "path", "/private"))));
        for (Object bad : new Object[] { null, true, "", "-w", "w/1", "工作", repeat("w", 129) }) {
            rejectedResult(workspaces(true, Collections.singletonList(with(first, "id", bad))));
        }
        for (Object bad : new Object[] { null, false, "0", -1, SAFE_MAX + 1 }) {
            rejectedResult(workspaces(true, Collections.singletonList(with(first, "order", bad))));
        }
        for (String bad : new String[] { "0.5", "9007199254740991.1", "1e309" }) {
            rejected(() -> ApplicationCodec.result(json(workspaces(true, Collections.singletonList(first))).replace("\"order\":0", "\"order\":" + bad)));
        }
        List<Object> maximum = new ArrayList<>();
        for (int index = 0; index < 128; index++) maximum.add(workspace("w" + index, "W", index));
        result(workspaces(true, maximum));
        maximum.add(workspace("overflow", "W", 128));
        rejectedResult(workspaces(true, maximum));
    }

    private static void appliedResultsRequireMatchingNavigableRowsExceptArchive() {
        for (String action : new String[] { "create", "rename", "pin" }) {
            String sessionId = "create".equals(action) ? CREATED : "s1";
            Map<String, Object> row = summary(sessionId);
            Map<String, Object> applied = with(managed(action, "applied", sessionId), "session", row);
            ApplicationCodec.Result parsed = result(applied);
            equal(ApplicationCodec.Type.MANAGED, parsed.type);
            equal(OPERATION, parsed.operationId);
            equal(action, parsed.action);
            equal("applied", parsed.outcome);
            equal(sessionId, parsed.sessionId);
            equal(sessionId, parsed.session.sessionId);
            equal("Title", parsed.session.title);
            equal("idle", parsed.session.status);
            equal(1L, parsed.session.navigation.updatedAt);
            equal(null, parsed.session.navigation.pinOrder);
            equal("w1", parsed.session.navigation.workspace.id);
            equal(null, parsed.code);
            equal(false, parsed.enabled);
            rejectedResult(without(applied, "session"));
            rejectedResult(with(applied, "session", null));
            rejectedResult(with(applied, "session", with(row, "sessionId", "other")));
            for (String key : row.keySet()) rejectedResult(with(applied, "session", without(row, key)));
            rejectedResult(with(applied, "session", with(row, "extra", true)));
            rejectedResult(with(applied, "session", with(row, "status", "unknown")));
            rejectedResult(with(applied, "session", with(row, "navigation", null)));
            rejectedResult(with(applied, "session", with(row, "navigation", Protocol.object("updatedAt", 0, "pinOrder", null))));
        }
        Map<String, Object> archived = managed("archive", "applied", "s1");
        equal(null, result(archived).session);
        rejectedResult(with(archived, "session", summary("s1")));
        rejectedResult(with(archived, "session", null));
    }

    private static void rejectedAndUnknownResultsCannotCarryAppliedState() {
        for (String action : new String[] { "create", "rename", "archive", "pin" }) {
            String sessionId = "create".equals(action) ? CREATED : "s1";
            for (String code : new String[] { "denied", "expired", "notFound", "busy", "conflict", "limit", "unavailable" }) {
                Map<String, Object> rejected = with(managed(action, "rejected", sessionId), "code", code);
                ApplicationCodec.Result parsed = result(rejected);
                equal(code, parsed.code);
                equal("rejected", parsed.outcome);
                equal(null, parsed.session);
                rejectedResult(with(rejected, "session", summary(sessionId)));
                rejectedResult(with(rejected, "session", null));
                rejectedResult(without(rejected, "code"));
                rejectedResult(with(rejected, "code", "unsupported"));
            }
            if ("create".equals(action)) {
                rejectedResult(managed(action, "unknown", "s1"));
                rejectedResult(with(managed(action, "rejected", "s1"), "code", "conflict"));
                rejectedResult(with(managed(action, "applied", "s1"), "session", summary("s1")));
            }
            Map<String, Object> unknown = managed(action, "unknown", sessionId);
            equal("unknown", result(unknown).outcome);
            equal(null, result(unknown).session);
            rejectedResult(with(unknown, "code", "unavailable"));
            rejectedResult(with(unknown, "session", null));
        }
    }

    private static void resultsRejectMissingExtraAndMistypedFields() {
        List<Map<String, Object>> results = Arrays.asList(workspaces(true, Collections.emptyList()),
            with(managed("pin", "applied", "s1"), "session", summary("s1")), managed("archive", "applied", "s1"),
            with(managed("rename", "rejected", "s1"), "code", "denied"), managed("rename", "unknown", "s1"));
        for (Map<String, Object> valid : results) {
            for (String key : valid.keySet()) rejectedResult(without(valid, key));
            rejectedResult(with(valid, "extra", true));
            rejectedResult(with(valid, "v", 2));
            rejectedResult(with(valid, "requestId", "A"));
            rejected(() -> ApplicationCodec.result(json(valid).replace("\"v\":1", "\"v\":1,\"v\":1")));
            if (valid.containsKey("operationId")) {
                for (Object bad : new Object[] { null, true, "A", OPERATION + "=", Protocol.encodeBase64Url(new byte[32]) }) {
                    rejectedResult(with(valid, "operationId", bad));
                }
                rejectedResult(with(valid, "sessionId", "s/1"));
                for (Object bad : new Object[] { null, true, "setSessionPinned", "delete", "" }) rejectedResult(with(valid, "action", bad));
                for (Object bad : new Object[] { null, true, "success", "" }) rejectedResult(with(valid, "outcome", bad));
            }
        }
        for (Object bad : new Object[] { null, 0, 1, "false" }) rejectedResult(with(results.get(0), "enabled", bad));
        for (Object bad : new Object[] { null, false, "targets", Collections.emptyMap() }) rejectedResult(with(results.get(0), "workspaces", bad));
        rejectedResult(with(results.get(0), "cursor", null));
        rejectedResult(with(results.get(0), "cursor", "AB"));
        rejectedResult(with(results.get(1), "code", "denied"));
    }

    private static void managementMessagesRetainUnicodeAndWholeEnvelopeLimits() {
        String title = repeat("🧭", 256);
        ApplicationCodec.renameSession(REQUEST, OPERATION, "s1", title);
        result(workspaces(true, Collections.singletonList(workspace("w", title, 0))));
        rejected(() -> ApplicationCodec.renameSession(REQUEST, OPERATION, "s1", title + "a"));
        rejectedResult(workspaces(true, Collections.singletonList(workspace("w", title + "a", 0))));
        String rename = json(mutation("renameSession", "s1", "title", "T"));
        rejected(() -> ApplicationCodec.parseRequest(rename.replace("\"title\":\"T\"", "\"title\":\"\\ud800\"")));
        String target = json(workspaces(true, Collections.singletonList(workspace("w", "T", 0))));
        rejected(() -> ApplicationCodec.result(target.replace("\"title\":\"T\"", "\"title\":\"\\udc00\"")));
        String atRequestLimit = pad(rename);
        ApplicationCodec.parseRequest(atRequestLimit);
        ApplicationCodec.parseRequest(atRequestLimit.getBytes(StandardCharsets.UTF_8));
        rejected(() -> ApplicationCodec.parseRequest(atRequestLimit + " "));
        rejected(() -> ApplicationCodec.parseRequest((atRequestLimit + " ").getBytes(StandardCharsets.UTF_8)));
        String atResultLimit = pad(target);
        ApplicationCodec.result(atResultLimit);
        ApplicationCodec.result(atResultLimit.getBytes(StandardCharsets.UTF_8));
        rejected(() -> ApplicationCodec.result(atResultLimit + " "));
        rejected(() -> ApplicationCodec.result((atResultLimit + " ").getBytes(StandardCharsets.UTF_8)));
        List<Object> workspaces = new ArrayList<>();
        for (int index = 0; index < 50; index++) workspaces.add(workspace("w" + index, title, index));
        String multibyte = json(workspaces(true, workspaces));
        equal(true, multibyte.length() < ApplicationCodec.MAX_JSON_BYTES);
        rejected(() -> ApplicationCodec.result(multibyte));
        rejected(() -> ApplicationCodec.result(multibyte.getBytes(StandardCharsets.UTF_8)));
        rejected(() -> ApplicationCodec.parseRequest(new byte[] { (byte) 0xc0, (byte) 0xaf }));
        rejected(() -> ApplicationCodec.result(new byte[] { (byte) 0xc0, (byte) 0xaf }));
    }

    private static Map<String, Object> mutation(String type, String sessionId, Object... extras) {
        Map<String, Object> request = new LinkedHashMap<>(Protocol.object("v", 1, "type", type, "requestId", REQUEST,
            "operationId", OPERATION, "sessionId", sessionId));
        request.putAll(Protocol.object(extras));
        return request;
    }

    private static Map<String, Object> managed(String action, String outcome, String sessionId) {
        return Protocol.object("v", 1, "type", "managed", "requestId", REQUEST, "operationId", OPERATION,
            "sessionId", sessionId, "action", action, "outcome", outcome);
    }

    private static Map<String, Object> workspaces(boolean enabled, List<?> workspaces) {
        return Protocol.object("v", 1, "type", "managementWorkspaces", "requestId", REQUEST, "enabled", enabled, "workspaces", workspaces);
    }

    private static Map<String, Object> workspace(String id, String title, long order) {
        return Protocol.object("id", id, "title", title, "order", order);
    }

    private static Map<String, Object> summary(String sessionId) {
        return Protocol.object("sessionId", sessionId, "title", "Title", "status", "idle", "navigation",
            Protocol.object("updatedAt", 1, "pinOrder", null, "workspace", workspace("w1", "Work", 0)));
    }

    private static Map<String, Object> with(Map<String, Object> original, String key, Object replacement) {
        Map<String, Object> changed = new LinkedHashMap<>(original);
        changed.put(key, replacement);
        return changed;
    }

    private static Map<String, Object> without(Map<String, Object> original, String key) {
        Map<String, Object> changed = new LinkedHashMap<>(original);
        changed.remove(key);
        return changed;
    }

    private static Map<String, Object> request(byte[] encoded) { return ApplicationCodec.parseRequest(encoded); }
    private static ApplicationCodec.Result result(Map<String, Object> wire) { return ApplicationCodec.result(json(wire)); }
    private static String json(Map<String, Object> wire) { return StrictJson.stringify(wire); }
    private static void rejectedRequest(Map<String, Object> wire) { rejected(() -> ApplicationCodec.parseRequest(json(wire))); }
    private static void rejectedResult(Map<String, Object> wire) { rejected(() -> result(wire)); }
    private static String repeat(String text, int count) { return String.join("", Collections.nCopies(count, text)); }
    private static String pad(String json) { return json + repeat(" ", ApplicationCodec.MAX_JSON_BYTES - json.getBytes(StandardCharsets.UTF_8).length); }

    private static void equal(Object expected, Object actual) {
        if (!Objects.equals(expected, actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
    }

    private static void rejected(Runnable parser) {
        try { parser.run(); }
        catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Parser accepted input outside the management schema");
    }

    private static void immutable(Runnable mutation) {
        try { mutation.run(); }
        catch (UnsupportedOperationException expected) { return; }
        throw new AssertionError("Parsed management collections are mutable");
    }
}
