package io.harnessy.companion.protocol;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Exact text-only application messages. Limits apply to the whole UTF-8 envelope before encryption.
 * Text/item ceilings are fixed phone-local resource limits, not negotiated or shared-protocol maxima.
 */
public final class ApplicationCodec {
    public static final int MAX_JSON_BYTES = 49_152;
    public static final int MAX_TEXT_BYTES = 8192;
    public static final int MAX_TITLE_BYTES = 1024;
    public static final int MAX_ROWS = 128;
    public static final int MAX_SESSIONS = 128;
    private ApplicationCodec() { }

    public enum Type { SESSIONS, HISTORY, WATCHING, PROGRESS, SUBMITTED, CANCELLED, ERROR }

    public static final class SessionSummary {
        public final String sessionId;
        public final String title;
        public final String status;
        private SessionSummary(Map<String, Object> row) {
            sessionId = Protocol.string(row.get("sessionId"));
            title = Protocol.string(row.get("title"));
            status = Protocol.string(row.get("status"));
        }
    }

    public static final class HistoryRow {
        public final String role;
        public final String seq;
        public final String id;
        public final String text;
        private HistoryRow(Map<String, Object> row) {
            role = Protocol.string(row.get("role")); seq = Protocol.string(row.get("seq"));
            id = Protocol.string(row.get("id")); text = Protocol.string(row.get("text"));
        }
    }

    /** Fields not carried by a variant are null; row/session lists are immutable and never null. */
    public static final class Result {
        public final Type type;
        public final String requestId;
        public final String sessionId;
        public final String subscriptionId;
        public final String submissionId;
        public final String cursor;
        public final String status;
        public final String admission;
        public final String code;
        public final List<SessionSummary> sessions;
        public final List<HistoryRow> rows;
        public final Map<String, Object> wire;
        private Result(Map<String, Object> wire) {
            this.wire = wire;
            switch (Protocol.string(wire.get("type"))) {
                case "sessions": type = Type.SESSIONS; break;
                case "history": type = Type.HISTORY; break;
                case "watching": type = Type.WATCHING; break;
                case "progress": type = Type.PROGRESS; break;
                case "submitted": type = Type.SUBMITTED; break;
                case "cancelled": type = Type.CANCELLED; break;
                case "error": type = Type.ERROR; break;
                default: throw invalid();
            }
            requestId = nullable(wire, "requestId"); sessionId = nullable(wire, "sessionId");
            subscriptionId = nullable(wire, "subscriptionId"); submissionId = nullable(wire, "submissionId");
            cursor = nullable(wire, "cursor"); status = nullable(wire, "status");
            admission = nullable(wire, "admission"); code = nullable(wire, "code");
            List<SessionSummary> summaries = new ArrayList<>();
            if (wire.containsKey("sessions")) {
                for (Object item : list(wire.get("sessions"), MAX_SESSIONS)) summaries.add(new SessionSummary(Protocol.record(item)));
            }
            sessions = Collections.unmodifiableList(summaries);
            List<HistoryRow> history = new ArrayList<>();
            if (wire.containsKey("rows")) {
                for (Object item : list(wire.get("rows"), MAX_ROWS)) history.add(new HistoryRow(Protocol.record(item)));
            }
            rows = Collections.unmodifiableList(history);
        }
    }

    public static Result result(byte[] json) { return new Result(parseResult(json)); }
    public static Result result(String json) { return new Result(parseResult(json)); }
    public static Map<String, Object> parseResult(byte[] json) { return validateResult(decode(json)); }
    public static Map<String, Object> parseResult(String json) { return validateResult(decode(json)); }

