package io.harnessy.companion;

import io.harnessy.companion.protocol.ApplicationCodec;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import io.harnessy.companion.transport.PhoneTransport;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import static io.harnessy.companion.CompanionPlatform.*;
import static io.harnessy.companion.presentation.DisplayModels.*;

/** Source-only entry. Fake clock, network, preferences and keystore; real controller, parsers and immutable models. */
public final class ControllerRegression {
    private ControllerRegression() { }
    public static void main(String[] arguments) throws Exception {
        lostAckNeverResendsAndRetiredCallbacksCannotAcknowledge();
        reconnectWaitsForOldTransportAndContinuesAtBoundedRate();
        missingPairedKeyRequiresRepairWithoutEnrollment();
        failedFenceCommitPreventsSendAndFailedClearRemainsFenced();
        pagingRoundTripsCursorsAndRejectsWrongCorrelations();
        inboxAcknowledgementRetainsEditedDraftAndRunningSessionAllowsFollowup();
        foregroundStopBeforeAdmissionLeavesOnlyMinimalRestartWarning();
        failedEnrollmentAndForgetCommitsRetainExactIdentity();
        confirmedOffscreenStorageSettlesOnForegroundReload();
        foregroundMetadataLoadPreventsStaleForgetSnapshot();
        clearingDeliveryFenceCannotClearPairingRepair();
        historyBaselineMergesWatchProgressAndRefreshRetainsOlderSelection();
    }

