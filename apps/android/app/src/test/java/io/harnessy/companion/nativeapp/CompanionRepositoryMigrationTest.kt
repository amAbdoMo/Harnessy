package io.harnessy.companion.nativeapp

import io.harnessy.companion.CompanionController
import io.harnessy.companion.CompanionPlatform
import io.harnessy.companion.ControllerLimits
import io.harnessy.companion.presentation.DisplayModels.PairingState
import io.harnessy.companion.protocol.Protocol
import io.harnessy.companion.protocol.StrictJson
import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionRepositoryMigrationTest {
    @Test
    fun savedPairingLoadIsVisibleUntilMetadataReconciliationCompletes() = withRepository { repository, platform ->
        repository.start()
        assertTrue(requireNotNull(repository.state.value.screen).metadataLoading)
        platform.pump()
        assertFalse(requireNotNull(repository.state.value.screen).metadataLoading)
    }

    @Test
    fun typingPublishesDraftBeforeAnyControllerSnapshot() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        assertEquals("", requireNotNull(repository.state.value.screen).composer.draft)

        repository.draftChanged("typed follow-up 界")

        assertEquals("typed follow-up 界", repository.state.value.draft)
        assertEquals("", requireNotNull(repository.state.value.screen).composer.draft)
    }

    @Test
    fun stopDropsInvitationAndDisplayEvenWithImportCompletionQueued() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        repository.draftChanged("RAM-only draft")
        val link = platform.invitation()
        repository.importLink(link)
        assertEquals(link, requireNotNull(repository.state.value.pairing).link)
        assertNotNull(repository.state.value.screen)
        platform.ioQueue.removeFirst().run()
        assertFalse(platform.mainQueue.isEmpty())

        repository.stop()
        assertNull(repository.state.value.screen)
        assertNull(repository.state.value.pairing)
        platform.pump()

        assertFalse(repository.state.value.foreground)
        assertNull(repository.state.value.screen)
        assertNull(repository.state.value.pairing)
        assertEquals("RAM-only draft", repository.state.value.draft)
        repository.start()
        platform.pump()
        assertNull(repository.state.value.pairing)
        assertEquals("RAM-only draft", requireNotNull(repository.state.value.screen).composer.draft)
    }

    @Test
    fun restartAndPausedForegroundPreserveDraftWithoutRestoringInvitation() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        repository.draftChanged("unsent follow-up")
        repository.importLink(platform.invitation())
        platform.pump()
        assertEquals(PairingState.EDITING, requireNotNull(repository.state.value.pairing).state)

        repository.pauseConnection()
        assertTrue(repository.state.value.foreground)
        assertTrue(repository.state.value.connectionPaused)
        assertNull(repository.state.value.screen)
        assertNull(repository.state.value.pairing)
        assertEquals("unsent follow-up", repository.state.value.draft)
        repository.stop()
        repository.start()
        platform.pump()
        assertTrue(repository.state.value.connectionPaused)
        assertNull(repository.state.value.screen)
        repository.draftChanged("edited while paused")
        assertEquals("edited while paused", repository.state.value.draft)

        repository.resumeConnection()
        platform.pump()
        assertFalse(repository.state.value.connectionPaused)
        assertTrue(repository.state.value.foreground)
        assertNull(repository.state.value.pairing)
        assertEquals("edited while paused", repository.state.value.draft)
        assertEquals("edited while paused", requireNotNull(repository.state.value.screen).composer.draft)
    }

    @Test
    fun oversizedAndMalformedDraftsKeepTheLastAcceptedUtf8Input() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        val exactLimit = "界".repeat(2730) + "ab"
        repository.draftChanged(exactLimit)
        assertEquals(exactLimit, repository.state.value.draft)
        assertFalse(repository.state.value.draftRejected)

        for (invalid in listOf("界".repeat(2731), "\uD800")) {
            repository.draftChanged(invalid)
            assertEquals(exactLimit, repository.state.value.draft)
            assertTrue(repository.state.value.draftRejected)
        }
        repository.draftChanged("corrected draft")
        assertEquals("corrected draft", repository.state.value.draft)
        assertFalse(repository.state.value.draftRejected)
    }

    @Test
    fun rejectedInvitationInputCannotEnrollThePreviousValidLink() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        repository.showPairing()
        val accepted = platform.invitation()
        repository.pairingLinkChanged(accepted)
        repository.pairingLinkChanged("界".repeat(1366))
        assertEquals(accepted, requireNotNull(repository.state.value.pairing).link)
        assertEquals(io.harnessy.companion.presentation.DisplayModels.Feedback.PAIRING_INVALID,
            requireNotNull(repository.state.value.pairing).feedback)
        repository.pairFromLink(accepted)
        platform.pump()
        assertEquals(PairingState.EDITING, requireNotNull(repository.state.value.pairing).state)
    }

    @Test
    fun pendingImportCompletionCannotClearRejectedInvitationInput() = withRepository { repository, platform ->
        repository.start()
        platform.pump()
        val accepted = platform.invitation()
        repository.importLink(accepted)
        platform.ioQueue.removeFirst().run()
        repository.pairingLinkChanged("界".repeat(1366))
        platform.pump()
        assertTrue(repository.state.value.pairingRejected)
        assertEquals(io.harnessy.companion.presentation.DisplayModels.Feedback.PAIRING_INVALID,
            requireNotNull(repository.state.value.pairing).feedback)
        repository.pairFromLink(accepted)
        platform.pump()
        assertEquals(PairingState.EDITING, requireNotNull(repository.state.value.pairing).state)
        repository.pairingLinkChanged(accepted)
        assertFalse(repository.state.value.pairingRejected)
    }

    private fun withRepository(test: (CompanionRepository, PreviewPlatform) -> Unit) {
        val platform = PreviewPlatform()
        val repository = CompanionRepository(CompanionController(platform,
            ControllerLimits(intArrayOf(5000, 10000, 20000, 15000, 8, 64, 128, 2, 32, 60000)), "Linked PC"))
        try {
            test(repository, platform)
        } finally {
            repository.stop()
            platform.pump()
        }
    }

    /** Empty external stores; enrollment, writes and network use fail rather than touching the host. */
    private class PreviewPlatform : CompanionPlatform {
        val ioQueue = ArrayDeque<Runnable>()
        val mainQueue = ArrayDeque<Runnable>()
        override fun main(callback: Runnable) { mainQueue.addLast(callback) }
        override fun io(operation: Runnable) { ioQueue.addLast(operation) }
        override fun now() = 1000L
        override fun elapsed() = 1000L
        override fun later(milliseconds: Int, callback: Runnable) = CompanionPlatform.Cancellable { }
        override fun pairings(): List<CompanionPlatform.Paired> = emptyList()
        override fun fences(): List<CompanionPlatform.Fence> = emptyList()
        override fun repairs(): List<CompanionPlatform.Repair> = emptyList()
        override fun identity(alias: String): CompanionPlatform.Identity = unexpected()
        override fun createIdentity(): CompanionPlatform.Identity = unexpected()
        override fun deleteIdentity(alias: String): Unit = unexpected()
        override fun sign(alias: String, transcript: ByteArray): ByteArray = unexpected()
        override fun save(paired: CompanionPlatform.Paired): Unit = unexpected()
        override fun forget(pcId: String): Unit = unexpected()
        override fun putFence(fence: CompanionPlatform.Fence): Unit = unexpected()
        override fun clearFence(expected: CompanionPlatform.Fence): Unit = unexpected()
        override fun repair(pcId: String, alias: String): Unit = unexpected()
        override fun clearRepair(pcId: String): Unit = unexpected()
        override fun connect(inputs: Protocol.Inputs, events: CompanionPlatform.Events): CompanionPlatform.Link = unexpected()
        private fun unexpected(): Nothing = throw AssertionError("Preview must not enroll, send, or mutate external stores")

        fun pump() {
            var steps = 0
            while (ioQueue.isNotEmpty() || mainQueue.isNotEmpty()) {
                check(++steps <= 100) { "Executor work did not settle" }
                if (ioQueue.isNotEmpty()) ioQueue.removeFirst().run()
                if (mainQueue.isNotEmpty()) mainQueue.removeFirst().run()
            }
        }

        fun invitation(): String {
            // Canonical SPKI for the public P-256 generator point; no private key or random fixture state.
            val der = "3059301306072a8648ce3d020106082a8648ce3d03010703420004" +
                "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
                "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
            val spki = Protocol.encodeBase64Url(der.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            val payload = Protocol.`object`("v", 1, "httpsOrigin", "https://relay.example",
                "pcId", Protocol.derivePcId(spki), "pcIdentityKey", spki,
                "invitationId", "invitation-id", "expiresAt", 61000L,
                "secret", Protocol.encodeBase64Url(ByteArray(32) { 7 }))
            return "harnessy://pair#" + Protocol.encodeBase64Url(StrictJson.stringify(payload).toByteArray(Charsets.UTF_8))
        }
    }
}
