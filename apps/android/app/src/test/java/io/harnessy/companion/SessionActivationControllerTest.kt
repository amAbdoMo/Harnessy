package io.harnessy.companion

import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.presentation.DisplayModels.*
import io.harnessy.companion.protocol.Protocol
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Real controller, DTOs and correlation; only storage, clock and authenticated transport are substituted. */
class SessionActivationControllerTest {
    private val owned = mutableListOf<ControllerRegression.Fixture>()
    @After fun retire() { owned.forEach { it.controller.stop(); it.pump() } }

    @Test fun browsingColdHistoryDoesNotOpenAChatAndIndependentConsentIsRequired() {
        val f = cold()
        assertNull(f.latest().last("openSession"))
        assertEquals(SendState.CLOSED, f.screen.composer.state)
        f.controller.openSession("s1"); f.pump()
        assertNull(f.latest().last("openSession"))
        assertTrue(f.fences.isEmpty())
        permission(f, false)
        f.controller.openSession("s1"); f.pump()
        assertNull(f.latest().last("openSession"))
        assertEquals(ActivationAccess.DISABLED, f.screen.activation.access)
    }

    @Test fun explicitOpeningPersistsOnlyItsIdentityBeforeWireAndRequiresConfirmedSettlement() {
        val f = cold()
        permission(f)
        f.controller.draftChanged("keep this chat draft")
        f.controller.openSession("s1")
        assertNull(f.latest().last("openSession"))
        f.io.removeFirst().run()
        assertEquals(OperationKind.OPEN_SESSION, f.fences.values.single().kind)
        assertNull(f.latest().last("openSession"))
        f.pump()
        val request = requireNotNull(f.latest().last("openSession"))
        assertEquals(setOf("v", "type", "requestId", "operationId", "sessionId"), request.keys)
        assertEquals("s1", request["sessionId"])
        f.latest().result(reply(request, "applied"))
        assertEquals(SessionStatus.CLOSED, f.screen.conversation.session.status)
        f.pump()
        assertEquals(SessionStatus.IDLE, f.screen.conversation.session.status)
        assertTrue(f.fences.isEmpty())
        f.watching(); f.historyPage(emptyList<Any>(), null)
        assertEquals(SendState.READY, f.screen.composer.state)
        assertEquals("keep this chat draft", f.screen.composer.draft)
        assertNull(f.latest().last("submitText"))
        assertNull(f.latest().last("selectSessionModel"))
        assertEquals(ManagementAccess.DISABLED, f.screen.sessions.management.access)
    }

    @Test fun navigationBeforeFenceCommitCancelsOpeningRatherThanRetargetingIt() {
        val f = cold()
        permission(f)
        f.controller.openSession("s1")
        f.controller.selectSession("s2")
        f.pump()
        assertNull(f.latest().last("openSession"))
        assertTrue(f.fences.isEmpty())
        assertEquals("s2", f.screen.sessions.selectedId)
    }

    @Test fun unknownOpeningInOneChatDoesNotFenceAnotherAndNeitherIsAutomaticallyResent() {
        val f = cold()
        permission(f)
        f.controller.openSession("s1"); f.pump()
        val first = requireNotNull(f.latest().last("openSession"))
        f.latest().result(reply(first, "unknown")); f.pump()
        assertEquals(SendState.DELIVERY_UNKNOWN, f.screen.composer.state)
        f.controller.selectSession("s2"); f.historyPage(emptyList<Any>(), null)
        assertEquals(SendState.CLOSED, f.screen.composer.state)
        f.controller.openSession("s2"); f.pump()
        val second = requireNotNull(f.latest().last("openSession"))
        assertEquals("s2", second["sessionId"])
        assertEquals(2, f.fences.size)
        f.latest().result(reply(second, "unknown")); f.pump()
        f.controller.selectSession("s1")
        assertEquals(first["operationId"], f.screen.composer.review.submissionId)
        f.controller.openSession("s1"); f.pump()
        assertEquals(2, f.links.sumOf { it.requests.count { request -> request["type"] == "openSession" } })
        f.controller.stop(); f.pump()
        f.controller = f.newController()
        f.controller.start(); f.pump(); f.confirm()
        f.sessions(listOf(session("s1"), session("s2")), null)
        f.controller.selectSession("s2")
        assertEquals(second["operationId"], f.screen.composer.review.submissionId)
        assertEquals(2, f.fences.size)
        assertEquals(2, f.links.sumOf { it.requests.count { request -> request["type"] == "openSession" } })
    }