    private static Map<String, Object> validateResult(Map<String, Object> value) {
        String type = Protocol.string(value.get("type"));
        if ("progress".equals(type)) {
            exact(value, new String[] { "v", "type", "subscriptionId", "sessionId", "rows", "status" }, "cursor");
            Protocol.parseId16(value.get("subscriptionId")); sessionId(value.get("sessionId"));
            rows(value.get("rows")); status(value.get("status")); optionalCursor(value);
            return value;
        }
        Protocol.parseId16(value.get("requestId"));
        switch (type) {
            case "sessions":
                exact(value, new String[] { "v", "type", "requestId", "sessions" }, "cursor");
                Set<String> ids = new HashSet<>();
                for (Object item : list(value.get("sessions"), MAX_SESSIONS)) {
                    Map<String, Object> row = Protocol.exactRecord(item, "sessionId", "title", "status");
                    if (!ids.add(sessionId(row.get("sessionId")))) throw invalid();
                    text(row.get("title"), MAX_TITLE_BYTES, false); status(row.get("status"));
                }
                optionalCursor(value); break;
            case "history":
                exact(value, new String[] { "v", "type", "requestId", "sessionId", "rows" }, "cursor");
                sessionId(value.get("sessionId")); rows(value.get("rows")); optionalCursor(value); break;
            case "watching":
                Protocol.exactRecord(value, "v", "type", "requestId", "sessionId", "subscriptionId");
                sessionId(value.get("sessionId")); Protocol.parseId16(value.get("subscriptionId")); break;
            case "submitted":
                Protocol.exactRecord(value, "v", "type", "requestId", "sessionId", "submissionId", "admission");
                sessionId(value.get("sessionId")); Protocol.parseId16(value.get("submissionId"));
                if (!"inMemoryInbox".equals(value.get("admission"))) throw invalid();
                break;
            case "cancelled":
                Protocol.exactRecord(value, "v", "type", "requestId", "subscriptionId");
                Protocol.parseId16(value.get("subscriptionId")); break;
            case "error":
                Protocol.exactRecord(value, "v", "type", "requestId", "code");
                String code = Protocol.string(value.get("code"));
                if (!"denied".equals(code) && !"notFound".equals(code) && !"limit".equals(code)
                    && !"expired".equals(code) && !"unavailable".equals(code)) throw invalid();
                break;
            default: throw invalid();
        }
        return value;
    }

    public static Map<String, Object> parseRequest(byte[] json) { return validateRequest(decode(json)); }
    public static Map<String, Object> parseRequest(String json) { return validateRequest(decode(json)); }
    private static Map<String, Object> validateRequest(Map<String, Object> value) {
        Protocol.parseId16(value.get("requestId"));
        switch (Protocol.string(value.get("type"))) {
            case "listSessions":
                exact(value, new String[] { "v", "type", "requestId", "limit" }, "cursor");
                Protocol.integer(value.get("limit"), 1, MAX_SESSIONS); optionalCursor(value); break;
            case "readHistory":
                exact(value, new String[] { "v", "type", "requestId", "sessionId", "limit" }, "cursor");
                sessionId(value.get("sessionId")); Protocol.integer(value.get("limit"), 1, MAX_ROWS); optionalCursor(value); break;
            case "watchProgress":
                exact(value, new String[] { "v", "type", "requestId", "sessionId" }, "cursor");
                sessionId(value.get("sessionId")); optionalCursor(value); break;
            case "submitText":
                Protocol.exactRecord(value, "v", "type", "requestId", "sessionId", "text", "submissionId");
                sessionId(value.get("sessionId")); text(value.get("text"), MAX_TEXT_BYTES, true);
                Protocol.parseId16(value.get("submissionId")); break;
            case "cancelRead":
                Protocol.exactRecord(value, "v", "type", "requestId", "subscriptionId");
                Protocol.parseId16(value.get("subscriptionId")); break;
            default: throw invalid();
        }
        return value;
    }

