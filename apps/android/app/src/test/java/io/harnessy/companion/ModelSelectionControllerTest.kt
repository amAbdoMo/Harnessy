package io.harnessy.companion

import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.presentation.DisplayModels.*
import io.harnessy.companion.presentation.ModelAccess
import io.harnessy.companion.protocol.Protocol
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Real controller/correlation and wire validation; only platform storage, time and authenticated transport are substituted. */
class ModelSelectionControllerTest {
    private val owned = mutableListOf<ControllerRegression.Fixture>()
    private val revision = Protocol.randomId(16)
    private val firstId = Protocol.randomId(16)
    private val nextId = Protocol.randomId(16)
    private val first get() = choice(firstId, "Current model")
    private val next get() = choice(nextId, "Next model")

    @After
    fun retire() { owned.forEach { it.controller.stop(); it.pump() } }

    @Test
    fun selectionCommitsOnlyIdentifiersBeforeSendingAndPublishesAfterAcknowledgementAndFenceClear() {
        val f = ready()
        f.controller.draftChanged("preserved draft")
        offer(f)
        assertEquals(ManagementAccess.DISABLED, f.screen.sessions.management.access)
        f.controller.selectModel("s1", revision, nextId)
        assertNull(f.latest().last("selectSessionModel"))
        f.io.removeFirst().run()
        assertEquals(OperationKind.SELECT_SESSION_MODEL, f.fences.values.singleOrNull()?.kind)
        assertNull(f.latest().last("selectSessionModel"))
        f.pump()
        val sent = requireNotNull(f.latest().last("selectSessionModel"))
        assertEquals(setOf("v", "type", "requestId", "operationId", "sessionId", "revision", "choiceId"), sent.keys)
        assertEquals(revision, sent["revision"])
        assertEquals(nextId, sent["choiceId"])
        f.latest().result(reply(sent, "applied", next))
        assertEquals(firstId, f.screen.models.current?.id)
        assertTrue(f.fences.isNotEmpty())
        f.io.removeFirst().run()
        assertTrue(f.fences.isEmpty())
        assertEquals(firstId, f.screen.models.current?.id)
        f.pump()
        assertEquals(nextId, f.screen.models.current?.id)
        assertEquals("preserved draft", f.screen.composer.draft)
        assertNull(f.screen.composer.review)
    }

    @Test
    fun uncertainOutcomesRetainTheTypedFenceAndNeverResendOrClearTheDraft() {
        for (outcome in listOf("unknown", "timeout", "disconnect", "wrong-choice", "clear-failed")) {
            val f = ready()
            f.controller.draftChanged("keep $outcome")
            offer(f)
            f.controller.selectModel("s1", revision, nextId); f.pump()
            val sent = requireNotNull(f.latest().last("selectSessionModel"))
            when (outcome) {
                "unknown" -> f.latest().result(reply(sent, "unknown"))
                "timeout" -> f.advance(15_000)
                "disconnect" -> { f.latest().events.disconnected(); f.advance(5000); f.confirm() }
                "wrong-choice" -> f.latest().result(reply(sent, "applied", first))
                "clear-failed" -> { f.failClear = true; f.latest().result(reply(sent, "applied", next)); f.pump() }
            }
            f.controller.sendText("must not send")
            f.controller.refreshModels(); f.pump()
            assertEquals(outcome, "keep $outcome", f.screen.composer.draft)
            assertEquals(outcome, OperationKind.SELECT_SESSION_MODEL, f.screen.composer.review.kind)
            assertEquals(outcome, sent["operationId"], f.screen.composer.review.submissionId)
            assertEquals(outcome, 1, f.links.sumOf { link -> link.requests.count { it["type"] == "selectSessionModel" } })
            assertTrue(outcome, f.links.none { it.last("submitText") != null })
        }
    }

    @Test
    fun definiteRejectionClearsOnlyTheFenceAndRequiresANewCatalogBeforeAnotherAttempt() {
        val f = ready()
        f.controller.draftChanged("keep rejection")
        offer(f)
        f.controller.selectModel("s1", revision, nextId); f.pump()
        val sent = requireNotNull(f.latest().last("selectSessionModel"))
        f.latest().result(reply(sent, "rejected", code = "conflict")); f.pump()
        assertTrue(f.fences.isEmpty())
        assertEquals(firstId, f.screen.models.current?.id)
        assertEquals(Feedback.MODEL_REJECTED, f.screen.composer.feedback)
        assertEquals("keep rejection", f.screen.composer.draft)
        f.controller.selectModel("s1", revision, nextId); f.pump()
        assertEquals(1, f.latest().requests.count { it["type"] == "selectSessionModel" })
    }

