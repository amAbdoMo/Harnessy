package io.harnessy.companion;

import io.harnessy.companion.protocol.Protocol;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.*;
import static io.harnessy.companion.CompanionPlatform.*;
import static io.harnessy.companion.presentation.DisplayModels.*;

/** Real foreground controller and wire parser; only platform I/O, transport and time are faked. */
public final class ManagementControllerTest {
    private static final String WORKSPACE = "workspace._:-1";

    @Test public void confirmationStartsIndependentCatalogAndSessionReads() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture();
        f.controller.start(); f.pump();
        f.latest().events.confirmed(f.pair.grantId, f.pair.generation, f.pair.pcKey);
        Map<String, Object> sessions = f.latest().last("listSessions");
        Map<String, Object> catalog = f.latest().last("listManagementWorkspaces");
        assertNotNull(sessions); assertNotNull(catalog);
        assertNotEquals(sessions.get("requestId"), catalog.get("requestId"));
        assertTrue(f.screen.sessions.rows.isEmpty());
        assertEquals(ManagementAccess.CHECKING, f.screen.sessions.management.access);
        catalog(f, false, Collections.emptyList(), null);
        assertEquals(ManagementAccess.DISABLED, f.screen.sessions.management.access);
        assertTrue(f.screen.sessions.management.workspaces.isEmpty());
        assertFalse(f.screen.sessions.management.canLoadMore);
        f.sessions(Collections.singletonList(session("s1", "closed", "Original", 1)), null);
        f.controller.createSession(WORKSPACE); f.controller.renameSession("s1", "Denied");
        f.controller.setSessionPinned("s1", true); f.controller.archiveSession("s1"); f.pump();
        assertEquals(0, mutations(f.latest())); assertTrue(f.fences.isEmpty());
        assertEquals("Original", find(f, "s1").title);
    }

    @Test public void catalogPagingRequiresExactCorrelationAndDoesNotInventTargets() throws Exception {
        ControllerRegression.Fixture f = knownClosed();
        f.controller.refreshManagementWorkspaces();
        Map<String, Object> first = f.latest().last("listManagementWorkspaces");
        f.latest().result(Protocol.object("v", 1, "type", "managementWorkspaces", "requestId", Protocol.randomId(16),
            "enabled", true, "workspaces", Collections.singletonList(workspace("wrong", 9))));
        f.controller.createSession("wrong"); f.pump();
        assertNull(f.latest().last("createSession"));
        catalog(f, true, Collections.singletonList(workspace(WORKSPACE, 7)), "cGFnZQ");
        assertEquals(ManagementAccess.ENABLED, f.screen.sessions.management.access);
        assertEquals(WORKSPACE, f.screen.sessions.management.workspaces.get(0).id);
        assertTrue(f.screen.sessions.management.canLoadMore);
        f.controller.loadMoreManagementWorkspaces();
        Map<String, Object> next = f.latest().last("listManagementWorkspaces");
        assertEquals("cGFnZQ", next.get("cursor"));
        assertNotEquals(first.get("requestId"), next.get("requestId"));
        catalog(f, true, Collections.singletonList(workspace("second", 8)), null);
        f.controller.createSession("second"); f.pump();
        assertEquals("second", f.latest().last("createSession").get("workspaceId"));
    }

    @Test public void catalogWindowStopsPagingAtTheExistingControllerBudget() throws Exception {
        ControllerRegression.Fixture f = knownClosed();
        f.controller.refreshManagementWorkspaces();
        List<Object> rows = new ArrayList<>();
        for (int index = 0; index < 128; index++) rows.add(workspace("w" + index, index));
        catalog(f, true, rows, "cGFnZQ");
        assertEquals(128, f.screen.sessions.management.workspaces.size());
        assertFalse(f.screen.sessions.management.canLoadMore);
        int before = f.latest().requests.size();
        f.controller.loadMoreManagementWorkspaces();
        assertEquals(before, f.latest().requests.size());
    }

    @Test public void createCommitsGeneratedIdentityBeforeSendAndSelectsOnlyAfterConfirmedClear() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.createSession(WORKSPACE);
        assertNull(f.latest().last("createSession"));
        assertEquals(1, f.screen.sessions.rows.size());
        f.pump(); Map<String, Object> request = f.latest().last("createSession");
        assertNotNull(request);
        String operation = Protocol.parseId16(request.get("operationId"));
        String created = "mobile-" + operation;
        assertEquals(created, request.get("sessionId"));
        Fence fence = f.fences.values().iterator().next();
        assertEquals(OperationKind.CREATE_SESSION, fence.kind);
        assertEquals(operation, fence.operationId); assertEquals(created, fence.sessionId);
        f.latest().result(applied(request, session(created, "idle", "Created", 42)));
        assertNull(find(f, created)); assertNotNull(f.fences.values().iterator().next());
        f.io.removeFirst().run();
        assertTrue(f.fences.isEmpty()); assertNull(find(f, created));
        f.pump();
        assertEquals("Created", find(f, created).title);
        assertEquals(created, f.screen.sessions.selectedId);
        assertEquals(created, f.latest().last("watchProgress").get("sessionId"));
    }

    @Test public void createAcknowledgementPreservesLaterSelectionAndEditedDraft() throws Exception {
        for (boolean changedSelection : new boolean[] { true, false }) {
            ControllerRegression.Fixture f = new ControllerRegression.Fixture();
            f.startWithSessions(Arrays.asList(session("s1", "closed", "One", 1), session("s2", "closed", "Two", 2)));
            f.controller.selectSession("s1"); f.historyPage(Collections.emptyList(), null); enable(f);
            f.controller.createSession(WORKSPACE); f.pump();
            Map<String, Object> request = f.latest().last("createSession");
            if (changedSelection) {
                f.controller.selectSession("s2"); f.historyPage(Collections.emptyList(), null);
            } else f.controller.draftChanged("later draft");
            f.latest().result(applied(request, session((String) request.get("sessionId"), "idle", "Created", 3))); f.pump();
            assertEquals(changedSelection ? "s2" : "s1", f.screen.sessions.selectedId);
            assertEquals(changedSelection ? "" : "later draft", f.screen.composer.draft);
            assertNotNull(find(f, (String) request.get("sessionId"))); assertTrue(f.fences.isEmpty());
        }
    }

    @Test public void editingAndRestoringTheEmptyDraftStillRetiresCreateSelectionIntent() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.createSession(WORKSPACE); f.pump();
        Map<String, Object> request = f.latest().last("createSession");
        f.controller.draftChanged("temporary"); f.controller.draftChanged("");
        f.latest().result(applied(request, session((String) request.get("sessionId"), "idle", "Created", 3))); f.pump();
        assertNotNull(find(f, (String) request.get("sessionId")));
        assertNull(f.screen.sessions.selectedId);
        assertEquals("", f.screen.composer.draft);
    }

    @Test public void createRejectsDraftUnknownWorkspaceAndStaleSessionOrCatalogAuthority() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.draftChanged("keep"); f.controller.createSession(WORKSPACE); f.pump();
        assertNull(f.latest().last("createSession")); assertEquals("keep", f.screen.composer.draft);
        f.controller.draftChanged(""); f.controller.createSession("unknown"); f.pump();
        assertNull(f.latest().last("createSession"));
        f.latest().events.disconnected(); f.advance(5000); f.confirm(); enable(f);
        f.controller.createSession(WORKSPACE); f.controller.renameSession("s1", "stale");
        f.controller.archiveSession("s1"); f.controller.setSessionPinned("s1", true); f.pump();
        assertEquals(0, mutations(f.latest()));
        f.sessions(Collections.singletonList(session("newer", "closed", "Newer", 2)), "cGFnZQ");
        f.controller.renameSession("s1", "stale"); f.controller.archiveSession("s1");
        f.controller.setSessionPinned("s1", true); f.pump(); assertEquals(0, mutations(f.latest()));
        f.controller.loadMoreSessions();
        f.sessions(Collections.singletonList(session("s1", "closed", "Original", 1)), null);
        f.controller.refreshManagementWorkspaces();
        f.controller.createSession(WORKSPACE); f.controller.setSessionPinned("s1", true); f.pump();
        assertEquals(0, mutations(f.latest())); assertTrue(f.fences.isEmpty());
    }

    @Test public void renameAndPinUseAuthenticatedRowsAndProgressPreservesManagementNavigation() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture(); f.ready(); enable(f);
        f.controller.renameSession("s1", "Renamed"); f.pump();
        Map<String, Object> rename = f.latest().last("renameSession");
        f.controller.sendText("blocked by management fence"); f.pump();
        assertNull(f.latest().last("submitText"));
        assertEquals("s1", find(f, "s1").title);
        f.latest().result(applied(rename, session("s1", "running", "Renamed", 42))); f.pump();
        SessionNavigation navigation = find(f, "s1").navigation;
        assertEquals("Renamed", f.screen.conversation.session.title);
        assertEquals(WORKSPACE, navigation.workspace.id);
        f.controller.setSessionPinned("s1", false); f.pump();
        Map<String, Object> pin = f.latest().last("setSessionPinned");
        assertEquals(Boolean.FALSE, pin.get("pinned"));
        Map<String, Object> unpinned = session("s1", "running", "Renamed", 84);
        Map<String, Object> unpinnedNavigation = new LinkedHashMap<>(Protocol.record(unpinned.get("navigation")));
        unpinnedNavigation.put("pinOrder", null); unpinned.put("navigation", unpinnedNavigation);
        f.latest().result(applied(pin, unpinned)); f.pump();
        f.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", f.subscription,
            "sessionId", "s1", "rows", Collections.emptyList(), "status", "idle"));
        SessionRow row = find(f, "s1");
        assertEquals(SessionStatus.IDLE, row.status); assertEquals("Renamed", row.title);
        assertEquals(84, row.navigation.updatedAt); assertNull(row.navigation.pinOrder);
        assertEquals(WORKSPACE, row.navigation.workspace.id);
        assertSame(row.navigation, f.screen.conversation.session.navigation);
        assertEquals(ManagementAccess.ENABLED, f.screen.sessions.management.access);
        assertEquals(WORKSPACE, f.screen.sessions.management.workspaces.get(0).id);
        f.controller.createSession(WORKSPACE); f.pump();
        assertNotNull(f.latest().last("createSession"));
    }

    @Test public void appliedManagementRestoresTheBaselineWatchRetiredByAnExplicitRefresh() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture(); f.ready(); enable(f);
        f.controller.renameSession("s1", "Renamed"); f.pump();
        f.controller.refresh();
        Map<String, Object> staleListing = f.latest().last("listSessions");
        Map<String, Object> previousWatch = f.latest().last("watchProgress");
        f.latest().result(applied(f.latest().last("renameSession"), session("s1", "running", "Renamed", 42))); f.pump();
        Map<String, Object> replacementWatch = f.latest().last("watchProgress");
        assertNotEquals(previousWatch.get("requestId"), replacementWatch.get("requestId"));
        assertEquals(SendState.OFFLINE, f.screen.composer.state);
        f.controller.sendText("must wait for fresh watch authority"); f.pump();
        assertNull(f.latest().last("submitText")); assertTrue(f.fences.isEmpty());
        f.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", staleListing.get("requestId"),
            "sessions", Collections.singletonList(session("s1", "running", "Old title", 1))));
        f.watching(); f.historyPage(Collections.emptyList(), null);
        assertEquals("Renamed", find(f, "s1").title);
        assertEquals(SendState.READY, f.screen.composer.state);
    }

    @Test public void successfulManagementRestartsCancelledPaginationWithoutAcceptingStaleRows() throws Exception {
        for (String kind : new String[] { "createSession", "renameSession", "setSessionPinned" }) {
            ControllerRegression.Fixture f = new ControllerRegression.Fixture();
            f.controller.start(); f.pump(); f.confirm();
            f.sessions(Collections.singletonList(session("s1", "closed", "Original", 1)), "cGFnZTE");
            f.controller.selectSession("s1"); f.historyPage(Collections.emptyList(), null); enable(f);
            f.controller.loadMoreSessions();
            Map<String, Object> stalePage = f.latest().last("listSessions");
            if (kind.equals("createSession")) f.controller.createSession(WORKSPACE);
            else if (kind.equals("renameSession")) f.controller.renameSession("s1", "Changed");
            else f.controller.setSessionPinned("s1", true);
            f.pump();
            Map<String, Object> mutation = f.latest().last(kind);
            String target = (String) mutation.get("sessionId");
            Map<String, Object> changed = session(target, kind.equals("createSession") ? "idle" : "closed", "Changed", 42);
            f.latest().result(applied(mutation, changed)); f.pump();
            Map<String, Object> restarted = f.latest().last("listSessions");
            assertNotEquals(stalePage.get("requestId"), restarted.get("requestId"));
            assertNull(restarted.get("cursor"));
            f.latest().result(Protocol.object("v", 1, "type", "sessions", "requestId", stalePage.get("requestId"),
                "sessions", Collections.singletonList(session(target, "closed", "Stale title", 1))));
            assertEquals("Changed", find(f, target).title);
            f.sessions(Collections.singletonList(changed), "cGFnZTI");
            assertTrue(f.screen.sessions.canLoadMore);
            f.controller.loadMoreSessions();
            assertEquals("cGFnZTI", f.latest().last("listSessions").get("cursor"));
            f.sessions(Collections.singletonList(session("later", "closed", "Still reachable", 2)), null);
            assertEquals("Still reachable", find(f, "later").title);
            assertEquals("Changed", find(f, target).title);
            assertEquals(42, find(f, target).navigation.updatedAt);
        }
    }

    @Test public void anActiveManagedSummaryForTheClosedSelectionRequiresANewWatchAndKeepsDraftAndHistory() throws Exception {
        ControllerRegression.Fixture f = knownClosed();
        f.controller.selectSession("s1");
        Map<String, Object> retained = Protocol.object("role", "assistant", "seq", Protocol.encodeCounter(1), "id", "retained", "text", "Keep approved history");
        f.historyPage(Collections.singletonList(retained), null); enable(f);
        f.controller.draftChanged("keep unsent draft");
        assertNull(f.latest().last("watchProgress"));
        f.controller.renameSession("s1", "Resumed"); f.pump();
        f.latest().result(applied(f.latest().last("renameSession"), session("s1", "idle", "Resumed", 42))); f.pump();
        assertEquals("s1", f.latest().last("watchProgress").get("sessionId"));
        assertEquals(SendState.OFFLINE, f.screen.composer.state);
        assertEquals("keep unsent draft", f.screen.composer.draft);
        assertEquals("Keep approved history", f.screen.conversation.rows.get(0).text);
        f.controller.sendText("must wait for new watch"); f.pump();
        assertNull(f.latest().last("submitText")); assertTrue(f.fences.isEmpty());
        f.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", Protocol.randomId(16),
            "sessionId", "s1", "rows", Collections.emptyList(), "status", "closed"));
        f.watching(); f.historyPage(Collections.emptyList(), null);
        assertEquals(SendState.READY, f.screen.composer.state);
        assertEquals("keep unsent draft", f.screen.composer.draft);
        assertEquals("Keep approved history", f.screen.conversation.rows.get(0).text);
    }

    @Test public void laterProgressStatusSurvivesTheManagementFenceClearAndStillBlocksBusyArchive() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture(); f.ready(); enable(f);
        f.controller.setSessionPinned("s1", true); f.pump();
        f.latest().result(applied(f.latest().last("setSessionPinned"), session("s1", "idle", "Pinned", 42)));
        f.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", f.subscription,
            "sessionId", "s1", "rows", Collections.emptyList(), "status", "running"));
        f.pump();
        assertEquals(SessionStatus.BUSY, find(f, "s1").status);
        assertEquals("Pinned", find(f, "s1").title);
        f.controller.archiveSession("s1"); f.pump();
        assertNull(f.latest().last("archiveSession"));
    }

    @Test public void managedClosureRetiresOnlyItsWatchBeforeOrAfterAcknowledgement() throws Exception {
        for (boolean acknowledged : new boolean[] { false, true }) {
            ControllerRegression.Fixture f = new ControllerRegression.Fixture();
            f.startWithSessions(Collections.singletonList(session("s1", "idle", "Original", 1)));
            f.controller.selectSession("s1");
            Map<String, Object> watch = f.latest().last("watchProgress");
            String subscription = Protocol.randomId(16);
            Map<String, Object> row = Protocol.object("role", "assistant", "seq", Protocol.encodeCounter(1), "id", "r1", "text", "Retained");
            if (acknowledged) { f.watching(); subscription = f.subscription; }
            else f.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", subscription,
                "sessionId", "s1", "rows", Collections.singletonList(row), "status", "running"));
            enable(f); f.controller.renameSession("s1", "Closed"); f.pump();
            f.latest().result(applied(f.latest().last("renameSession"), session("s1", "closed", "Closed", 42))); f.pump();
            if (!acknowledged) {
                assertNull(f.latest().last("cancelRead"));
                f.latest().result(Protocol.object("v", 1, "type", "watching", "requestId", watch.get("requestId"),
                    "sessionId", "s1", "subscriptionId", subscription));
            }
            assertEquals(subscription, f.latest().last("cancelRead").get("subscriptionId"));
            Map<String, Object> history = f.latest().last("readHistory");
            f.latest().result(Protocol.object("v", 1, "type", "error", "requestId", watch.get("requestId"), "code", "expired"));
            f.latest().result(Protocol.object("v", 1, "type", "history", "requestId", history.get("requestId"),
                "sessionId", "s1", "rows", acknowledged ? Collections.singletonList(row) : Collections.emptyList()));
            assertEquals(SessionStatus.CLOSED, find(f, "s1").status);
            assertEquals(1, f.screen.conversation.rows.size());
            assertEquals("Retained", f.screen.conversation.rows.get(0).text);
            assertNotEquals(Feedback.REFRESH_FAILED, f.screen.composer.feedback);
        }
    }

    @Test public void successfulManagementCannotClearAnIndependentHistoryFailure() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture(); f.closedReady(); enable(f);
        f.controller.refresh(); f.sessions(Collections.singletonList(session("s1", "closed", "Original", 1)), null);
        Map<String, Object> history = f.latest().last("readHistory");
        f.controller.renameSession("s1", "Renamed"); f.pump();
        f.latest().result(applied(f.latest().last("renameSession"), session("s1", "closed", "Renamed", 42)));
        f.latest().result(Protocol.object("v", 1, "type", "error", "requestId", history.get("requestId"), "code", "unavailable"));
        f.pump();
        assertEquals("Renamed", find(f, "s1").title);
        assertEquals(Feedback.REFRESH_FAILED, f.screen.composer.feedback);
    }

    @Test public void appliedClearFailureKeepsOriginalRowAndFenceUntilExplicitReview() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.renameSession("s1", "Renamed"); f.pump();
        f.failClear = true;
        f.latest().result(applied(f.latest().last("renameSession"), session("s1", "closed", "Renamed", 42))); f.pump();
        assertEquals("Original", find(f, "s1").title);
        assertEquals(SendState.DELIVERY_UNKNOWN, f.screen.composer.state);
        f.controller.setSessionPinned("s1", true); f.pump(); assertNull(f.latest().last("setSessionPinned"));
        f.failClear = false; f.controller.resolveUnknown(); f.pump();
        assertTrue(f.fences.isEmpty()); assertEquals("Original", find(f, "s1").title);
    }

    @Test public void rejectionClearsFenceWithoutOptimisticRowAndAllowsNewExplicitOperation() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.renameSession("s1", "Rejected"); f.pump();
        Map<String, Object> first = f.latest().last("renameSession");
        Map<String, Object> rejected = managed(first, "rejected"); rejected.put("code", "denied");
        f.latest().result(rejected);
        assertEquals("Original", find(f, "s1").title); assertFalse(f.fences.isEmpty());
        f.pump(); assertTrue(f.fences.isEmpty());
        f.controller.renameSession("s1", "Explicit retry"); f.pump();
        assertNotEquals(first.get("operationId"), f.latest().last("renameSession").get("operationId"));
        assertEquals("Original", find(f, "s1").title);
    }

    @Test public void unknownAndTimeoutNeverResendAcrossReconnect() throws Exception {
        for (boolean explicitUnknown : new boolean[] { true, false }) {
            ControllerRegression.Fixture f = knownClosed(); enable(f);
            f.controller.renameSession("s1", "Uncertain"); f.pump();
            Map<String, Object> request = f.latest().last("renameSession");
            if (explicitUnknown) { f.latest().result(managed(request, "unknown")); f.pump(); }
            else f.advance(15000);
            assertEquals("Original", find(f, "s1").title);
            assertEquals(SendState.DELIVERY_UNKNOWN, f.screen.composer.state);
            assertEquals(request.get("operationId"), f.screen.composer.review.submissionId);
            assertEquals(1, f.fences.size());
            ControllerRegression.FakeLink old = f.latest();
            if (!old.closed) old.events.disconnected();
            f.advance(5000); f.confirm();
            f.sessions(Collections.singletonList(session("s1", "closed", "Original", 1)), null);
            enable(f);
            old.result(applied(request, session("s1", "closed", "Late", 99))); f.pump();
            f.controller.renameSession("s1", "Blocked"); f.controller.createSession(WORKSPACE); f.pump();
            assertEquals(0, mutations(f.latest())); assertEquals(1, f.fences.size());
            assertEquals("Original", find(f, "s1").title);
        }
    }

    @Test public void mismatchedManagedIdentityCannotClearOrApplyThePendingFence() throws Exception {
        for (String field : new String[] { "requestId", "operationId", "sessionId", "action" }) {
            ControllerRegression.Fixture f = knownClosed(); enable(f);
            f.controller.renameSession("s1", "Renamed"); f.pump();
            Map<String, Object> request = f.latest().last("renameSession");
            Map<String, Object> wrong = applied(request,
                session(field.equals("sessionId") ? "other" : "s1", "closed", "Wrong", 42));
            wrong.put(field, field.equals("action") ? "pin" : field.equals("sessionId") ? "other" : Protocol.randomId(16));
            f.latest().result(wrong); f.pump();
            assertEquals(1, f.fences.size()); assertEquals("Original", find(f, "s1").title);
            f.controller.archiveSession("s1"); f.pump(); assertNull(f.latest().last("archiveSession"));
        }
    }

    @Test public void malformedDefinitiveOrUnknownRepliesCannotReleaseMutationAuthority() throws Exception {
        for (String malformed : new String[] { "missingNavigation", "archiveRow", "rejectionWithoutCode", "unknownWithCode" }) {
            ControllerRegression.Fixture f = knownClosed(); enable(f);
            if (malformed.equals("archiveRow")) f.controller.archiveSession("s1");
            else f.controller.renameSession("s1", "Renamed");
            f.pump();
            Map<String, Object> request = f.latest().last(malformed.equals("archiveRow") ? "archiveSession" : "renameSession");
            Map<String, Object> reply;
            if (malformed.equals("rejectionWithoutCode")) reply = managed(request, "rejected");
            else if (malformed.equals("unknownWithCode")) { reply = managed(request, "unknown"); reply.put("code", "denied"); }
            else {
                Map<String, Object> row = session("s1", "closed", "Renamed", 42);
                if (malformed.equals("missingNavigation")) row.remove("navigation");
                reply = applied(request, row);
            }
            f.latest().result(reply); f.pump();
            assertEquals(1, f.fences.size()); assertEquals("Original", find(f, "s1").title);
        }
    }

    @Test public void archiveDeniesBusySelectedDraftUnknownRowsAndSharedMutationFence() throws Exception {
        ControllerRegression.Fixture busy = new ControllerRegression.Fixture(); busy.ready(); enable(busy);
        busy.controller.archiveSession("s1"); busy.pump();
        assertNull(busy.latest().last("archiveSession")); assertTrue(busy.fences.isEmpty());
        busy.controller.draftChanged("send"); busy.controller.sendText("send"); busy.pump();
        busy.controller.renameSession("s1", "Blocked"); busy.controller.createSession(WORKSPACE); busy.pump();
        assertNull(busy.latest().last("renameSession")); assertNull(busy.latest().last("createSession"));
        assertEquals(OperationKind.SUBMIT_TEXT, busy.fences.values().iterator().next().kind);

        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.selectSession("s1"); f.historyPage(Collections.emptyList(), null);
        f.controller.draftChanged("retain"); f.controller.archiveSession("s1"); f.pump();
        assertNull(f.latest().last("archiveSession")); assertEquals("retain", f.screen.composer.draft);
        f.controller.draftChanged("");
        f.controller.archiveSession("missing"); f.controller.renameSession("missing", "Unknown");
        f.controller.setSessionPinned("missing", true); f.pump(); assertEquals(0, mutations(f.latest()));
        f.controller.archiveSession("s1"); f.pump();
        Map<String, Object> archive = f.latest().last("archiveSession"); assertNotNull(archive);
        assertNotNull(find(f, "s1"));
        f.controller.renameSession("s1", "Blocked"); f.controller.setSessionPinned("s1", true); f.pump();
        assertNull(f.latest().last("renameSession")); assertNull(f.latest().last("setSessionPinned"));
        f.latest().result(managed(archive, "applied"));
        assertNotNull(find(f, "s1")); f.pump();
        assertNull(find(f, "s1")); assertNull(f.screen.conversation.session); assertTrue(f.fences.isEmpty());
    }

    @Test public void pendingAndUnknownArchiveCannotStrandNewDraftsOrLockAnotherChat() throws Exception {
        for (String outcome : new String[] { "applied", "unknown" }) {
            ControllerRegression.Fixture f = new ControllerRegression.Fixture();
            f.startWithSessions(Arrays.asList(session("s1", "idle", "One", 1), session("s2", "idle", "Two", 2)));
            f.controller.selectSession("s1"); f.watching();
            f.latest().result(Protocol.object("v", 1, "type", "progress", "subscriptionId", f.subscription,
                "sessionId", "s1", "rows", Collections.emptyList(), "status", "idle"));
            f.historyPage(Collections.emptyList(), null); enable(f);
            f.controller.archiveSession("s1");
            f.controller.draftChanged("before durable admission");
            assertEquals("", f.screen.composer.draft);
            assertNull(f.latest().last("archiveSession"));
            f.pump();
            Map<String, Object> archive = f.latest().last("archiveSession"); assertNotNull(archive);
            f.controller.draftChanged("while awaiting acknowledgement");
            assertEquals("", f.screen.composer.draft);
            f.controller.selectSession("s2"); f.controller.draftChanged("other chat draft");
            f.latest().result(managed(archive, outcome)); f.pump();
            assertEquals("s2", f.screen.sessions.selectedId);
            assertEquals("other chat draft", f.screen.composer.draft);
            if (outcome.equals("unknown")) {
                f.controller.selectSession("s1"); f.controller.draftChanged("after uncertain archive");
                assertEquals("", f.screen.composer.draft);
                f.controller.resolveUnknown(); f.pump();
                f.controller.draftChanged("after explicit review");
                f.controller.selectSession("s2"); f.controller.selectSession("s1");
                assertEquals("after explicit review", f.screen.composer.draft);
            } else assertNull(find(f, "s1"));
        }
    }

    @Test public void archivingAnotherRowPreservesSelectedConversationAndDraft() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture();
        f.startWithSessions(Arrays.asList(session("s1", "closed", "One", 1), session("s2", "closed", "Two", 2)));
        f.controller.selectSession("s1"); f.historyPage(Collections.emptyList(), null); enable(f);
        f.controller.draftChanged("selected draft"); f.controller.archiveSession("s2"); f.pump();
        Map<String, Object> archive = f.latest().last("archiveSession"); assertNotNull(archive);
        f.latest().result(managed(archive, "applied")); f.pump();
        assertNull(find(f, "s2")); assertEquals("s1", f.screen.sessions.selectedId);
        assertEquals("selected draft", f.screen.composer.draft); assertTrue(f.fences.isEmpty());
    }

    @Test public void failedCatalogRemovesAuthorityWithoutDiscardingSessionRows() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.refreshManagementWorkspaces();
        Map<String, Object> read = f.latest().last("listManagementWorkspaces");
        f.latest().result(Protocol.object("v", 1, "type", "error", "requestId", read.get("requestId"), "code", "unavailable"));
        assertEquals(ManagementAccess.UNAVAILABLE, f.screen.sessions.management.access);
        assertTrue(f.screen.sessions.management.workspaces.isEmpty());
        f.controller.createSession(WORKSPACE); f.controller.renameSession("s1", "Blocked"); f.pump();
        assertEquals(0, mutations(f.latest())); assertEquals("Original", find(f, "s1").title);
    }

    @Test public void retirementClearsCatalogAndLateCatalogOrMutationCannotRestoreAuthority() throws Exception {
        for (boolean foregroundStop : new boolean[] { true, false }) {
            ControllerRegression.Fixture f = knownClosed(); enable(f);
            f.controller.renameSession("s1", "Late"); f.pump();
            Map<String, Object> mutation = f.latest().last("renameSession");
            Map<String, Object> read = f.latest().last("listManagementWorkspaces");
            ControllerRegression.FakeLink old = f.latest();
            if (foregroundStop) { f.controller.stop(); f.controller.start(); } else old.events.disconnected();
            assertEquals(ManagementAccess.CHECKING, f.screen.sessions.management.access);
            assertTrue(f.screen.sessions.management.workspaces.isEmpty());
            old.result(Protocol.object("v", 1, "type", "managementWorkspaces", "requestId", read.get("requestId"),
                "enabled", true, "workspaces", Collections.singletonList(workspace(WORKSPACE, 7))));
            old.result(applied(mutation, session("s1", "closed", "Late", 99))); f.pump();
            assertEquals(ManagementAccess.CHECKING, f.screen.sessions.management.access);
            assertTrue(f.screen.sessions.management.workspaces.isEmpty());
            assertEquals("Original", find(f, "s1").title); assertEquals(1, f.fences.size());
            f.advance(5000); f.confirm();
            assertEquals(ManagementAccess.DISABLED, f.screen.sessions.management.access);
            old.result(Protocol.object("v", 1, "type", "managementWorkspaces",
                "requestId", f.latest().last("listManagementWorkspaces").get("requestId"), "enabled", true,
                "workspaces", Collections.singletonList(workspace(WORKSPACE, 7))));
            f.controller.createSession(WORKSPACE); f.pump();
            assertEquals(ManagementAccess.DISABLED, f.screen.sessions.management.access);
            assertEquals(0, mutations(f.latest())); assertEquals(1, f.fences.size());
        }
    }

    @Test public void anUnansweredCatalogCannotBecomeAuthorityAfterItsConnectionRetires() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.refreshManagementWorkspaces();
        Map<String, Object> request = f.latest().last("listManagementWorkspaces");
        ControllerRegression.FakeLink retired = f.latest();
        retired.events.disconnected();
        retired.result(Protocol.object("v", 1, "type", "managementWorkspaces", "requestId", request.get("requestId"),
            "enabled", true, "workspaces", Collections.singletonList(workspace(WORKSPACE, 7))));
        assertEquals(ManagementAccess.CHECKING, f.screen.sessions.management.access);
        assertTrue(f.screen.sessions.management.workspaces.isEmpty());
        f.controller.createSession(WORKSPACE); f.pump();
        assertTrue(f.fences.isEmpty());
    }

    @Test public void offscreenDefinitiveStorageSettlementCannotInstallRetiredMetadata() throws Exception {
        ControllerRegression.Fixture f = knownClosed(); enable(f);
        f.controller.renameSession("s1", "Retired title"); f.pump();
        f.latest().result(applied(f.latest().last("renameSession"), session("s1", "closed", "Retired title", 42)));
        f.io.removeFirst().run();
        f.controller.stop(); f.controller.start(); f.pump();
        assertTrue(f.fences.isEmpty());
        assertEquals("Original", find(f, "s1").title);
        assertEquals(ManagementAccess.CHECKING, f.screen.sessions.management.access);
        assertTrue(f.screen.sessions.management.workspaces.isEmpty());
    }

    @Test public void storageIdentityMismatchRetainsForeignFenceAndDoesNotApplyDefinitiveRow() throws Exception {
        for (String field : new String[] { "kind", "operation" }) {
            ControllerRegression.Fixture f = knownClosed(); enable(f);
            f.controller.renameSession("s1", "Renamed"); f.pump();
            Map<String, Object> request = f.latest().last("renameSession");
            Fence pending = f.fences.values().iterator().next();
            Fence replacement = new Fence(pending.pcId, pending.sessionId,
                field.equals("operation") ? Protocol.randomId(16) : pending.operationId,
                field.equals("kind") ? OperationKind.SET_SESSION_PINNED : pending.kind);
            f.fences.put(pending.targetKey(), replacement);
            f.latest().result(applied(request, session("s1", "closed", "Renamed", 42))); f.pump();
            assertSame(replacement, f.fences.values().iterator().next());
            assertEquals("Original", find(f, "s1").title);
            assertEquals(SendState.DELIVERY_UNKNOWN, f.screen.composer.state);
        }
    }

    private static ControllerRegression.Fixture knownClosed() throws Exception {
        ControllerRegression.Fixture f = new ControllerRegression.Fixture();
        f.startWithSessions(Collections.singletonList(session("s1", "closed", "Original", 1)));
        return f;
    }
    private static void enable(ControllerRegression.Fixture f) {
        f.controller.refreshManagementWorkspaces();
        catalog(f, true, Collections.singletonList(workspace(WORKSPACE, 7)), null);
    }
    private static void catalog(ControllerRegression.Fixture f, boolean enabled, List<?> rows, String cursor) {
        Map<String, Object> response = new LinkedHashMap<>(Protocol.object("v", 1, "type", "managementWorkspaces",
            "requestId", f.latest().last("listManagementWorkspaces").get("requestId"), "enabled", enabled, "workspaces", rows));
        if (cursor != null) response.put("cursor", cursor);
        f.latest().result(response);
    }
    private static Map<String, Object> workspace(String id, long order) {
        return Protocol.object("id", id, "title", "工作 🧭", "order", order);
    }
    private static Map<String, Object> session(String id, String status, String title, long updatedAt) {
        return new LinkedHashMap<>(Protocol.object("sessionId", id, "title", title, "status", status, "navigation",
            Protocol.object("updatedAt", updatedAt, "pinOrder", 0, "workspace", workspace(WORKSPACE, 7))));
    }
    private static Map<String, Object> managed(Map<String, Object> request, String outcome) {
        String type = (String) request.get("type");
        String action = type.equals("createSession") ? "create" : type.equals("renameSession") ? "rename"
            : type.equals("archiveSession") ? "archive" : "pin";
        return new LinkedHashMap<>(Protocol.object("v", 1, "type", "managed", "requestId", request.get("requestId"),
            "operationId", request.get("operationId"), "sessionId", request.get("sessionId"), "action", action, "outcome", outcome));
    }
    private static Map<String, Object> applied(Map<String, Object> request, Map<String, Object> row) {
        Map<String, Object> reply = managed(request, "applied"); reply.put("session", row); return reply;
    }
    private static SessionRow find(ControllerRegression.Fixture f, String id) {
        for (SessionRow row : f.screen.sessions.rows) if (row.id.equals(id)) return row;
        return null;
    }
    private static int mutations(ControllerRegression.FakeLink link) {
        int count = 0;
        for (Map<String, Object> request : link.requests) if (request.containsKey("operationId") || request.containsKey("submissionId")) count++;
        return count;
    }
}
