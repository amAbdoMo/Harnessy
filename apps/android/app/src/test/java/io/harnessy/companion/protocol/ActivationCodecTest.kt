package io.harnessy.companion.protocol

import org.junit.Assert.*
import org.junit.Test

/** Exact Java request/result validation for the phone activation protocol. */
class ActivationCodecTest {
    private val requestId = Protocol.encodeBase64Url(ByteArray(16) { 1 })
    private val operationId = Protocol.encodeBase64Url(ByteArray(16) { 2 })

    @Test fun permissionReadAndFencedOpeningCarryDistinctExactFields() {
        assertEquals(setOf("v", "type", "requestId"), ApplicationCodec.parseRequest(
            ApplicationCodec.getSessionActivation(requestId)).keys)
        val request = ApplicationCodec.parseRequest(ApplicationCodec.openSession(requestId, operationId, "cold-chat-a"))
        assertEquals("openSession", request["type"])
        assertEquals(operationId, request["operationId"])
        assertEquals("cold-chat-a", request["sessionId"])
        assertEquals(setOf("v", "type", "requestId", "operationId", "sessionId"), request.keys)
    }

    @Test fun approvedAppliedResultsRequireTheOriginalNonclosedChatAndNavigation() {
        val parsed = ApplicationCodec.result(json(applied()))
        assertEquals(ApplicationCodec.Type.SESSION_OPENED, parsed.type)
        assertEquals("cold-chat-a", parsed.session.sessionId)
        assertEquals(operationId, parsed.operationId)
        for (session in listOf(session("other-chat"), session(status = "closed"),
            Protocol.`object`("sessionId", "cold-chat-a", "title", "Chat", "status", "idle"))) {
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(applied(session))) }
        }
    }

    @Test fun uncertainAndRejectedResultsCannotSmuggleAnAppliedSession() {
        for (outcome in listOf("unknown", "rejected")) {
            val wire = common(outcome).apply { if (outcome == "rejected") put("code", "denied") }
            assertEquals(outcome, ApplicationCodec.result(json(wire)).outcome)
            wire["session"] = session()
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(wire)) }
        }
    }

    @Test fun permissionRequiresAnExplicitBooleanAndCannotGrantAnotherCapability() {
        for (enabled in listOf(false, true)) {
            val wire = LinkedHashMap(Protocol.`object`("v", 1, "type", "sessionActivation", "requestId", requestId, "enabled", enabled))
            assertEquals(enabled, ApplicationCodec.result(json(wire)).enabled)
            wire["modelSelection"] = true
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(wire)) }
        }
        for (enabled in listOf(null, "true", 1)) assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.result(json(Protocol.`object`("v", 1, "type", "sessionActivation", "requestId", requestId, "enabled", enabled)))
        }
    }

    private fun common(outcome: String) = LinkedHashMap(Protocol.`object`("v", 1, "type", "sessionOpened", "requestId", requestId,
        "operationId", operationId, "sessionId", "cold-chat-a", "outcome", outcome))
    private fun session(id: String = "cold-chat-a", status: String = "idle") = Protocol.`object`("sessionId", id,
        "title", "Chat", "status", status, "navigation", Protocol.`object`("workspace", null, "pinOrder", null, "updatedAt", 1))
    private fun applied(session: Map<String, Any> = session()) = common("applied").apply { put("session", session) }
    private fun json(wire: Map<String, Any>) = StrictJson.stringify(wire).toByteArray(Charsets.UTF_8)
}