    /** All encoders require caller-generated correlation/submission ids; no automatic retry or id reuse occurs here. */
    public static byte[] listSessions(String requestId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "listSessions", "requestId", requestId, "limit", limit), cursor));
    }
    public static byte[] readHistory(String requestId, String sessionId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "readHistory", "requestId", requestId, "sessionId", sessionId, "limit", limit), cursor));
    }
    public static byte[] watchProgress(String requestId, String sessionId, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "watchProgress", "requestId", requestId, "sessionId", sessionId), cursor));
    }
    public static byte[] submitText(String requestId, String sessionId, String text, String submissionId) {
        return encodeRequest(Protocol.object("v", 1, "type", "submitText", "requestId", requestId, "sessionId", sessionId,
            "text", text, "submissionId", submissionId));
    }
    public static byte[] cancelRead(String requestId, String subscriptionId) {
        return encodeRequest(Protocol.object("v", 1, "type", "cancelRead", "requestId", requestId, "subscriptionId", subscriptionId));
    }
    public static byte[] encodeRequest(Object request) {
        String json = StrictJson.stringify(request, MAX_JSON_BYTES);
        parseRequest(json);
        return json.getBytes(StandardCharsets.UTF_8);
    }
    private static Object withCursor(Map<String, Object> base, String cursor) {
        if (cursor == null) return base;
        Map<String, Object> value = new LinkedHashMap<>(base); value.put("cursor", cursor); return value;
    }
    private static Map<String, Object> decode(byte[] json) {
        Map<String, Object> value = Protocol.record(StrictJson.parse(json, MAX_JSON_BYTES));
        Protocol.version(value); return value;
    }
    private static Map<String, Object> decode(String json) {
        Map<String, Object> value = Protocol.record(StrictJson.parse(json, MAX_JSON_BYTES));
        Protocol.version(value); return value;
    }
    private static String nullable(Map<String, Object> value, String key) {
        return value.containsKey(key) ? Protocol.string(value.get(key)) : null;
    }
    private static void exact(Map<String, Object> value, String[] required, String optional) {
        if (value.size() != required.length + (value.containsKey(optional) ? 1 : 0)) throw invalid();
        for (String key : required) if (!value.containsKey(key)) throw invalid();
    }
    private static List<?> list(Object value, int maximum) {
        if (!(value instanceof List) || ((List<?>) value).size() > maximum) throw invalid();
        return (List<?>) value;
    }
    private static String text(Object value, int maximum, boolean nonempty) {
        String text = Protocol.string(value);
        StrictJson.requireText(text, maximum);
        if (nonempty && text.isEmpty()) throw invalid();
        return text;
    }
    public static String sessionId(Object value) {
        String id = text(value, 128, true);
        if (!id.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) throw invalid();
        return id;
    }
    private static String cursor(Object value) {
        String cursor = text(value, 256, true);
        Protocol.decodeBase64Url(cursor, -1, 192); return cursor;
    }
    private static void optionalCursor(Map<String, Object> value) { if (value.containsKey("cursor")) cursor(value.get("cursor")); }
    private static String status(Object value) {
        String status = Protocol.string(value);
        if (!"idle".equals(status) && !"queued".equals(status) && !"running".equals(status) && !"closed".equals(status)) throw invalid();
        return status;
    }
    private static void rows(Object value) {
        BigInteger previous = BigInteger.valueOf(-1);
        Set<String> ids = new HashSet<>();
        for (Object item : list(value, MAX_ROWS)) {
            Map<String, Object> row = Protocol.exactRecord(item, "role", "seq", "id", "text");
            String role = Protocol.string(row.get("role"));
            if (!"user".equals(role) && !"assistant".equals(role) && !"tool".equals(role) && !"notice".equals(role)) throw invalid();
            BigInteger sequence = new BigInteger(1, Protocol.decodeBase64Url(row.get("seq"), 8));
            String id = sessionId(row.get("id"));
            if (sequence.compareTo(previous) <= 0 || !ids.add(id)) throw invalid();
            previous = sequence;
            text(row.get("text"), MAX_TEXT_BYTES, false);
        }
    }
    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid or over-budget application message");
    }
}