    @Test fun aLateAdmissionForOneChatCannotClearAnEqualDraftInAnotherChat() {
        val f = ControllerRegression.Fixture().also { owned.add(it) }
        f.startWithSessions(listOf(session("s1", "idle"), session("s2", "idle")))
        f.controller.selectSession("s1"); f.watching(); f.historyPage(emptyList<Any>(), null)
        f.controller.draftChanged("same draft")
        f.controller.sendText("same draft"); f.pump()
        val request = requireNotNull(f.latest().last("submitText"))
        f.controller.selectSession("s2"); f.watching(); f.historyPage(emptyList<Any>(), null)
        assertEquals("", f.screen.composer.draft)
        f.controller.draftChanged("same draft")
        f.latest().result(Protocol.`object`("v", 1, "type", "submitted", "requestId", request["requestId"],
            "sessionId", "s1", "submissionId", request["submissionId"], "admission", "inMemoryInbox"))
        f.pump()
        assertEquals("same draft", f.screen.composer.draft)
        f.controller.selectSession("s1")
        assertEquals("", f.screen.composer.draft)
        f.controller.selectSession("s2")
        assertEquals("same draft", f.screen.composer.draft)
    }

    @Test fun managingAnUnselectedUncertainChatPreservesItsOriginalFenceWithoutSending() {
        val f = cold()
        permission(f)
        f.controller.selectSession("s2"); f.historyPage(emptyList<Any>(), null)
        f.controller.openSession("s2"); f.pump()
        val original = requireNotNull(f.latest().last("openSession"))
        f.latest().result(reply(original, "unknown")); f.pump()
        f.controller.selectSession("s1")
        management(f)
        f.controller.renameSession("s2", "Not admitted")
        f.controller.setSessionPinned("s2", true)
        f.controller.archiveSession("s2"); f.pump()
        assertNull(f.latest().last("renameSession"))
        assertNull(f.latest().last("setSessionPinned"))
        assertNull(f.latest().last("archiveSession"))
        assertEquals(original["operationId"], f.fences.values.single().operationId)
        f.controller.selectSession("s2")
        assertEquals(original["operationId"], f.screen.composer.review.submissionId)
        f.controller.resolveUnknown(); f.pump()
        assertTrue(f.fences.isEmpty())
    }

    @Test fun archivingAnUnselectedChatCannotStrandItsRetainedDraft() {
        val f = cold()
        f.controller.selectSession("s2"); f.controller.draftChanged("Retain B")
        f.controller.selectSession("s1")
        management(f)
        f.controller.archiveSession("s2"); f.pump()
        assertNull(f.latest().last("archiveSession"))
        assertTrue(f.fences.isEmpty())
        assertEquals(Feedback.MANAGEMENT_DRAFT_REQUIRED, f.screen.composer.feedback)
        f.controller.selectSession("s2")
        assertEquals("Retain B", f.screen.composer.draft)
    }

    private fun management(f: ControllerRegression.Fixture) {
        f.controller.refreshManagementWorkspaces()
        f.latest().result(Protocol.`object`("v", 1, "type", "managementWorkspaces", "requestId",
            f.latest().last("listManagementWorkspaces")["requestId"], "enabled", true, "workspaces", emptyList<Any>()))
    }

    private fun cold(): ControllerRegression.Fixture {
        val f = ControllerRegression.Fixture().also { owned.add(it) }
        f.startWithSessions(listOf(session("s1"), session("s2")))
        f.controller.selectSession("s1"); f.historyPage(emptyList<Any>(), null)
        return f
    }

    private fun permission(f: ControllerRegression.Fixture, enabled: Boolean = true) {
        f.controller.refreshActivationAccess()
        val request = requireNotNull(f.latest().last("getSessionActivation"))
        f.latest().result(Protocol.`object`("v", 1, "type", "sessionActivation", "requestId", request["requestId"], "enabled", enabled))
    }

    private fun session(id: String, status: String = "closed") = Protocol.`object`("sessionId", id, "title", id, "status", status,
        "navigation", Protocol.`object`("workspace", null, "pinOrder", null, "updatedAt", 1))

    private fun reply(request: Map<String, Any>, outcome: String) = LinkedHashMap(Protocol.`object`(
        "v", 1, "type", "sessionOpened", "requestId", request["requestId"], "operationId", request["operationId"],
        "sessionId", request["sessionId"], "outcome", outcome,
    )).apply { if (outcome == "applied") put("session", session(request["sessionId"] as String, "idle")) }

}
