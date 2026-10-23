package io.harnessy.companion.protocol

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Java codec parity for the mobile model catalog and selection messages. */
class ModelCodecTest {
    private val requestId = opaqueId(1)
    private val operationId = opaqueId(2)
    private val choiceId = opaqueId(3)
    private val otherChoiceId = opaqueId(4)
    private val revision = opaqueId(5)
    private val cursor = Protocol.encodeBase64Url(ByteArray(32) { 6.toByte() })
    private val sessionId = "session-1"

    @Test
    fun modelRequestBuildersCarryExactWireTokens() {
        val listing = ApplicationCodec.parseRequest(ApplicationCodec.listSessionModels(requestId, sessionId, 2, null))
        assertEquals("listSessionModels", listing["type"])
        assertEquals(requestId, listing["requestId"])
        assertEquals(sessionId, listing["sessionId"])
        assertEquals(2L, Protocol.integer(listing["limit"], 1, ApplicationCodec.MAX_ROWS.toLong()))
        assertNull(listing["cursor"])
        assertEquals(setOf("v", "type", "requestId", "sessionId", "limit"), listing.keys)

        val paged = ApplicationCodec.parseRequest(ApplicationCodec.listSessionModels(requestId, sessionId, 2, cursor))
        assertEquals(cursor, paged["cursor"])
        assertEquals(listing.keys + "cursor", paged.keys)

        val selection = ApplicationCodec.parseRequest(
            ApplicationCodec.selectSessionModel(requestId, operationId, sessionId, revision, choiceId))
        assertEquals("selectSessionModel", selection["type"])
        assertEquals(requestId, selection["requestId"])
        assertEquals(operationId, selection["operationId"])
        assertEquals(sessionId, selection["sessionId"])
        assertEquals(revision, selection["revision"])
        assertEquals(choiceId, selection["choiceId"])
        assertEquals(7, selection.size)
    }

    @Test
    fun catalogPagesExposeTypedChoicesForEveryState() {
        val page = choice(choiceId)
        val other = choice(otherChoiceId, "GPT-5", "OpenAI")
        val variants = listOf(
            catalog("ready", listOf(page), page, revision),
            catalog("ready", listOf(other), page, revision, cursor),
            catalog("ready", emptyList(), null, revision),
            catalog("busy", emptyList(), page),
            catalog("busy", emptyList(), null),
            catalog("denied", emptyList(), null),
            catalog("closed", emptyList(), null)
        )
        for (variant in variants) {
            val parsed = ApplicationCodec.result(json(variant))
            assertEquals(ApplicationCodec.Type.SESSION_MODELS, parsed.type)
            assertEquals(variant["state"], parsed.modelState)
            assertEquals(variant["revision"], parsed.modelRevision)
            assertEquals(variant["cursor"], parsed.cursor)
            assertEquals((variant["models"] as List<*>).size, parsed.modelChoices.size)
            val current = variant["current"] as Map<*, *>?
            assertEquals(current?.get("id"), parsed.currentModel?.id)
            assertEquals(current?.get("title"), parsed.currentModel?.title)
            assertEquals(current?.get("providerTitle"), parsed.currentModel?.providerTitle)
            assertNull(parsed.selectedModel)
        }
        val paged = ApplicationCodec.result(json(variants[1]))
        assertEquals(listOf(otherChoiceId), paged.modelChoices.map { it.id })
        assertEquals(choiceId, paged.currentModel?.id)
        assertThrows(UnsupportedOperationException::class.java) { paged.modelChoices.clear() }
    }

    @Test
    fun selectionOutcomesExposeOnlyTheirOwnState() {
        val applied = ApplicationCodec.result(json(selection("applied", selected = choice(choiceId))))
        assertEquals(ApplicationCodec.Type.MODEL_SELECTED, applied.type)
        assertEquals("applied", applied.outcome)
        assertEquals(choiceId, applied.selectedModel?.id)
        assertEquals("DeepSeek V3", applied.selectedModel?.title)
        assertEquals("DeepSeek", applied.selectedModel?.providerTitle)
        assertNull(applied.code)
        assertNull(applied.currentModel)
        assertNull(applied.modelState)
        assertNull(applied.modelRevision)
        assertTrue(applied.modelChoices.isEmpty())

        for (code in listOf("denied", "expired", "notFound", "busy", "conflict", "limit", "unavailable")) {
            val rejected = ApplicationCodec.result(json(selection("rejected", code = code)))
            assertEquals("rejected", rejected.outcome)
            assertEquals(code, rejected.code)
            assertNull(rejected.selectedModel)
        }

        val unknown = ApplicationCodec.result(json(selection("unknown")))
        assertEquals("unknown", unknown.outcome)
        assertNull(unknown.code)
        assertNull(unknown.selectedModel)
    }

