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
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private ApplicationCodec() { }

    public enum Type { SESSIONS, HISTORY, WATCHING, PROGRESS, SUBMITTED, CANCELLED, ERROR, MANAGEMENT_WORKSPACES, MANAGED,
        SESSION_MODELS, MODEL_SELECTED, SESSION_ACTIVATION, SESSION_OPENED }

    public static final class SessionSummary {
        public final String sessionId;
        public final String title;
        public final String status;
        /** Null for a legacy row; absence supplies no workspace, pin or activity metadata. */
        public final SessionNavigation navigation;
        private SessionSummary(Map<String, Object> row) {
            sessionId = Protocol.string(row.get("sessionId"));
            title = Protocol.string(row.get("title"));
            status = Protocol.string(row.get("status"));
            navigation = row.containsKey("navigation") ? new SessionNavigation(Protocol.record(row.get("navigation"))) : null;
        }
    }

    /** Exact nonnegative JavaScript-safe ranks/timestamps; workspace and pinOrder may be null. */
    public static final class SessionNavigation {
        public final long updatedAt;
        public final Long pinOrder;
        public final WorkspaceInfo workspace;
        private SessionNavigation(Map<String, Object> navigation) {
            updatedAt = safeInteger(navigation.get("updatedAt"));
            pinOrder = navigation.get("pinOrder") == null ? null : safeInteger(navigation.get("pinOrder"));
            workspace = navigation.get("workspace") == null ? null : new WorkspaceInfo(Protocol.record(navigation.get("workspace")));
        }
    }

    public static final class WorkspaceInfo {
        public final String id;
        public final String title;
        public final long order;
        private WorkspaceInfo(Map<String, Object> workspace) {
            id = Protocol.string(workspace.get("id"));
            title = Protocol.string(workspace.get("title"));
            order = safeInteger(workspace.get("order"));
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

    /** One advertised model choice: an opaque PC-minted handle and two bounded display labels. */
    public static final class ModelChoice {
        public final String id;
        public final String title;
        public final String providerTitle;
        private ModelChoice(Map<String, Object> row) {
            id = Protocol.string(row.get("id"));
            title = Protocol.string(row.get("title"));
            providerTitle = Protocol.string(row.get("providerTitle"));
        }
    }

    /** Absent strings/session are null, enabled defaults false, and lists are immutable and never null.
     *  Model fields stay null or empty for every other result type. */
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
        public final String operationId;
        public final String action;
        public final String outcome;
        public final boolean enabled;
        public final List<WorkspaceInfo> workspaces;
        public final SessionSummary session;
        public final List<SessionSummary> sessions;
        public final List<HistoryRow> rows;
        /** Advertised model catalog state; null unless the PC answered with a model page. */
        public final String modelState;
        /** PC-issued catalog revision a selection must echo; null outside a ready catalog page. */
        public final String modelRevision;
        public final List<ModelChoice> modelChoices;
        public final ModelChoice currentModel;
        public final ModelChoice selectedModel;
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
                case "managementWorkspaces": type = Type.MANAGEMENT_WORKSPACES; break;
                case "managed": type = Type.MANAGED; break;
                case "sessionModels": type = Type.SESSION_MODELS; break;
                case "modelSelected": type = Type.MODEL_SELECTED; break;
                case "sessionActivation": type = Type.SESSION_ACTIVATION; break;
                case "sessionOpened": type = Type.SESSION_OPENED; break;
                default: throw invalid();
            }
            requestId = nullable(wire, "requestId"); sessionId = nullable(wire, "sessionId");
            subscriptionId = nullable(wire, "subscriptionId"); submissionId = nullable(wire, "submissionId");
            cursor = nullable(wire, "cursor"); status = nullable(wire, "status");
            admission = nullable(wire, "admission"); code = nullable(wire, "code");
            operationId = nullable(wire, "operationId"); action = nullable(wire, "action"); outcome = nullable(wire, "outcome");
            modelState = nullable(wire, "state"); modelRevision = nullable(wire, "revision");
            enabled = Boolean.TRUE.equals(wire.get("enabled"));
            session = wire.containsKey("session") ? new SessionSummary(Protocol.record(wire.get("session"))) : null;
            List<WorkspaceInfo> workspaceList = new ArrayList<>();
            if (wire.containsKey("workspaces")) {
                for (Object workspace : list(wire.get("workspaces"), MAX_SESSIONS)) workspaceList.add(new WorkspaceInfo(Protocol.record(workspace)));
            }
            workspaces = Collections.unmodifiableList(workspaceList);
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
            List<ModelChoice> choices = new ArrayList<>();
            if (wire.containsKey("models")) {
                for (Object item : list(wire.get("models"), MAX_ROWS)) choices.add(new ModelChoice(Protocol.record(item)));
            }
            modelChoices = Collections.unmodifiableList(choices);
            currentModel = wire.get("current") == null ? null : new ModelChoice(Protocol.record(wire.get("current")));
            selectedModel = wire.get("selected") == null ? null : new ModelChoice(Protocol.record(wire.get("selected")));
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
                    Map<String, Object> row = Protocol.record(item);
                    exact(row, new String[] { "sessionId", "title", "status" }, "navigation");
                    if (!ids.add(sessionId(row.get("sessionId")))) throw invalid();
                    text(row.get("title"), MAX_TITLE_BYTES, false); status(row.get("status"));
                    if (row.containsKey("navigation")) navigation(row.get("navigation"));
                }
                optionalCursor(value); break;
            case "managementWorkspaces":
                managementWorkspaces(value); break;
            case "managed":
                managed(value); break;
            case "sessionModels":
                sessionModels(value); break;
            case "modelSelected":
                modelSelected(value); break;
            case "sessionActivation":
                Protocol.exactRecord(value, "v", "type", "requestId", "enabled"); bool(value.get("enabled")); break;
            case "sessionOpened":
                sessionOpened(value); break;
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
                if (value.containsKey("view")) {
                    exact(value, new String[] { "v", "type", "requestId", "limit", "view" }, "cursor");
                    if (!"navigation".equals(value.get("view"))) throw invalid();
                } else exact(value, new String[] { "v", "type", "requestId", "limit" }, "cursor");
                Protocol.integer(value.get("limit"), 1, MAX_SESSIONS); optionalCursor(value); break;
            case "listManagementWorkspaces":
                exact(value, new String[] { "v", "type", "requestId", "limit" }, "cursor");
                Protocol.integer(value.get("limit"), 1, MAX_SESSIONS); optionalCursor(value); break;
            case "listSessionModels":
                exact(value, new String[] { "v", "type", "requestId", "sessionId", "limit" }, "cursor");
                sessionId(value.get("sessionId")); Protocol.integer(value.get("limit"), 1, MAX_ROWS); optionalCursor(value); break;
            case "createSession":
                Protocol.exactRecord(value, "v", "type", "requestId", "operationId", "sessionId", "workspaceId");
                mutation(value); sessionId(value.get("workspaceId"));
                if (!createdSessionId(value)) throw invalid();
                break;
            case "renameSession":
                Protocol.exactRecord(value, "v", "type", "requestId", "operationId", "sessionId", "title");
                mutation(value); text(value.get("title"), MAX_TITLE_BYTES, false); break;
            case "getSessionActivation":
                Protocol.exactRecord(value, "v", "type", "requestId"); break;
            case "openSession":
            case "archiveSession":
                Protocol.exactRecord(value, "v", "type", "requestId", "operationId", "sessionId");
                mutation(value); break;
            case "setSessionPinned":
                Protocol.exactRecord(value, "v", "type", "requestId", "operationId", "sessionId", "pinned");
                mutation(value); bool(value.get("pinned")); break;
            case "selectSessionModel":
                Protocol.exactRecord(value, "v", "type", "requestId", "operationId", "sessionId", "revision", "choiceId");
                mutation(value); Protocol.parseId16(value.get("revision")); Protocol.parseId16(value.get("choiceId")); break;
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

    /** All encoders require caller-generated correlation/operation/submission ids; no automatic retry or id reuse occurs here. */
    public static byte[] listSessions(String requestId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "listSessions", "requestId", requestId, "limit", limit), cursor));
    }
    /** Opt-in read-only metadata; legacy peers may reject this request rather than downgrade it. */
    public static byte[] listSessionNavigation(String requestId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "listSessions", "requestId", requestId,
            "limit", limit, "view", "navigation"), cursor));
    }
    /** Lists PC-approved creation targets; disabled results carry neither targets nor a cursor. */
    public static byte[] listManagementWorkspaces(String requestId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "listManagementWorkspaces", "requestId", requestId,
            "limit", limit), cursor));
    }
    /** Lists the model choices the PC advertises for one Session; choices are opaque handles, never provider or model identifiers. */
    public static byte[] listSessionModels(String requestId, String sessionId, int limit, String cursor) {
        return encodeRequest(withCursor(Protocol.object("v", 1, "type", "listSessionModels", "requestId", requestId,
            "sessionId", sessionId, "limit", limit), cursor));
    }
    /** Reads only the current independent activation permission; never opens an Agent. */
    public static byte[] getSessionActivation(String requestId) {
        return encodeRequest(Protocol.object("v", 1, "type", "getSessionActivation", "requestId", requestId));
    }
    /** Explicit existing-chat opening; the caller persists its uncertainty fence before sending. */
    public static byte[] openSession(String requestId, String operationId, String sessionId) {
        return encodeRequest(Protocol.object("v", 1, "type", "openSession", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId));
    }
    /** Caller-owned operation IDs bind creation to the exact mobile-${operationId} session ID. */
    public static byte[] createSession(String requestId, String operationId, String sessionId, String workspaceId) {
        return encodeRequest(Protocol.object("v", 1, "type", "createSession", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId, "workspaceId", workspaceId));
    }
    public static byte[] renameSession(String requestId, String operationId, String sessionId, String title) {
        return encodeRequest(Protocol.object("v", 1, "type", "renameSession", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId, "title", title));
    }
    public static byte[] archiveSession(String requestId, String operationId, String sessionId) {
        return encodeRequest(Protocol.object("v", 1, "type", "archiveSession", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId));
    }
    /** Sends the desired pin state, never a toggle or an automatic retry. */
    public static byte[] setSessionPinned(String requestId, String operationId, String sessionId, boolean pinned) {
        return encodeRequest(Protocol.object("v", 1, "type", "setSessionPinned", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId, "pinned", pinned));
    }
    /** Selects one advertised choice; the PC-issued revision fences the catalog the choice came from. */
    public static byte[] selectSessionModel(String requestId, String operationId, String sessionId, String revision, String choiceId) {
        return encodeRequest(Protocol.object("v", 1, "type", "selectSessionModel", "requestId", requestId,
            "operationId", operationId, "sessionId", sessionId, "revision", revision, "choiceId", choiceId));
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
    private static void mutation(Map<String, Object> value) {
        Protocol.parseId16(value.get("operationId")); sessionId(value.get("sessionId"));
    }
    private static boolean createdSessionId(Map<String, Object> value) {
        return ("mobile-" + Protocol.string(value.get("operationId"))).equals(value.get("sessionId"));
    }
    private static boolean bool(Object value) {
        if (!(value instanceof Boolean)) throw invalid();
        return (Boolean) value;
    }
    private static void managementWorkspaces(Map<String, Object> value) {
        exact(value, new String[] { "v", "type", "requestId", "enabled", "workspaces" }, "cursor");
        boolean enabled = bool(value.get("enabled"));
        List<?> workspaces = list(value.get("workspaces"), MAX_SESSIONS);
        if (!enabled && (!workspaces.isEmpty() || value.containsKey("cursor"))) throw invalid();
        Set<String> ids = new HashSet<>();
        for (Object workspace : workspaces) {
            Map<String, Object> row = workspace(workspace);
            if (!ids.add(sessionId(row.get("id")))) throw invalid();
        }
        optionalCursor(value);
    }
    private static void managed(Map<String, Object> value) {
        mutation(value);
        String action = Protocol.string(value.get("action"));
        if (!"create".equals(action) && !"rename".equals(action) && !"archive".equals(action) && !"pin".equals(action)) throw invalid();
        if ("create".equals(action) && !createdSessionId(value)) throw invalid();
        String[] common = { "v", "type", "requestId", "operationId", "sessionId", "action", "outcome" };
        switch (Protocol.string(value.get("outcome"))) {
            case "applied":
                if ("archive".equals(action)) Protocol.exactRecord(value, common);
                else {
                    exact(value, common, "session");
                    managedSession(value);
                }
                break;
            case "rejected":
                exact(value, common, "code");
                rejectionCode(value.get("code"));
                break;
            case "unknown":
                Protocol.exactRecord(value, common); break;
            default: throw invalid();
        }
    }
    private static void managedSession(Map<String, Object> value) {
        Map<String, Object> row = Protocol.exactRecord(value.get("session"), "sessionId", "title", "status", "navigation");
        if (!sessionId(row.get("sessionId")).equals(value.get("sessionId"))) throw invalid();
        text(row.get("title"), MAX_TITLE_BYTES, false); status(row.get("status")); navigation(row.get("navigation"));
    }
    private static void sessionOpened(Map<String, Object> value) {
        mutation(value);
        String[] common = { "v", "type", "requestId", "operationId", "sessionId", "outcome" };
        switch (Protocol.string(value.get("outcome"))) {
            case "applied":
                exact(value, common, "session"); managedSession(value);
                if ("closed".equals(Protocol.record(value.get("session")).get("status"))) throw invalid();
                break;
            case "rejected":
                exact(value, common, "code"); rejectionCode(value.get("code")); break;
            case "unknown":
                Protocol.exactRecord(value, common); break;
            default: throw invalid();
        }
    }
    /** Fixed refusal codes shared by all explicit chat mutations. */
    private static void rejectionCode(Object value) {
        String code = Protocol.string(value);
        if (!"denied".equals(code) && !"expired".equals(code) && !"notFound".equals(code) && !"busy".equals(code)
            && !"conflict".equals(code) && !"limit".equals(code) && !"unavailable".equals(code)) throw invalid();
    }
    private static void sessionModels(Map<String, Object> value) {
        sessionId(value.get("sessionId"));
        switch (Protocol.string(value.get("state"))) {
            case "ready":
                exact(value, new String[] { "v", "type", "requestId", "sessionId", "state", "models", "current", "revision" }, "cursor");
                modelChoices(value.get("models")); currentChoice(value.get("current"));
                Protocol.parseId16(value.get("revision")); optionalCursor(value); break;
            case "busy":
                Protocol.exactRecord(value, "v", "type", "requestId", "sessionId", "state", "models", "current");
                noModels(value.get("models")); currentChoice(value.get("current")); break;
            case "denied":
            case "closed":
                Protocol.exactRecord(value, "v", "type", "requestId", "sessionId", "state", "models", "current");
                noModels(value.get("models"));
                if (value.get("current") != null) throw invalid();
                break;
            default: throw invalid();
        }
    }
    private static void modelSelected(Map<String, Object> value) {
        mutation(value);
        String[] common = { "v", "type", "requestId", "operationId", "sessionId", "outcome" };
        switch (Protocol.string(value.get("outcome"))) {
            case "applied":
                exact(value, common, "selected"); modelChoice(value.get("selected")); break;
            case "rejected":
                exact(value, common, "code"); rejectionCode(value.get("code")); break;
            case "unknown":
                Protocol.exactRecord(value, common); break;
            default: throw invalid();
        }
    }
    /** Validates one advertised choice and returns its opaque handle for uniqueness checks. */
    private static String modelChoice(Object value) {
        Map<String, Object> row = Protocol.exactRecord(value, "id", "title", "providerTitle");
        String id = Protocol.parseId16(row.get("id"));
        text(row.get("title"), MAX_TITLE_BYTES, true); text(row.get("providerTitle"), MAX_TITLE_BYTES, true);
        return id;
    }
    private static void modelChoices(Object value) {
        Set<String> ids = new HashSet<>();
        for (Object item : list(value, MAX_ROWS)) if (!ids.add(modelChoice(item))) throw invalid();
    }
    private static void currentChoice(Object value) { if (value != null) modelChoice(value); }
    private static void noModels(Object value) { if (!list(value, MAX_ROWS).isEmpty()) throw invalid(); }
    private static Map<String, Object> workspace(Object value) {
        Map<String, Object> workspace = Protocol.exactRecord(value, "id", "title", "order");
        sessionId(workspace.get("id")); text(workspace.get("title"), MAX_TITLE_BYTES, false); safeInteger(workspace.get("order"));
        return workspace;
    }
    private static long safeInteger(Object value) {
        return Protocol.integer(value, 0, MAX_SAFE_INTEGER);
    }
    private static void navigation(Object value) {
        Map<String, Object> navigation = Protocol.exactRecord(value, "updatedAt", "pinOrder", "workspace");
        safeInteger(navigation.get("updatedAt"));
        if (navigation.get("pinOrder") != null) safeInteger(navigation.get("pinOrder"));
        if (navigation.get("workspace") != null) workspace(navigation.get("workspace"));
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
