package io.harnessy.companion

import io.harnessy.companion.nativeapp.CompanionRepository
import io.harnessy.companion.nativeapp.DraftSubmission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSubmissionBindingTest {
    @Test
    fun staleRenderedTargetsDraftsAndForegroundsCannotAdmitFollowups() {
        val staleCopies: List<(DraftSubmission) -> DraftSubmission> = listOf(
            { it.copy(foregroundGeneration = it.foregroundGeneration - 1) },
            { it.copy(pcId = "different-pc") },
            { it.copy(sessionId = "different-session") },
            { it.copy(text = "previous draft") },
        )
        for (staleCopy in staleCopies) withReadyRepository { repository, platform ->
            repository.sendSubmission(staleCopy(renderedSubmission(repository)))
            platform.pump()
            assertTrue(platform.fences.isEmpty())
            assertNull(platform.latest().last("submitText"))
        }
    }

    @Test
    fun acceptedRenderedFollowupRetainsItsExactSessionAndText() = withReadyRepository { repository, platform ->
        val submission = renderedSubmission(repository)
        repository.sendSubmission(submission)
        platform.pump()
        val request = requireNotNull(platform.latest().last("submitText"))
        assertEquals(submission.sessionId, request["sessionId"])
        assertEquals(submission.text, request["text"])
        assertEquals(submission.sessionId, platform.fences.values.singleOrNull()?.sessionId)
    }

    @Test
    fun aGestureCapturedBeforePauseCannotSendAfterReconnection() = withReadyRepository { repository, platform ->
        val previous = renderedSubmission(repository)
        repository.pauseConnection()
        repository.resumeConnection()
        platform.ready()
        repository.sendSubmission(previous)
        platform.pump()
        assertTrue(platform.fences.isEmpty())
        assertNull(platform.latest().last("submitText"))
    }

    private fun renderedSubmission(repository: CompanionRepository): DraftSubmission {
        val current = repository.state.value
        val screen = requireNotNull(current.screen)
        return DraftSubmission(current.foregroundGeneration, requireNotNull(screen.pc).id,
            requireNotNull(screen.conversation.session).id, current.draft)
    }

    private fun withReadyRepository(test: (CompanionRepository, ControllerRegression.Fixture) -> Unit) {
        val platform = ControllerRegression.Fixture()
        val repository = CompanionRepository(platform.controller)
        try {
            repository.start()
            platform.ready()
            repository.draftChanged("Current native draft")
            test(repository, platform)
        } finally {
            repository.stop()
            platform.pump()
        }
    }
}