    @Test
    fun catalogAndSelectionRejectMissingAndExtraFields() {
        val variants = listOf(
            catalog("ready", listOf(choice(choiceId)), choice(choiceId), revision),
            catalog("busy", emptyList(), null),
            catalog("denied", emptyList(), null),
            selection("applied", selected = choice(choiceId)),
            selection("rejected", code = "denied"),
            selection("unknown")
        )
        for (variant in variants) {
            for (key in variant.keys.toList()) {
                val missing = LinkedHashMap(variant).apply { remove(key) }
                assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(missing)) }
            }
            val extra = LinkedHashMap(variant).apply { put("provider", "deepseek") }
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(extra)) }
        }
    }

    @Test
    fun refusedAndClosedCatalogsCannotAdvertiseChoicesOrRevisions() {
        val leaks = listOf(
            catalog("busy", listOf(choice(choiceId)), null),
            catalog("busy", emptyList(), null, revision),
            catalog("busy", emptyList(), null, null, cursor),
            catalog("denied", listOf(choice(choiceId)), null),
            catalog("denied", emptyList(), choice(choiceId)),
            catalog("denied", emptyList(), null, revision),
            catalog("denied", emptyList(), null, null, cursor),
            catalog("closed", listOf(choice(choiceId)), null),
            catalog("closed", emptyList(), choice(choiceId)),
            catalog("closed", emptyList(), null, revision),
            catalog("closed", emptyList(), null, null, cursor)
        )
        for (leak in leaks) {
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(leak)) }
        }
    }

    @Test
    fun catalogPagesRejectDuplicateChoiceHandles() {
        val duplicate = catalog("ready", listOf(choice(choiceId), choice(choiceId, "Other", "Other")), null, revision)
        assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(duplicate)) }
        val unique = catalog("ready", listOf(choice(choiceId), choice(otherChoiceId)), null, revision)
        assertEquals(2, ApplicationCodec.result(json(unique)).modelChoices.size)
    }

    @Test
    fun choiceHandlesAndRevisionsMustBeCanonicalSixteenByteTokens() {
        val invalid = listOf("", "A", "deepseek-chat", "model-1", choiceId + "=", choiceId + "+", choiceId + "/",
            Protocol.encodeBase64Url(ByteArray(15) { 7.toByte() }), Protocol.encodeBase64Url(ByteArray(17) { 7.toByte() }))
        for (token in invalid) {
            assertThrows(IllegalArgumentException::class.java) {
                ApplicationCodec.result(json(catalog("ready", listOf(choice(token)), null, revision)))
            }
            assertThrows(IllegalArgumentException::class.java) {
                ApplicationCodec.result(json(catalog("ready", emptyList(), null, token)))
            }
            assertThrows(IllegalArgumentException::class.java) {
                ApplicationCodec.result(json(selection("applied", selected = choice(token))))
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.selectSessionModel(requestId, operationId, sessionId, "model-1", choiceId)
        }
    }

    @Test
    fun selectionOutcomesCannotMixAppliedRejectedAndUnknownState() {
        val selected = choice(choiceId)
        val mixed = listOf(
            selection("applied", code = "denied", selected = selected),
            selection("applied", code = "denied"),
            selection("rejected", code = "denied", selected = selected),
            selection("rejected", code = "unsupported"),
            selection("unknown", code = "busy"),
            selection("unknown", selected = selected),
            selection("unknown", code = "busy", selected = selected)
        )
        for (message in mixed) {
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(json(message)) }
        }
    }

    @Test
    fun catalogPagesEnforceLabelCountUnicodeAndEnvelopeBounds() {
        val atLimit = choice(choiceId, "a".repeat(ApplicationCodec.MAX_TITLE_BYTES))
        ApplicationCodec.result(json(catalog("ready", listOf(atLimit), null, revision)))
        val overLimit = choice(choiceId, "a".repeat(ApplicationCodec.MAX_TITLE_BYTES + 1))
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.result(json(catalog("ready", listOf(overLimit), null, revision)))
        }
        val multibyte = choice(choiceId, "界".repeat(ApplicationCodec.MAX_TITLE_BYTES / 3))
        ApplicationCodec.result(json(catalog("ready", listOf(multibyte), null, revision)))
        val multibyteOver = choice(choiceId, "界".repeat(ApplicationCodec.MAX_TITLE_BYTES / 3 + 1))
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.result(json(catalog("ready", listOf(multibyteOver), null, revision)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.result(json(catalog("ready", listOf(choice(choiceId, "", "DeepSeek")), null, revision)))
        }

        val page = (0 until ApplicationCodec.MAX_ROWS).map { choice(opaqueId(7 + it)) }
        assertEquals(ApplicationCodec.MAX_ROWS, ApplicationCodec.result(json(catalog("ready", page, null, revision))).modelChoices.size)
        val overflow = (0 until (ApplicationCodec.MAX_ROWS + 1)).map { choice(opaqueId(7 + it)) }
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationCodec.result(json(catalog("ready", overflow, null, revision)))
        }

        val compact = json(catalog("ready", listOf(choice(choiceId)), null, revision))
        val padded = compact + " ".repeat(ApplicationCodec.MAX_JSON_BYTES - compact.toByteArray(StandardCharsets.UTF_8).size)
        ApplicationCodec.result(padded)
        assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(padded + " ") }

        for (surrogate in listOf("\\ud800", "\\udc00")) {
            val broken = json(catalog("ready", listOf(choice(choiceId, "T", "P")), null, revision))
                .replace("\"title\":\"T\"", "\"title\":\"$surrogate\"")
            assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.result(broken) }
        }
    }

    @Test
    fun legacySessionRepliesRemainAccepted() {
        val legacy = ApplicationCodec.result(json(linkedMapOf<String, Any?>(
            "v" to 1, "type" to "sessions", "requestId" to requestId,
            "sessions" to listOf(linkedMapOf<String, Any?>(
                "sessionId" to sessionId, "title" to "聊天 😀", "status" to "idle")))))
        assertEquals(ApplicationCodec.Type.SESSIONS, legacy.type)
        assertEquals(1, legacy.sessions.size)
        assertNull(legacy.modelState)
        assertNull(legacy.modelRevision)
        assertNull(legacy.currentModel)
        assertNull(legacy.selectedModel)
        assertTrue(legacy.modelChoices.isEmpty())

        val legacyRequest = linkedMapOf<String, Any?>(
            "v" to 1, "type" to "listSessions", "requestId" to requestId, "limit" to 1, "revision" to revision)
        assertThrows(IllegalArgumentException::class.java) { ApplicationCodec.parseRequest(json(legacyRequest)) }
    }

    private fun opaqueId(fill: Int): String = Protocol.encodeBase64Url(ByteArray(16) { fill.toByte() })

    private fun choice(id: String, title: String = "DeepSeek V3", providerTitle: String = "DeepSeek"): Map<String, Any?> =
        linkedMapOf("id" to id, "title" to title, "providerTitle" to providerTitle)

    private fun catalog(
        state: String,
        models: List<Map<String, Any?>> = emptyList(),
        current: Map<String, Any?>? = null,
        revision: String? = null,
        cursor: String? = null
    ): Map<String, Any?> {
        val row = linkedMapOf<String, Any?>(
            "v" to 1, "type" to "sessionModels", "requestId" to requestId, "sessionId" to sessionId,
            "state" to state, "models" to models, "current" to current)
        if (revision != null) row["revision"] = revision
        if (cursor != null) row["cursor"] = cursor
        return row
    }

    private fun selection(
        outcome: String,
        code: String? = null,
        selected: Map<String, Any?>? = null
    ): Map<String, Any?> {
        val row = linkedMapOf<String, Any?>(
            "v" to 1, "type" to "modelSelected", "requestId" to requestId, "operationId" to operationId,
            "sessionId" to sessionId, "outcome" to outcome)
        if (code != null) row["code"] = code
        if (selected != null) row["selected"] = selected
        return row
    }

    private fun json(wire: Map<String, Any?>): String = StrictJson.stringify(wire)
}