    @Test
    fun lateOrDifferentRevisionPagesCannotReplaceCurrentModelAuthority() {
        val f = ready()
        f.controller.refreshModels()
        val original = requireNotNull(f.latest().last("listSessionModels"))
        f.latest().result(catalog(original, requestId = Protocol.randomId(16)))
        assertEquals(ModelAccess.LOADING, f.screen.models.access)
        f.latest().result(catalog(original, cursor = "cGFnZQ"))
        f.controller.loadNextModels()
        val page = requireNotNull(f.latest().last("listSessionModels"))
        assertEquals("cGFnZQ", page["cursor"])
        f.latest().result(catalog(page, modelRevision = Protocol.randomId(16)))
        assertEquals(ModelAccess.UNAVAILABLE, f.screen.models.access)
        f.controller.selectModel("s1", revision, nextId); f.pump()
        assertTrue(f.fences.isEmpty())
        assertNull(f.latest().last("selectSessionModel"))
    }

    @Test
    fun navigationAbaOrBusyProgressBeforeTheStorageCommitPreventsAnyNetworkMutation() {
        for (change in listOf("navigation-aba", "busy")) {
            val f = ready()
            f.controller.draftChanged("keep before storage")
            offer(f)
            f.controller.selectModel("s1", revision, nextId)
            if (change == "navigation-aba") {
                f.controller.selectSession("s2"); f.watching(); f.historyPage(emptyList<Any>(), null)
                f.controller.selectSession("s1")
                f.watching(); idle(f); f.historyPage(emptyList<Any>(), null)
            } else progress(f, "running")
            f.pump()
            assertNull(change, f.latest().last("selectSessionModel"))
            assertTrue(change, f.fences.isEmpty())
            assertEquals(change, "keep before storage", f.screen.composer.draft)
        }
    }

    @Test
    fun catalogPermissionBusyAndClosedStatesNeverAuthorizeSelection() {
        for (state in listOf("denied", "busy", "closed")) {
            val f = ready()
            f.controller.refreshModels()
            val request = requireNotNull(f.latest().last("listSessionModels"))
            f.latest().result(Protocol.`object`("v", 1, "type", "sessionModels", "requestId", request["requestId"],
                "sessionId", "s1", "state", state, "models", emptyList<Any>(), "current", null))
            f.controller.selectModel("s1", revision, nextId); f.pump()
            assertTrue(state, f.fences.isEmpty())
            assertNull(state, f.latest().last("selectSessionModel"))
        }
    }

    private fun ready(): ControllerRegression.Fixture {
        val f = ControllerRegression.Fixture()
        owned.add(f)
        f.startWithSessions(listOf("s1", "s2").map { Protocol.`object`("sessionId", it, "title", it, "status", "idle") })
        f.controller.selectSession("s1"); f.watching(); idle(f); f.historyPage(emptyList<Any>(), null)
        assertEquals(SendState.READY, f.screen.composer.state)
        return f
    }

    private fun offer(f: ControllerRegression.Fixture) {
        f.controller.refreshModels()
        val request = requireNotNull(f.latest().last("listSessionModels"))
        f.latest().result(catalog(request))
        assertEquals(ModelAccess.READY, f.screen.models.access)
    }

    private fun idle(f: ControllerRegression.Fixture) = progress(f, "idle")
    private fun progress(f: ControllerRegression.Fixture, status: String) {
        f.latest().result(Protocol.`object`("v", 1, "type", "progress", "subscriptionId", f.subscription,
            "sessionId", "s1", "rows", emptyList<Any>(), "status", status))
    }

    private fun choice(id: String, title: String): MutableMap<String, Any> =
        Protocol.`object`("id", id, "title", title, "providerTitle", "PC provider")

    private fun catalog(request: Map<String, Any>, cursor: String? = null, modelRevision: String = revision,
        requestId: Any? = request["requestId"]): MutableMap<String, Any> =
        LinkedHashMap(Protocol.`object`("v", 1, "type", "sessionModels", "requestId", requestId, "sessionId", "s1", "state", "ready",
            "models", listOf(first, next), "current", first, "revision", modelRevision)).apply { if (cursor != null) put("cursor", cursor) }

    private fun reply(request: Map<String, Any>, outcome: String, selected: Map<String, Any>? = null, code: String? = null): MutableMap<String, Any> =
        LinkedHashMap(Protocol.`object`("v", 1, "type", "modelSelected", "requestId", request["requestId"], "sessionId", request["sessionId"],
            "operationId", request["operationId"], "outcome", outcome)).apply {
            if (selected != null) put("selected", selected)
            if (code != null) put("code", code)
        }
}
