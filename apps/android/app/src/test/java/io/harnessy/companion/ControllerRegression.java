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
        closedSelectionReadsApprovedHistoryWithoutWatchingOrSending();
        closedRefreshAndReconnectNeverSubscribeOrRenew();
        laterPageResumptionRetiresClosedHistoryAndWaitsForWatchAcknowledgement();
        laterPageResumptionPreservesPendingClosedWatchCancellation();
        idleAndBusySelectionsKeepWatchBeforeHistoryAndLiveMerge();
        closedProgressBeforeOrAfterAcknowledgementStopsRenewal();
        closedWatchRetirementPreservesHistoryRecovery();
        bufferedClosureCannotBypassDeniedOrMissingWatchAcknowledgement();
        closedWatchCancellationRemainsCorrelatedAndFailClosed();
        explicitReadRecoveryRequiresMatchingHistoryAndFailureVersion();
        listingRecoveryWithoutSelectionClearsItsReadFailure();
        deniedWatchFallbackCannotClearFailureOrAuthorizeSend();
        readRecoveryPreservesSendStorageRepairAndFenceWarnings();
        staleHistoryCallbacksCannotReplaceSelectionOrRecoverFailures();
        uncertainWatchCancellationStillClosesTheConnection();
        ordinaryReadsOptInWhileHeartbeatStaysLegacyAndDenialNeverDowngrades();
        navigationSurvivesRefreshPagingAndReconnectWithoutInventingLegacyMetadata();
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
        check(oversized.screen.composer.feedback == Feedback.PAIRING_INVALID, "Loading-time imports count complete UTF-8 bytes, not characters");
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

    private static void closedSelectionReadsApprovedHistoryWithoutWatchingOrSending() throws Exception {
        Fixture fixture = new Fixture(); fixture.startWithSessions(Collections.singletonList(session("s1", "closed")));
        fixture.controller.selectSession("s1");
        check(fixture.latest().last("readHistory") != null && fixture.latest().last("watchProgress") == null,
            "Closed Add Mobile and Tablet Previews selection reads history without a rejected live watch");
        String markdown = "# Preview\n\n`native`";
        fixture.historyPage(Collections.singletonList(row(1, "r1", markdown)), "cGFnZQ");
        fixture.controller.loadMoreHistory();
        check("cGFnZQ".equals(fixture.latest().last("readHistory").get("cursor")), "Closed history preserves opaque paging");
        fixture.latest().result(error(fixture.latest().last("readHistory"), "unavailable"));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "A genuine closed-history read failure still reports failure");
        fixture.controller.loadMoreHistory();
        fixture.historyPage(Collections.singletonList(row(2, "r2", "approved")), null);
        fixture.controller.draftChanged("blocked"); fixture.controller.sendText("blocked"); fixture.pump();
        check(fixture.screen.conversation.rows.size() == 2 && fixture.screen.conversation.rows.get(0).text.equals(markdown)
            && fixture.screen.composer.feedback == Feedback.NONE, "Approved Markdown is retained without a refresh-failure banner");
        check(fixture.screen.conversation.session.status == SessionStatus.CLOSED && fixture.screen.composer.state == SendState.CLOSED
            && fixture.latest().last("submitText") == null && fixture.fences.isEmpty(), "Closed history never authorizes a mutation");
    }

    private static void closedRefreshAndReconnectNeverSubscribeOrRenew() throws Exception {
        Fixture fixture = new Fixture(); fixture.closedReady();
        fixture.controller.refresh();
        fixture.sessions(Collections.singletonList(session("newer", "idle")), "cGFnZQ");
        fixture.historyPage(Collections.singletonList(row(1, "retained", "history")), null);
        check(fixture.screen.conversation.session.id.equals("s1"), "Incomplete refreshed listings retain an older closed selection");
        fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        for (int heartbeat = 0; heartbeat < 3; heartbeat++) {
            fixture.advance(20000); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        }
        check(fixture.latest().last("watchProgress") == null && fixture.latest().last("cancelRead") == null
            && fixture.screen.pc.connection == Connection.ONLINE, "Closed sessions have neither watches nor renewals while heartbeats remain live");
        fixture.latest().events.disconnected(); fixture.advance(5000); fixture.confirm();
        fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        check(fixture.latest().last("readHistory") != null && fixture.latest().last("watchProgress") == null,
            "Reconnect refreshes closed history directly");
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.conversation.rows.size() == 1 && fixture.screen.composer.state == SendState.CLOSED
            && fixture.screen.composer.feedback == Feedback.NONE, "Reconnect preserves closed text and no-send state without false failure");
    }

    private static void laterPageResumptionRetiresClosedHistoryAndWaitsForWatchAcknowledgement() throws Exception {
        for (boolean completed : new boolean[] { false, true }) {
            Fixture fixture = new Fixture(); fixture.controller.start(); fixture.pump(); fixture.confirm();
            fixture.sessions(Collections.singletonList(session("newer", "idle")), "cGFnZQ");
            fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(navigationSession("s1", "closed", 42)), null);
            fixture.controller.selectSession("s1"); fixture.historyPage(Collections.singletonList(row(1, "retained", "approved")), null);
            fixture.latest().events.disconnected(); fixture.advance(5000); fixture.confirm();
            fixture.sessions(Collections.singletonList(session("newer", "idle")), "cGFnZQ");
            Map<String, Object> oldHistory = fixture.latest().last("readHistory");
            check(oldHistory != null && fixture.latest().last("watchProgress") == null
                && fixture.screen.conversation.session.navigation.updatedAt == 42,
                "Reconnect first-page retention reads the older closed selection without inventing new metadata");
            if (completed) fixture.historyPage(Collections.emptyList(), "aGlzdG9yeQ");
            fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(navigationSession("s1", "running", 84)), null);
            Map<String, Object> watch = fixture.latest().last("watchProgress");
            SessionNavigation navigation = fixture.screen.conversation.session.navigation;
            check(watch != null && fixture.latest().last("readHistory") == oldHistory && !fixture.screen.conversation.canLoadMore
                && fixture.screen.conversation.session.status == SessionStatus.BUSY && navigation.updatedAt == 84,
                "A later-page resumption establishes a watch and suspends closed-history paging until its acknowledgement");
            fixture.controller.selectSession("s1"); fixture.controller.loadMoreHistory();
            fixture.latest().result(history(oldHistory.get("requestId"), "s1", Collections.singletonList(row(2, "stale", "ignored")), "aGlzdG9yeQ"));
            fixture.latest().result(error(oldHistory, "unavailable"));
            fixture.controller.loadMoreHistory(); fixture.controller.sendText("blocked"); fixture.pump();
            check(fixture.latest().last("watchProgress") == watch && fixture.latest().last("readHistory") == oldHistory
                && fixture.screen.conversation.rows.size() == 1 && fixture.screen.composer.feedback == Feedback.NONE
                && fixture.screen.composer.state == SendState.OFFLINE && fixture.latest().last("submitText") == null && fixture.fences.isEmpty(),
                "Reselecting and stale closed-history callbacks cannot bypass the watch cut, recover paging or authorize sends");
            String subscription = Protocol.randomId(16);
            fixture.latest().result(Protocol.object("v", 1, "type", "watching", "requestId", watch.get("requestId"),
                "sessionId", "s1", "subscriptionId", subscription));
            Map<String, Object> baseline = fixture.latest().last("readHistory");
            check(baseline != oldHistory && !baseline.containsKey("cursor") && fixture.screen.composer.state == SendState.OFFLINE,
                "WATCHING acknowledgement precedes a fresh cursorless baseline and alone grants no send authority");
            fixture.latest().result(history(oldHistory.get("requestId"), "s1", Collections.singletonList(row(2, "stale", "ignored")), null));
            fixture.historyPage(Collections.singletonList(row(2, "between-cuts", "approved")), null);
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", Protocol.randomId(16),
                "sessionId", "s1", "rows", Collections.emptyList(), "status", "idle"));
            fixture.controller.sendText("still blocked"); fixture.pump();
            check(fixture.screen.conversation.rows.size() == 2 && fixture.screen.conversation.rows.get(1).id.equals("between-cuts")
                && fixture.screen.composer.state == SendState.OFFLINE && fixture.latest().last("submitText") == null && fixture.fences.isEmpty(),
                "Fresh history covers the interval between closed history and the watch; unrelated progress cannot authorize sends");
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", "s1", "rows", Collections.emptyList(), "status", "running"));
            check(fixture.screen.composer.state == SendState.READY && fixture.screen.conversation.session.navigation == navigation
                && fixture.screen.sessions.rows.stream().anyMatch(session -> session.id.equals("s1") && session.navigation == navigation)
                && navigation.workspace.id.equals("workspace._:-1")
                && navigation.workspace.title.equals("工作 🧭") && navigation.workspace.order == 7 && navigation.pinOrder == 0L,
                "Only exact live progress restores readiness while preserving later-page workspace, pin and activity metadata");
            for (int heartbeat = 0; heartbeat < 3; heartbeat++) {
                fixture.advance(20000); fixture.sessions(Collections.singletonList(session("s1", "running")), null);
            }
            Map<String, Object> cancel = fixture.latest().last("cancelRead");
            check(fixture.latest().last("watchProgress") != watch && fixture.latest().last("readHistory") == baseline
                && subscription.equals(cancel.get("subscriptionId")), "The resumed watch renews through cancellation and ACK-before-history");
            fixture.latest().result(Protocol.object("v", 1, "type", "cancelled", "requestId", cancel.get("requestId"),
                "subscriptionId", subscription));
            fixture.watching(); fixture.historyPage(Collections.emptyList(), null);
            check(fixture.screen.pc.connection == Connection.ONLINE && fixture.screen.conversation.session.navigation == navigation,
                "Renewal and legacy heartbeats preserve resumed navigation without reviving retired history deadlines");
        }
    }

    private static void laterPageResumptionPreservesPendingClosedWatchCancellation() throws Exception {
        for (String outcome : new String[] { "denied", "timeout", "wrongSubscription", "lateAck" }) {
            Fixture fixture = new Fixture(); fixture.ready();
            Map<String, Object> retiredWatch = fixture.latest().last("watchProgress");
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", fixture.subscription,
                "sessionId", "s1", "rows", Collections.emptyList(), "status", "closed"));
            Map<String, Object> cancel = fixture.latest().last("cancelRead");
            fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("newer", "idle")), "cGFnZQ");
            Map<String, Object> closedHistory = fixture.latest().last("readHistory");
            fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(navigationSession("s1", "running", 84)), null);
            Map<String, Object> watch = fixture.latest().last("watchProgress");
            check(watch != retiredWatch && fixture.latest().last("readHistory") == closedHistory
                && fixture.latest().last("cancelRead") == cancel, "Reopening retires only closed history, not independent cancellation");
            fixture.watching(); Map<String, Object> baseline = fixture.latest().last("readHistory");
            fixture.historyPage(Collections.emptyList(), null);
            fixture.latest().result(error(retiredWatch, "expired"));
            fixture.latest().result(Protocol.object("v", 1, "type", "watching", "requestId", retiredWatch.get("requestId"),
                "sessionId", "s1", "subscriptionId", cancel.get("subscriptionId")));
            check(fixture.screen.composer.state == SendState.READY && fixture.latest().last("readHistory") == baseline,
                "Retired watch expiry and late watch acknowledgement cannot disturb the replacement watch");
            if (outcome.equals("denied")) fixture.latest().result(error(cancel, "denied"));
            else {
                if (outcome.equals("wrongSubscription")) fixture.latest().result(Protocol.object("v", 1, "type", "cancelled",
                    "requestId", cancel.get("requestId"), "subscriptionId", Protocol.randomId(16)));
                if (outcome.equals("lateAck")) {
                    fixture.advance(9999);
                    fixture.latest().result(Protocol.object("v", 1, "type", "cancelled", "requestId", cancel.get("requestId"),
                        "subscriptionId", cancel.get("subscriptionId")));
                    fixture.advance(1);
                    check(!fixture.latest().closed && fixture.screen.composer.state == SendState.READY,
                        "An exact late cancellation acknowledgement retires its deadline without touching the new watch");
                    continue;
                }
                fixture.advance(10000);
            }
            check(fixture.latest().closed && fixture.screen.pc.connection == Connection.OFFLINE,
                "Resumption cannot discard a closed-watch cancellation denial, deadline or subscription correlation");
        }
    }

    private static void idleAndBusySelectionsKeepWatchBeforeHistoryAndLiveMerge() throws Exception {
        for (String status : new String[] { "idle", "running" }) {
            Fixture fixture = new Fixture(); fixture.startWithSessions(Collections.singletonList(navigationSession("s1", status, 42)));
            SessionNavigation navigation = fixture.screen.sessions.rows.get(0).navigation;
            fixture.controller.selectSession("s1");
            check(fixture.latest().last("watchProgress") != null && fixture.latest().last("readHistory") == null,
                "Active selections wait for the live cut acknowledgement");
            String subscription = Protocol.randomId(16);
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", Protocol.randomId(16),
                "sessionId", "s1", "rows", Collections.singletonList(row(1, "unrelated", "ignored")), "status", "closed"));
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", "s1", "rows", Collections.singletonList(row(2, "live", "live")), "status", status));
            Map<String, Object> watch = fixture.latest().last("watchProgress");
            fixture.latest().result(Protocol.object("v", 1, "type", "watching", "requestId", watch.get("requestId"),
                "sessionId", "s1", "subscriptionId", subscription));
            fixture.historyPage(Collections.singletonList(row(1, "baseline", "baseline")), null);
            check(fixture.screen.conversation.rows.size() == 2 && fixture.screen.conversation.rows.get(1).id.equals("live")
                && fixture.screen.composer.state == SendState.READY, "Idle and busy baselines merge buffered live rows without losing send authority");
            check(fixture.screen.conversation.session.status == (status.equals("idle") ? SessionStatus.IDLE : SessionStatus.BUSY)
                && fixture.latest().last("cancelRead") == null, "Unrelated buffered closure cannot retire the acknowledged active watch");
            check(fixture.screen.conversation.session.navigation == navigation
                && fixture.screen.sessions.rows.get(0).navigation == navigation, "Active progress preserves the immutable navigation in both projections");
        }
    }

    private static void closedProgressBeforeOrAfterAcknowledgementStopsRenewal() throws Exception {
        for (boolean beforeAck : new boolean[] { true, false }) {
            Fixture fixture = new Fixture(); fixture.startWithSessions(Collections.singletonList(navigationSession("s1", "running", 42)));
            SessionNavigation navigation = fixture.screen.sessions.rows.get(0).navigation;
            fixture.controller.selectSession("s1"); Map<String, Object> watch = fixture.latest().last("watchProgress");
            String subscription = Protocol.randomId(16);
            Map<String, Object> closed = Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", "s1", "rows", Collections.singletonList(row(1, "final", "done")), "status", "closed");
            Map<String, Object> late = Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", "s1", "rows", Collections.singletonList(row(3, "late", "ignored")), "status", "running");
            if (beforeAck) {
                fixture.latest().result(closed); fixture.latest().result(late);
                check(fixture.latest().last("cancelRead") == null && fixture.latest().last("readHistory") == null
                    && fixture.screen.composer.state == SendState.OFFLINE, "Buffered closure cannot retire an unacknowledged subscription");
            }
            fixture.latest().result(Protocol.object("v", 1, "type", "watching", "requestId", watch.get("requestId"),
                "sessionId", "s1", "subscriptionId", subscription));
            if (!beforeAck) fixture.latest().result(closed);
            Map<String, Object> baseline = fixture.latest().last("readHistory");
            Map<String, Object> cancel = fixture.latest().last("cancelRead");
            check(cancel != null && subscription.equals(cancel.get("subscriptionId")), "Closure cancels exactly the acknowledged subscription");
            fixture.latest().result(error(watch, "expired")); fixture.latest().result(late);
            check(fixture.latest().last("readHistory").get("requestId").equals(baseline.get("requestId"))
                && fixture.screen.composer.feedback == Feedback.NONE && fixture.screen.composer.state == SendState.CLOSED,
                "Late closed-watch expiry and progress cannot cancel pending history, revive send authority or create a failure");
            fixture.latest().result(Protocol.object("v", 1, "type", "cancelled", "requestId", cancel.get("requestId"),
                "subscriptionId", subscription));
            fixture.historyPage(Collections.emptyList(), "cGFnZQ");
            fixture.controller.loadMoreHistory(); Map<String, Object> page = fixture.latest().last("readHistory");
            check("cGFnZQ".equals(page.get("cursor")), "Closed-watch retirement retains independent history paging");
            fixture.latest().result(error(watch, "expired")); fixture.latest().result(closed); fixture.latest().result(late);
            fixture.historyPage(Collections.singletonList(row(2, "history", "approved")), null);
            fixture.controller.draftChanged("blocked"); fixture.controller.sendText("blocked"); fixture.pump();
            for (int heartbeat = 0; heartbeat < 3; heartbeat++) {
                fixture.advance(20000); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
            }
            check(fixture.latest().last("watchProgress").get("requestId").equals(watch.get("requestId"))
                && fixture.latest().last("readHistory").get("requestId").equals(page.get("requestId"))
                && fixture.latest().last("cancelRead").get("requestId").equals(cancel.get("requestId"))
                && fixture.screen.pc.connection == Connection.ONLINE && fixture.screen.composer.feedback == Feedback.NONE,
                "Closing progress retires only its watch without retrying or replacing independently paged history");
            check(fixture.screen.composer.state == SendState.CLOSED && fixture.screen.conversation.rows.size() == 2
                && fixture.screen.conversation.rows.get(0).id.equals("final") && fixture.screen.conversation.rows.get(1).id.equals("history")
                && fixture.latest().last("submitText") == null && fixture.fences.isEmpty(),
                "Closing progress retains final and paged text without sending or persisting a fence");
            check(fixture.screen.conversation.session.navigation == navigation
                && fixture.screen.sessions.rows.get(0).navigation == navigation,
                "Buffered/direct closure and legacy heartbeat cannot erase workspace, pin or activity metadata");
        }
    }

    private static void closedWatchRetirementPreservesHistoryRecovery() throws Exception {
        Fixture fixture = new Fixture(); fixture.closedReady(); fixture.controller.refresh();
        fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        fixture.latest().result(error(fixture.latest().last("readHistory"), "unavailable"));
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "running")), "cGFnZQ"); fixture.watching();
        fixture.controller.loadMoreSessions();
        Map<String, Object> watch = fixture.latest().last("watchProgress"), baseline = fixture.latest().last("readHistory");
        fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", fixture.subscription,
            "sessionId", "s1", "rows", Collections.emptyList(), "status", "closed"));
        fixture.latest().result(error(watch, "expired"));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED
            && fixture.latest().last("readHistory").get("requestId").equals(baseline.get("requestId")),
            "Closure retains the pending recovery without prematurely clearing its genuine failure");
        fixture.historyPage(Collections.singletonList(row(1, "recovered", "approved")), null);
        fixture.latest().result(error(watch, "expired"));
        check(fixture.screen.composer.feedback == Feedback.NONE && fixture.screen.composer.state == SendState.CLOSED
            && fixture.screen.conversation.rows.get(0).id.equals("recovered"),
            "The original history recovery metadata still clears its failure and retired expiry cannot restore it");
        fixture.sessions(java.util.Arrays.asList(session("s1", "running"), session("s2", "closed")), null);
        fixture.controller.sendText("blocked"); fixture.pump();
        check(fixture.screen.sessions.rows.size() == 2 && fixture.screen.conversation.rows.get(0).id.equals("recovered")
            && fixture.screen.composer.state == SendState.OFFLINE && fixture.latest().last("submitText") == null
            && fixture.latest().last("watchProgress").get("requestId").equals(watch.get("requestId")) && fixture.fences.isEmpty(),
            "A pending listing retains its metadata but stale active visibility cannot restore retired send authority");
    }

    private static void bufferedClosureCannotBypassDeniedOrMissingWatchAcknowledgement() throws Exception {
        for (boolean denied : new boolean[] { true, false }) {
            Fixture fixture = new Fixture(); fixture.startWithSessions(Collections.singletonList(session("s1", "running")));
            fixture.controller.selectSession("s1");
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", Protocol.randomId(16),
                "sessionId", "s1", "rows", Collections.singletonList(row(1, "unconfirmed", "ignored")), "status", "closed"));
            if (denied) {
                fixture.latest().result(error(fixture.latest().last("watchProgress"), "denied"));
                fixture.historyPage(Collections.emptyList(), null);
                check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED && fixture.screen.composer.state == SendState.OFFLINE,
                    "Buffered closure cannot suppress a watch denial or make fallback history authorize sends");
            } else {
                fixture.advance(10000);
                check(fixture.latest().closed && fixture.screen.pc.connection == Connection.OFFLINE,
                    "Buffered closure cannot suppress the unacknowledged watch deadline");
            }
            check(fixture.latest().last("cancelRead") == null && fixture.screen.conversation.rows.isEmpty()
                && fixture.screen.conversation.session.status == SessionStatus.BUSY,
                "An unacknowledged closure grants neither a subscription to cancel nor approved status or text");
        }
    }

    private static void closedWatchCancellationRemainsCorrelatedAndFailClosed() throws Exception {
        for (String outcome : new String[] { "denied", "timeout", "wrongSubscription" }) {
            Fixture fixture = new Fixture(); fixture.ready();
            fixture.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", fixture.subscription,
                "sessionId", "s1", "rows", Collections.emptyList(), "status", "closed"));
            Map<String, Object> cancel = fixture.latest().last("cancelRead");
            if (outcome.equals("denied")) fixture.latest().result(error(cancel, "denied"));
            else {
                if (outcome.equals("wrongSubscription")) {
                    fixture.latest().result(Protocol.object("v", 1, "type", "cancelled", "requestId", cancel.get("requestId"),
                        "subscriptionId", Protocol.randomId(16)));
                }
                fixture.advance(10000);
            }
            check(fixture.latest().closed && fixture.screen.pc.connection == Connection.OFFLINE,
                "Closed-watch cancellation denial, timeout and mismatched acknowledgement retain fail-closed transport retirement");
        }
    }

    private static void explicitReadRecoveryRequiresMatchingHistoryAndFailureVersion() throws Exception {
        Fixture fixture = new Fixture(); fixture.closedReady(); fixture.controller.refresh();
        fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        fixture.latest().result(error(fixture.latest().last("readHistory"), "unavailable"));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "Failed closed history reports refresh failure");
        fixture.advance(19999);
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        Map<String, Object> recovery = fixture.latest().last("readHistory");
        fixture.advance(1); Map<String, Object> heartbeat = fixture.latest().last("listSessions");
        fixture.latest().result(history(Protocol.randomId(16), "s1", Collections.emptyList(), null));
        fixture.latest().result(history(recovery.get("requestId"), "other", Collections.emptyList(), null));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "Listing success and uncorrelated history cannot clear a selected-history failure");
        fixture.latest().result(error(heartbeat, "unavailable"));
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "A recovery started before a newer read failure cannot clear it");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.composer.feedback == Feedback.NONE, "Matching explicit history recovery clears only the current read failure");
        fixture.controller.refresh(); fixture.latest().result(error(fixture.latest().last("listSessions"), "unavailable"));
        fixture.advance(20000); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "Successful automatic heartbeat is not explicit recovery");
    }

    private static void listingRecoveryWithoutSelectionClearsItsReadFailure() throws Exception {
        Fixture fixture = new Fixture(); fixture.controller.start(); fixture.pump(); fixture.confirm();
        fixture.latest().result(error(fixture.latest().last("listSessions"), "unavailable"));
        check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED, "A failed listing without a selection reports read failure");
        fixture.controller.refresh(); fixture.sessions(Collections.emptyList(), null);
        check(fixture.screen.composer.feedback == Feedback.NONE && fixture.screen.composer.state == SendState.NO_SELECTION,
            "An explicitly recovered listing needs no history when nothing is selected");
    }

    private static void deniedWatchFallbackCannotClearFailureOrAuthorizeSend() throws Exception {
        for (boolean acknowledged : new boolean[] { false, true }) {
            Fixture fixture = new Fixture();
            if (acknowledged) fixture.ready();
            else {
                fixture.startWithSessions(Collections.singletonList(session("s1", "running")));
                fixture.controller.selectSession("s1");
            }
            fixture.latest().result(error(fixture.latest().last("watchProgress"), "denied"));
            fixture.historyPage(Collections.singletonList(row(1, "approved", "history")), null);
            check(fixture.screen.composer.feedback == Feedback.REFRESH_FAILED && fixture.screen.composer.state == SendState.OFFLINE,
                "Approved fallback text neither clears a denied watch nor grants active send authority");
            fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "running")), null);
            fixture.controller.sendText("blocked"); fixture.pump();
            check(fixture.latest().last("submitText") == null && fixture.screen.composer.state == SendState.OFFLINE,
                "Fresh list visibility alone cannot authorize an active session after a denied watch");
            fixture.watching(); fixture.historyPage(Collections.emptyList(), null);
            check(fixture.screen.composer.feedback == Feedback.NONE && fixture.screen.composer.state == SendState.READY,
                "An explicitly refreshed authorized watch and history recover the active path");
        }
    }

    private static void readRecoveryPreservesSendStorageRepairAndFenceWarnings() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready();
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "running")), null); fixture.watching();
        fixture.controller.sendText(""); fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.composer.feedback == Feedback.SEND_FAILED, "Read success cannot clear a send failure");
        fixture.controller.refresh(); fixture.latest().result(error(fixture.latest().last("listSessions"), "unavailable"));
        check(fixture.screen.composer.feedback == Feedback.SEND_FAILED, "A read failure cannot replace an independent send warning");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "running")), null); fixture.watching();
        fixture.controller.sendText("uncertain"); fixture.pump();
        fixture.latest().result(error(fixture.latest().last("submitText"), "unavailable"));
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.composer.feedback == Feedback.DELIVERY_UNKNOWN && fixture.screen.composer.state == SendState.DELIVERY_UNKNOWN
            && fixture.fences.size() == 1, "History success cannot clear an uncertain delivery fence");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "running")), null); fixture.watching();
        Map<String, Object> pending = fixture.latest().last("readHistory");
        fixture.failForget = true; fixture.controller.forgetPairing(fixture.pair.pcId); fixture.pump();
        fixture.latest().result(history(pending.get("requestId"), "s1", Collections.emptyList(), null));
        check(fixture.screen.composer.feedback == Feedback.FORGET_FAILED && fixture.screen.pc.connection == Connection.OFFLINE,
            "Retired read success cannot clear a failed storage commit");
        fixture.controller.resolveUnknown(); fixture.pump();
        fixture.latest().result(history(pending.get("requestId"), "s1", Collections.emptyList(), null));
        check(fixture.screen.composer.feedback == Feedback.REPAIR_REQUIRED && !fixture.repairs.isEmpty(),
            "Read recovery cannot clear the independent pairing repair after delivery review");
    }

    private static void staleHistoryCallbacksCannotReplaceSelectionOrRecoverFailures() throws Exception {
        Fixture fixture = new Fixture(); List<?> closed = java.util.Arrays.asList(session("s1", "closed"), session("s2", "closed"));
        fixture.startWithSessions(closed); fixture.controller.selectSession("s1");
        Map<String, Object> first = fixture.latest().last("readHistory"); fixture.controller.selectSession("s2");
        fixture.latest().result(error(fixture.latest().last("readHistory"), "unavailable"));
        fixture.controller.selectSession("s1");
        fixture.latest().result(history(first.get("requestId"), "s1", Collections.singletonList(row(1, "stale", "stale")), null));
        check(fixture.screen.conversation.rows.isEmpty() && fixture.screen.composer.feedback == Feedback.REFRESH_FAILED,
            "Returning to the same selection cannot revive a retired request or clear its newer failure");
        FakeLink old = fixture.latest(); old.events.disconnected(); fixture.advance(5000); fixture.confirm(); fixture.sessions(closed, null);
        Map<String, Object> current = fixture.latest().last("readHistory");
        old.result(history(current.get("requestId"), "s1", Collections.singletonList(row(1, "old-attempt", "stale")), null));
        check(fixture.screen.conversation.rows.isEmpty(), "Retired attempt callbacks cannot satisfy a current request");
        FakeLink second = fixture.latest(); fixture.controller.stop(); fixture.controller.start(); fixture.pump(); fixture.advance(5000);
        fixture.confirm(); fixture.sessions(closed, null); current = fixture.latest().last("readHistory");
        second.result(history(current.get("requestId"), "s1", Collections.singletonList(row(1, "old-epoch", "stale")), null));
        fixture.historyPage(Collections.singletonList(row(1, "current", "approved")), null);
        check(fixture.screen.conversation.rows.size() == 1 && fixture.screen.conversation.rows.get(0).id.equals("current")
            && fixture.screen.composer.state == SendState.CLOSED, "Only the current foreground epoch can restore selected closed history");
    }

    private static void uncertainWatchCancellationStillClosesTheConnection() throws Exception {
        Fixture fixture = new Fixture(); fixture.ready(); fixture.controller.refresh();
        Map<String, Object> cancel = fixture.latest().last("cancelRead");
        fixture.latest().result(error(cancel, "unavailable"));
        check(fixture.latest().closed && fixture.screen.pc.connection == Connection.OFFLINE,
            "Uncertain cancellation closes transport instead of leaking a remote subscription");
        Fixture awaiting = new Fixture(); awaiting.startWithSessions(java.util.Arrays.asList(session("s1", "running"), session("s2", "closed")));
        awaiting.controller.selectSession("s1"); awaiting.controller.selectSession("s2");
        check(awaiting.latest().closed && awaiting.latest().last("readHistory") == null,
            "Changing selection before a watch acknowledgement retires the uncertain connection");
    }

    private static void ordinaryReadsOptInWhileHeartbeatStaysLegacyAndDenialNeverDowngrades() throws Exception {
        Fixture fixture = new Fixture(); fixture.controller.start(); fixture.pump(); fixture.confirm();
        Map<String, Object> baseline = fixture.latest().last("listSessions");
        check("navigation".equals(baseline.get("view")), "Ordinary baseline opts into navigation on the existing listSessions verb");
        fixture.sessions(Collections.singletonList(session("s1", "closed")), "cGFnZQ");
        fixture.controller.loadMoreSessions(); Map<String, Object> page = fixture.latest().last("listSessions");
        check("navigation".equals(page.get("view")) && "cGFnZQ".equals(page.get("cursor"))
            && !page.get("requestId").equals(baseline.get("requestId")), "Navigation paging retains opaque cursors and fresh correlations");
        fixture.sessions(Collections.emptyList(), null);
        fixture.controller.selectSession("s1"); fixture.historyPage(Collections.emptyList(), null);
        fixture.advance(20000); Map<String, Object> heartbeat = fixture.latest().last("listSessions");
        check(!heartbeat.containsKey("view") && !heartbeat.containsKey("cursor")
            && Protocol.integer(heartbeat.get("limit"), 1, 128) == 1, "Heartbeat stays an exact legacy bounded read");
        fixture.sessions(Collections.singletonList(navigationSession("s1", "running", 99)), null);
        check(fixture.screen.conversation.session.navigation == null && fixture.screen.composer.state == SendState.CLOSED,
            "A heartbeat result neither upgrades legacy rows nor changes selection authority");
        fixture.controller.refresh(); Map<String, Object> refresh = fixture.latest().last("listSessions");
        check("navigation".equals(refresh.get("view")), "Explicit refresh uses navigation, not the heartbeat encoder");
        int sent = fixture.latest().requests.size();
        fixture.latest().result(error(refresh, "unavailable")); fixture.pump();
        check(fixture.latest().requests.size() == sent && fixture.screen.composer.feedback == Feedback.REFRESH_FAILED,
            "Rejected navigation reads do not probe or fall back to legacy requests");
    }

    private static void navigationSurvivesRefreshPagingAndReconnectWithoutInventingLegacyMetadata() throws Exception {
        Fixture fixture = new Fixture(); fixture.startWithSessions(java.util.Arrays.asList(
            navigationSession("s1", "closed", 42), session("legacy", "closed")));
        check(fixture.screen.sessions.rows.get(1).navigation == null, "Legacy rows have no invented workspace, pins or timestamps");
        fixture.controller.selectSession("s1"); fixture.historyPage(Collections.emptyList(), null);
        SessionNavigation original = fixture.screen.conversation.session.navigation;
        check(original.updatedAt == 42 && original.pinOrder == 0L && original.workspace.order == 7
            && original.workspace.id.equals("workspace._:-1") && original.workspace.title.equals("工作 🧭"),
            "Approved navigation fields project without interpreting workspace IDs");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("newer", "closed")), "cGFnZQ");
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.conversation.session.navigation == original, "An incomplete refresh retains selected navigation alongside its row");
        fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(navigationSession("s1", "closed", 84)), null);
        SessionNavigation refreshed = fixture.screen.conversation.session.navigation;
        check(refreshed.updatedAt == 84 && fixture.screen.sessions.rows.size() == 2,
            "A same-epoch page replaces navigation from the authoritative row without retaining removed rows");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("s1", "closed")), null);
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.conversation.session.navigation == refreshed, "Legacy row replacements preserve previously supplied navigation");
        FakeLink retired = fixture.latest(); retired.events.disconnected();
        check(fixture.screen.conversation.session.navigation == refreshed && fixture.screen.composer.state == SendState.OFFLINE,
            "Disconnect retains memory-only navigation without retaining send authority");
        fixture.advance(5000); fixture.confirm();
        Map<String, Object> current = fixture.latest().last("listSessions");
        check("navigation".equals(current.get("view")), "Reconnect baseline opts into navigation");
        retired.result(Protocol.object("v", 1, "type", "sessions", "requestId", current.get("requestId"),
            "sessions", Collections.singletonList(navigationSession("s1", "running", 999))));
        check(fixture.screen.conversation.session.navigation == refreshed, "A retired callback cannot replace current-attempt navigation");
        fixture.sessions(Collections.singletonList(session("newer", "closed")), "cGFnZQ");
        fixture.historyPage(Collections.emptyList(), null);
        check(fixture.screen.conversation.session.navigation == refreshed, "Reconnect first-page retention keeps older selected metadata");
        fixture.controller.loadMoreSessions(); fixture.sessions(Collections.singletonList(navigationSession("s1", "closed", 126)), null);
        check(fixture.screen.conversation.session.navigation.updatedAt == 126 && fixture.screen.composer.state == SendState.CLOSED
            && fixture.latest().last("watchProgress") == null && fixture.fences.isEmpty(),
            "Reconnect paging updates navigation while closed history stays read-only and unpersisted");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(Protocol.object("sessionId", "s1", "title", "s1",
            "status", "closed", "navigation", Protocol.object("updatedAt", 0, "pinOrder", null, "workspace", null))), null);
        fixture.historyPage(Collections.emptyList(), null);
        SessionNavigation unassigned = fixture.screen.conversation.session.navigation;
        check(unassigned.updatedAt == 0 && unassigned.pinOrder == null && unassigned.workspace == null,
            "Explicit null workspace and pin replace old metadata without inventing a group or rank");
        fixture.controller.refresh(); fixture.sessions(Collections.singletonList(session("newer", "closed")), null);
        check(fixture.screen.conversation.session == null && fixture.screen.sessions.rows.size() == 1
            && fixture.screen.sessions.rows.get(0).navigation == null, "Completed removal discards the actual row and its navigation");
    }

    private static Map<String, Object> navigationSession(String id, String status, long updatedAt) {
        return Protocol.object("sessionId", id, "title", id, "status", status, "navigation",
            Protocol.object("updatedAt", updatedAt, "pinOrder", 0, "workspace",
                Protocol.object("id", "workspace._:-1", "title", "工作 🧭", "order", 7)));
    }

    private static Map<String, Object> error(Map<String, Object> request, String code) {
        return Protocol.object("v", 1, "type", "error", "requestId", request.get("requestId"), "code", code);
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

    static final class Fixture implements CompanionPlatform, CompanionController.Output {
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
        void startWithSessions(List<?> rows) {
            controller.start(); pump(); confirm(); sessions(rows, null);
        }
        void closedReady() {
            startWithSessions(Collections.singletonList(session("s1", "closed")));
            controller.selectSession("s1"); historyPage(Collections.emptyList(), null);
        }
        void sessions(List<?> rows, String cursor) {
            Map<String, Object> response = new LinkedHashMap<>(Protocol.object("v", 1, "type", "sessions",
                "requestId", latest().last("listSessions").get("requestId"), "sessions", rows));
            if (cursor != null) response.put("cursor", cursor);
            latest().result(response);
        }
        void historyPage(List<?> rows, String cursor) {
            Map<String, Object> read = latest().last("readHistory");
            latest().result(ControllerRegression.history(read.get("requestId"), (String) read.get("sessionId"), rows, cursor));
        }
        void confirm() {
            latest().events.confirmed(pair.grantId, pair.generation, pair.pcKey);
            Map<String, Object> catalog = latest().last("listManagementWorkspaces");
            if (catalog != null) latest().result(Protocol.object("v", 1, "type", "managementWorkspaces",
                "requestId", catalog.get("requestId"), "enabled", false, "workspaces", Collections.emptyList()));
        }
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
            Fence stored = fences.get(fence.targetKey());
            if (stored != null && !stored.sameIdentity(fence)) throw new IOException("Unresolved operation");
            fences.put(fence.targetKey(), fence); if (failPut) throw new IOException("Fence commit failed");
        }
        public void clearFence(Fence expected) throws IOException {
            Fence stored = fences.get(expected.targetKey());
            if (stored != null && !stored.sameIdentity(expected)) throw new IOException("Fence identity mismatch");
            // A prior failed commit may already have removed the preference-memory entry.
            fences.remove(expected.targetKey()); if (failClear) throw new IOException("Clear failed after memory changed");
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
    static final class FakeLink implements Link {
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