    private static void lostAckNeverResendsAndRetiredCallbacksCannotAcknowledge() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready();
        fixture.controller.draftChanged("follow-up"); fixture.controller.sendText("follow-up"); fixture.pump();
        FakeLink previous = fixture.latest(); Map<String, Object> submitted = previous.last("submitText");
        check(submitted != null && fixture.fences.size() == 1, "Fence precedes possible admission");
        previous.events.disconnected();
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN, "Lost ACK requires explicit review");
        fixture.advance(5000); fixture.confirm();
        previous.result(ack(submitted)); fixture.pump();
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN, "Retired ACK cannot clear warning");
        check(fixture.latest().last("submitText") == null && fixture.screen.composer.draft.equals("follow-up"), "Reconnect never resends or clears draft");
    }

    private static void reconnectWaitsForOldTransportAndContinuesAtBoundedRate() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready();
        FakeLink old = fixture.latest(); old.autoQuiet = false;
        fixture.controller.stop(); fixture.controller.start(); fixture.pump();
        fixture.advance(5000);
        check(fixture.links.size() == 1 && old.closed, "Old resource completion owns reconnect readiness");
        old.quiet.complete(null); fixture.pump();
        check(fixture.links.size() == 2, "Fresh attempt begins after quiescence");
        fixture.confirm();
        old.result(Protocol.object("v", 1, "type", "sessions", "requestId", Protocol.randomId(16), "sessions", Collections.emptyList()));
        check(fixture.screen.pc.connection == Connection.ONLINE, "Stale callback does not replace foreground state");
        for (int cycle = 0; cycle < 6; cycle++) {
            int count = fixture.links.size(); fixture.latest().events.disconnected(); fixture.pump();
            fixture.advance(4999); check(fixture.links.size() == count, "Retry cannot exceed configured rate");
            fixture.advance(1); check(fixture.links.size() == count + 1, "Foreground retries have no finite exhaustion");
            fixture.confirm();
        }
    }

    private static void missingPairedKeyRequiresRepairWithoutEnrollment() throws Exception {
        Fixture fixture = new Fixture(); fixture.missingKey = true;
        fixture.controller.start(); fixture.pump();
        check(fixture.screen.composer.feedback == Feedback.REPAIR_REQUIRED, "Missing paired identity reports repair");
        check(fixture.links.isEmpty() && fixture.createdKeys.isEmpty(), "Missing identity is never replaced or connected");
    }

    private static void failedFenceCommitPreventsSendAndFailedClearRemainsFenced() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready(); fixture.failPut = true;
        fixture.controller.draftChanged("text"); fixture.controller.sendText("text"); fixture.pump();
        check(fixture.latest().last("submitText") == null, "Failed pre-send commit fails closed");
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN, "Failed write retains operation fence");
        fixture.failPut = false; fixture.controller.resolveUnknown(); fixture.pump();
        fixture.controller.sendText("text"); fixture.pump();
        Map<String, Object> request = fixture.latest().last("submitText");
        fixture.failClear = true; fixture.latest().result(ack(request)); fixture.pump();
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN, "Unknown clear durability still blocks composer");
        fixture.controller.stop(); fixture.controller.start(); fixture.pump(); fixture.advance(5000); fixture.confirm();
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN, "Preference memory changes cannot remove RAM fence on restart");
        fixture.failClear = false; fixture.controller.resolveUnknown(); fixture.pump();
        check(fixture.fences.isEmpty(), "Only explicit reviewed clear releases uncertainty");
    }

    private static void pagingRoundTripsCursorsAndRejectsWrongCorrelations() throws Exception {
        Fixture fixture = new Fixture(); fixture.controller.start(); fixture.pump(); fixture.confirm();
        Map<String, Object> listing = fixture.latest().last("listSessions");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", Protocol.randomId(16),
            "sessions", Collections.singletonList(session("wrong", "idle"))));
        check(fixture.screen.sessions.rows.isEmpty(), "Uncorrelated sessions are ignored");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", listing.get("requestId"),
            "sessions", Collections.singletonList(session("s1", "running")), "cursor", "cGFnZQ"));
        fixture.controller.loadMoreSessions();
        check("cGFnZQ".equals(fixture.latest().last("listSessions").get("cursor")), "Opaque listing cursor round trips unchanged");
        Map<String, Object> next = fixture.latest().last("listSessions");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", next.get("requestId"),
            "sessions", Collections.singletonList(session("s2", "idle"))));
        fixture.controller.selectSession("s1"); fixture.watching(); Map<String, Object> read = fixture.latest().last("readHistory");
        fixture.latest().result(history(read.get("requestId"), "s2", Collections.singletonList(row(1, "bad", "wrong")), null));
        check(fixture.screen.conversation.rows.isEmpty(), "Exact request plus selected session required");
        fixture.latest().result(history(read.get("requestId"), "s1", Collections.singletonList(row(1, "r1", "one")), "aGlzdG9yeQ"));
        fixture.controller.loadMoreHistory(); Map<String, Object> page = fixture.latest().last("readHistory");
        check("aGlzdG9yeQ".equals(page.get("cursor")), "History cursor is not interpreted or replaced with progress cursor");
        fixture.latest().result(history(page.get("requestId"), "s1", java.util.Arrays.asList(row(1, "r1", "one"), row(2, "r2", "two")), null));
        String subscription = fixture.subscription;
        fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", Protocol.randomId(16),
            "sessionId", "s1", "rows", Collections.singletonList(row(3, "wrong", "bad")), "status", "running"));
        check(fixture.screen.conversation.rows.size() == 2, "Wrong subscription cannot append text");
        fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
            "sessionId", "s1", "rows", java.util.Arrays.asList(row(2, "r2", "two"), row(3, "r3", "three")), "status", "closed", "cursor", "cHJvZ3Jlc3M"));
        check(fixture.screen.conversation.rows.size() == 2 && fixture.screen.conversation.rows.get(0).id.equals("r2"), "Deduplication retains a bounded sequence-ordered window");
        check(fixture.screen.composer.state == SendState.CLOSED && !fixture.screen.conversation.canLoadMore, "Closed status disables send and progress cursor cannot become history paging");
    }

    private static void inboxAcknowledgementRetainsEditedDraftAndRunningSessionAllowsFollowup() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready();
        check(fixture.screen.conversation.session.status == SessionStatus.BUSY && fixture.screen.composer.state == SendState.READY,
            "Running session still permits queued follow-ups");
        fixture.controller.draftChanged("first"); fixture.controller.sendText("first"); fixture.pump();
        Map<String, Object> request = fixture.latest().last("submitText"); fixture.controller.draftChanged("edited");
        fixture.latest().result(ack(request)); fixture.pump();
        check(fixture.screen.composer.feedback == Feedback.INBOX_ADMITTED && fixture.screen.composer.draft.equals("edited"), "Volatile inbox ACK is not task completion and clears only unchanged draft");
        fixture.controller.sendText("edited"); fixture.pump(); Map<String, Object> second = fixture.latest().last("submitText");
        check(!second.get("submissionId").equals(request.get("submissionId")), "Next explicit send has a fresh identity");
        fixture.latest().result(ack(second)); fixture.pump();
        check(fixture.screen.composer.draft.isEmpty(), "Matching ACK clears unchanged draft after confirmed fence removal");
    }

    private static void foregroundStopBeforeAdmissionLeavesOnlyMinimalRestartWarning() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready();
        fixture.controller.draftChanged("private task text"); fixture.controller.sendText("private task text");
        fixture.io.removeFirst().run(); // Stop after the external commit, before its main-thread continuation.
        fixture.controller.stop(); fixture.pump();
        check(fixture.latest().last("submitText") == null, "Foreground retirement suppresses post-commit send");
        fixture.controller = fixture.newController(); fixture.controller.start(); fixture.pump(); fixture.confirm();
        check(fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN && fixture.screen.composer.draft.isEmpty(), "Process owner reconstructs only warning, never task text or resend intent");
        check(fixture.fences.values().iterator().next().sessionId.equals("s1"), "Minimal fence identifies original session");
    }

    private static void failedEnrollmentAndForgetCommitsRetainExactIdentity() throws Exception {
        Fixture fixture = new Fixture(); fixture.saved.clear(); fixture.controller.start(); fixture.pump();
        fixture.controller.showPairing(); fixture.controller.pairFromLink(fixture.invitation()); fixture.pump();
        check(fixture.pairing.fingerprint.matches("[0-9a-f]{64}"), "Native enrollment exposes full lowercase SHA-256 DER fingerprint");
        String alias = fixture.createdKeys.get(0); fixture.failSave = true; fixture.confirm(); fixture.pump();
        check(!fixture.deletedKeys.contains(alias) && fixture.repairs.containsKey(fixture.pair.pcId), "Unknown enrollment commit retains alias and repair marker");
        fixture.controller.cancelPairing(); fixture.controller.stop(); fixture.controller.start(); fixture.pump();
        fixture.failForget = true; fixture.controller.forgetPairing(fixture.pair.pcId); fixture.pump();
        check(!fixture.deletedKeys.contains(alias), "Failed metadata removal never deletes exact phone identity");
        fixture.failForget = false; fixture.controller.forgetPairing(fixture.pair.pcId); fixture.pump();
        check(fixture.deletedKeys.contains(alias) && fixture.saved.isEmpty() && fixture.repairs.isEmpty(), "Confirmed local forget removes metadata before exact alias");
    }

    private static void confirmedOffscreenStorageSettlesOnForegroundReload() throws Exception {
        Fixture forgotten = new Fixture(); forgotten.ready(); forgotten.controller.forgetPairing(forgotten.pair.pcId);
        forgotten.io.removeFirst().run();
        forgotten.controller.stop(); forgotten.controller.start();
        String forgetIntent = forgotten.invitation(); forgotten.controller.importLink(forgetIntent); forgotten.pump();
        check(forgotten.pairing != null && forgotten.pairing.link.equals(forgetIntent) && forgotten.createdKeys.isEmpty(),
            "An intent survives offscreen forget settlement without creating an identity");
        forgotten.controller.cancelPairing();
        check(forgotten.screen.pc == null && forgotten.saved.isEmpty(), "Confirmed offscreen forget cannot leave a sticky blocker");
        forgotten.controller.showPairing();
        check(forgotten.pairing != null && forgotten.pairing.state == PairingState.EDITING, "Fresh pairing follows confirmed removal");

        Fixture enrolled = new Fixture(); enrolled.saved.clear(); enrolled.controller.start(); enrolled.pump();
        enrolled.controller.showPairing(); enrolled.controller.pairFromLink(enrolled.invitation()); enrolled.pump();
        enrolled.confirm(); enrolled.io.removeFirst().run();
        enrolled.controller.stop(); enrolled.controller.start();
        String enrollIntent = enrolled.invitation(); enrolled.controller.importLink(enrollIntent); enrolled.pump();
        check(enrolled.pairing != null && enrolled.pairing.link.equals(enrollIntent), "Enrollment settlement preserves the new epoch's intent preview");
        enrolled.controller.cancelPairing(); enrolled.pump(); enrolled.advance(5000); enrolled.confirm();
        check(enrolled.screen.pc.connection == Connection.ONLINE && enrolled.createdKeys.size() == 1,
            "Confirmed offscreen enrollment reconnects with the committed identity rather than creating another");
        check(enrolled.deletedKeys.isEmpty(), "Retirement cannot delete an identity already committed to pairing metadata");
    }

    private static void foregroundMetadataLoadPreventsStaleForgetSnapshot() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready(); fixture.controller.stop(); fixture.controller.start();
        fixture.io.removeFirst().run(); // Captured old metadata is waiting for current main-thread reconciliation.
        fixture.controller.forgetPairing(fixture.pair.pcId);
        check(fixture.io.isEmpty() && fixture.saved.size() == 1, "Storage cannot mutate before foreground metadata reconciliation");
        fixture.pump(); fixture.controller.forgetPairing(fixture.pair.pcId); fixture.pump();
        check(fixture.saved.isEmpty() && fixture.screen.pc == null, "Reconciled forget cannot resurrect a stale pairing snapshot");

        Fixture imported = new Fixture(); imported.saved.clear(); imported.controller.start();
        imported.controller.importLink(imported.invitation()); imported.pump();
        check(imported.pairing != null && imported.pairing.state == PairingState.EDITING && imported.createdKeys.isEmpty(),
            "An intent received during metadata loading remains a RAM-only preview, not implicit enrollment");

        Fixture oversized = new Fixture(); oversized.saved.clear(); oversized.controller.start();
        char[] wide = new char[1366]; java.util.Arrays.fill(wide, '界');
        oversized.controller.importLink(new String(wide));
        check(oversized.screen.feedback == Feedback.PAIRING_INVALID, "Loading-time imports count complete UTF-8 bytes, not characters");
        oversized.pump();
        check(oversized.pairing == null && oversized.createdKeys.isEmpty(), "Over-budget intents are not retained or enrolled");
    }

    private static void clearingDeliveryFenceCannotClearPairingRepair() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready(); fixture.controller.sendText("uncertain text"); fixture.pump();
        fixture.failForget = true; fixture.controller.forgetPairing(fixture.pair.pcId); fixture.pump();
        check(!fixture.fences.isEmpty() && !fixture.repairs.isEmpty(), "Failed forget retains independent delivery and pairing uncertainty");
        fixture.controller.resolveUnknown(); fixture.pump();
        check(fixture.fences.isEmpty() && !fixture.repairs.isEmpty(), "Reviewed delivery clear does not remove a pairing repair marker");
        fixture.controller.showPairing(); fixture.advance(60000);
        check(fixture.pairing == null && fixture.screen.composer.feedback == Feedback.REPAIR_REQUIRED
            && fixture.screen.pc.connection == Connection.OFFLINE, "A successful fence clear cannot restore failed pairing authority");
        check(fixture.deletedKeys.isEmpty(), "Failed pairing metadata removal preserves the exact keystore alias");
    }

    private static void historyBaselineMergesWatchProgressAndRefreshRetainsOlderSelection() throws Exception {
        Fixture fixture = new Fixture(); fixture.controller.start(); fixture.pump(); fixture.confirm();
        Map<String, Object> first = fixture.latest().last("listSessions");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", first.get("requestId"),
            "sessions", Collections.singletonList(session("newer", "idle")), "cursor", "cGFnZQ"));
        fixture.controller.loadMoreSessions(); Map<String, Object> next = fixture.latest().last("listSessions");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", next.get("requestId"),
            "sessions", Collections.singletonList(session("s1", "running"))));
        fixture.controller.selectSession("s1");
        check(fixture.latest().last("readHistory") == null, "Live watch cut must precede the baseline read");
        fixture.watching(); Map<String, Object> baseline = fixture.latest().last("readHistory");
        fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", fixture.subscription,
            "sessionId", "s1", "rows", Collections.singletonList(row(2, "live", "live")), "status", "running"));
        fixture.latest().result(history(baseline.get("requestId"), "s1", Collections.singletonList(row(1, "baseline", "baseline")), null));
        check(fixture.screen.conversation.rows.size() == 2 && fixture.screen.conversation.rows.get(1).id.equals("live"),
            "Concurrent committed progress survives baseline sequence merging");
        fixture.controller.refresh(); Map<String, Object> refreshed = fixture.latest().last("listSessions");
        fixture.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", refreshed.get("requestId"),
            "sessions", Collections.singletonList(session("newer", "idle")), "cursor", "cGFnZQ"));
        check(fixture.screen.conversation.session.id.equals("s1") && fixture.screen.conversation.rows.size() == 2,
            "An incomplete first page cannot remove an older selected Session or its text");
        fixture.watching(); Map<String, Object> renewal = fixture.latest().last("readHistory");
        fixture.latest().result(history(renewal.get("requestId"), "s1", Collections.singletonList(row(1, "baseline", "baseline")), null));
        check(fixture.screen.conversation.rows.get(1).id.equals("live"), "First-page baseline refresh does not erase retained live text");
        Map<String, Object> active = fixture.latest().last("watchProgress");
        fixture.latest().result(Protocol.object("v", 1, "type", "error", "requestId", active.get("requestId"), "code", "expired"));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED && fixture.screen.conversation.rows.size() == 2,
            "A terminal error after WATCHING retires the correlated watch but preserves displayed text");
    }

    private static Map<String, Object> session(String id, String status) {
        return Protocol.object("sessionId", id, "title", id, "status", status);
    }
    private static Map<String, Object> row(long sequence, String id, String text) {
        return Protocol.object("role", "assistant", "seq", Protocol.encodeCounter(sequence), "id", id, "text", text);
    }
    private static Map<String, Object> history(Object request, String session, List<?> rows, String cursor) {
        Map<String, Object> response = new LinkedHashMap<>(Protocol.object("v", 1, "type", "history", "requestId", request, "sessionId", session, "rows", rows));
        if (cursor != null) response.put("cursor", cursor);
        return response;
    }
    private static Map<String, Object> ack(Map<String, Object> submitted) {
        return Protocol.object("v", 1, "type", "submitted", "requestId", submitted.get("requestId"),
            "sessionId", submitted.get("sessionId"), "submissionId", submitted.get("submissionId"), "admission", "inMemoryInbox");
    }
    private static void check(boolean condition, String requirement) { if (!condition) throw new AssertionError(requirement); }

    private static final class Fixture implements CompanionPlatform, CompanionController.Output {
        final ArrayDeque<Runnable> io = new ArrayDeque<>();
        final ArrayDeque<Runnable> main = new ArrayDeque<>();
        final List<Timer> timers = new ArrayList<>();
        final List<FakeLink> links = new ArrayList<>();
        final List<Paired> saved = new ArrayList<>();
        final Map<String, Fence> fences = new LinkedHashMap<>();
        final Map<String, Repair> repairs = new LinkedHashMap<>();
        final List<String> createdKeys = new ArrayList<>();
        final List<String> deletedKeys = new ArrayList<>();
        final Paired pair;
        final Identity phone;
        CompanionController controller;
        Screen screen;
        Pairing pairing;
        String subscription;
        long clock = 1000;
        boolean missingKey, failPut, failClear, failSave, failForget;

        Fixture() throws GeneralSecurityException {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1")); KeyPair key = generator.generateKeyPair();
            String spki = Protocol.encodeBase64Url(key.getPublic().getEncoded());
            pair = new Paired(new String[] { Protocol.derivePcId(spki), spki, "https://relay.example", "existing-alias", "grant-id" }, 1);
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(key.getPublic().getEncoded());
            StringBuilder fingerprint = new StringBuilder();
            for (byte octet : digest) fingerprint.append(String.format(java.util.Locale.ROOT, "%02x", octet & 255));
            phone = new Identity(pair.alias, spki, fingerprint.toString()); saved.add(pair); controller = newController();
        }
        CompanionController newController() {
            CompanionController fresh = new CompanionController(this,
                new ControllerLimits(new int[] { 5000, 10000, 20000, 15000, 8, 64, 128, 2, 32, 60000 }), "Linked PC");
            fresh.attach(this); return fresh;
        }
        void ready() {
            controller.start(); pump(); confirm();
            Map<String, Object> listing = latest().last("listSessions");
            latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", listing.get("requestId"), "sessions", Collections.singletonList(session("s1", "running"))));
            controller.selectSession("s1"); watching(); Map<String, Object> read = latest().last("readHistory");
            latest().result(history(read.get("requestId"), "s1", Collections.emptyList(), null));
        }
        void confirm() { latest().events.confirmed(pair.grantId, pair.generation, pair.pcKey); }
        void watching() {
            Map<String, Object> watch = latest().last("watchProgress"); subscription = Protocol.randomId(16);
            latest().result(Protocol.object("v", 1, "type", "watching", "requestId", watch.get("requestId"), "sessionId", watch.get("sessionId"), "subscriptionId", subscription));
            latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", watch.get("sessionId"), "rows", Collections.emptyList(), "status", "running"));
        }
        FakeLink latest() { return links.get(links.size() - 1); }
        void pump() {
            int bounded = 0;
            while (!io.isEmpty() || !main.isEmpty()) {
                if (++bounded > 1000) throw new AssertionError("Unbounded executor work");
                if (!io.isEmpty()) io.removeFirst().run();
                while (!main.isEmpty()) main.removeFirst().run();
            }
        }
        void advance(int milliseconds) {
            long target = clock + milliseconds;
            while (true) {
                Timer earliest = null;
                for (Timer timer : timers) if (!timer.cancelled && timer.at <= target && (earliest == null || timer.at < earliest.at)) earliest = timer;
                if (earliest == null) break;
                clock = earliest.at; earliest.cancelled = true; earliest.callback.run(); pump();
            }
            clock = target; pump();
        }
        String invitation() {
            return "harnessy://pair#" + Protocol.encodeBase64Url(StrictJson.stringify(Protocol.object("v", 1,
                "httpsOrigin", pair.origin, "pcId", pair.pcId, "pcIdentityKey", pair.pcKey,
                "invitationId", "invitation-id", "expiresAt", clock + 60000, "secret", Protocol.randomId(32))).getBytes(StandardCharsets.UTF_8));
        }
        public void companion(Screen screen) { this.screen = screen; }
        public void pairing(Pairing pairing) { this.pairing = pairing; }
        public void main(Runnable callback) { main.addLast(callback); }
        public void io(Runnable operation) { io.addLast(operation); }
        public long now() { return clock; }
        public long elapsed() { return clock; }
        public Cancellable later(int milliseconds, Runnable callback) {
            Timer timer = new Timer(clock + milliseconds, callback); timers.add(timer); return () -> timer.cancelled = true;
        }
        public List<Paired> pairings() { return new ArrayList<>(saved); }
        public Identity identity(String alias) throws GeneralSecurityException {
            if (missingKey) throw new GeneralSecurityException("Missing external key");
            return new Identity(alias, phone.spki, phone.fingerprint);
        }
        public Identity createIdentity() {
            String alias = "new-alias-" + createdKeys.size(); createdKeys.add(alias); return new Identity(alias, phone.spki, phone.fingerprint);
        }
        public void deleteIdentity(String alias) { deletedKeys.add(alias); }
        public byte[] sign(String alias, byte[] transcript) { throw new AssertionError("Fake network must not invoke a real handshake"); }
        public void save(Paired paired) throws IOException {
            saved.removeIf(previous -> previous.pcId.equals(paired.pcId)); saved.add(paired);
            if (failSave) throw new IOException("Commit failed after changing preference memory");
        }
        public void forget(String pcId) throws IOException {
            if (failForget) throw new IOException("Removal commit failed");
            saved.removeIf(previous -> previous.pcId.equals(pcId));
        }
        public List<Fence> fences() { return new ArrayList<>(fences.values()); }
        public void putFence(Fence fence) throws IOException {
            fences.put(fence.pcId, fence); if (failPut) throw new IOException("Fence commit failed");
        }
        public void clearFence(String pcId) throws IOException {
            fences.remove(pcId); if (failClear) throw new IOException("Clear failed after memory changed");
        }
        public void repair(String pcId, String alias) { repairs.put(pcId, new Repair(pcId, alias)); }
        public void clearRepair(String pcId) { repairs.remove(pcId); }
        public List<Repair> repairs() { return new ArrayList<>(repairs.values()); }
        public Link connect(Protocol.Inputs inputs, Events events) {
            FakeLink link = new FakeLink(inputs, events); links.add(link); return link;
        }
    }

    private static final class Timer {
        final long at;
        final Runnable callback;
        boolean cancelled;
        Timer(long at, Runnable callback) { this.at = at; this.callback = callback; }
    }
    private static final class FakeLink implements Link {
        final Protocol.Inputs inputs;
        final Events events;
        final List<Map<String, Object>> requests = new ArrayList<>();
        final CompletableFuture<Void> quiet = new CompletableFuture<>();
        boolean closed;
        boolean autoQuiet = true;
        FakeLink(Protocol.Inputs inputs, Events events) { this.inputs = inputs; this.events = events; }
        public boolean start() { return !closed; }
        public PhoneTransport.Admission send(byte[] bytes) {
            if (closed) return PhoneTransport.Admission.CLOSED;
            requests.add(ApplicationCodec.parseRequest(bytes)); return PhoneTransport.Admission.ADMITTED_MAY_WRITE;
        }
        public void close() { closed = true; inputs.authorization.close(); if (autoQuiet) quiet.complete(null); }
        public java.util.concurrent.CompletionStage<Void> quiescence() { return quiet; }
        Map<String, Object> last(String type) {
            for (int index = requests.size() - 1; index >= 0; index--) if (type.equals(requests.get(index).get("type"))) return requests.get(index);
            return null;
        }
        void result(Object response) { events.application(StrictJson.stringify(response).getBytes(StandardCharsets.UTF_8)); }
    }
}
