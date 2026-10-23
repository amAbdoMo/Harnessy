package io.harnessy.companion

import io.harnessy.companion.nativeapp.CompanionRepository
import io.harnessy.companion.nativeapp.SessionManagementCommand
import io.harnessy.companion.nativeapp.SessionManagementSubmission
import io.harnessy.companion.presentation.DisplayModels.ManagementAccess
import io.harnessy.companion.protocol.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeManagementSubmissionTest {
    @Test
    fun staleForegroundAndPcCannotAdmitAnyManagementCommand() {
        for (command in commands()) {
            for (change in listOf<(SessionManagementSubmission) -> SessionManagementSubmission>(
                { it.copy(foregroundGeneration = it.foregroundGeneration - 1) },
                { it.copy(pcId = "another-pc") },
            )) withRepository { repository, platform ->
                repository.manageSession(change(submission(repository, command)))
                assertNoMutation(platform)
            }
        }
    }

    @Test
    fun createRequiresAnApprovedWorkspaceAndAnEmptyAcceptedDraft() {
        for (scenario in listOf("missing-workspace", "nonempty-draft", "rejected-draft")) {
            withRepository { repository, platform ->
                val workspace = if (scenario == "missing-workspace") "missing" else "w1"
                when (scenario) {
                    "nonempty-draft" -> repository.draftChanged("unsent draft")
                    "rejected-draft" -> repository.draftChanged("\uD800")
                }
                repository.manageSession(submission(repository, SessionManagementCommand.Create(workspace)))
                assertNoMutation(platform)
                if (scenario == "rejected-draft") {
                    assertEquals("", repository.state.value.draft)
                    assertTrue(repository.state.value.draftRejected)
                    repository.draftChanged("")
                    repository.manageSession(submission(repository, SessionManagementCommand.Create("w1")))
                    platform.pump()
                    assertNotNull(platform.latest().last("createSession"))
                }
            }
        }
    }

    @Test
    fun managementCommandsKeepExactTargetsTitlesAndDesiredPinState() {
        val cases = listOf(
            SessionManagementCommand.Create("w1") to "createSession",
            SessionManagementCommand.Rename("s1", "  Exact title 界  ") to "renameSession",
            SessionManagementCommand.Archive("s1") to "archiveSession",
            SessionManagementCommand.Pin("s1", true) to "setSessionPinned",
            SessionManagementCommand.Pin("s1", false) to "setSessionPinned",
        )
        for ((command, type) in cases) withRepository { repository, platform ->
            repository.manageSession(submission(repository, command))
            platform.pump()
            val request = requireNotNull(platform.latest().last(type))
            val fence = platform.fences.values.single()
            assertEquals(type, fence.kind.wireName)
            assertEquals(request["operationId"], fence.operationId)
            assertEquals(request["sessionId"], fence.sessionId)
            when (command) {
                is SessionManagementCommand.Create -> {
                    assertEquals("w1", request["workspaceId"])
                    assertEquals("mobile-" + request["operationId"], request["sessionId"])
                }
                is SessionManagementCommand.Rename -> {
                    assertEquals(command.sessionId, request["sessionId"])
                    assertEquals(command.title, request["title"])
                }
                is SessionManagementCommand.Archive -> assertEquals(command.sessionId, request["sessionId"])
                is SessionManagementCommand.Pin -> {
                    assertEquals(command.sessionId, request["sessionId"])
                    assertEquals(command.pinned, request["pinned"])
                }
            }
            assertNull(platform.latest().last("submitText"))
        }
    }

    @Test
    fun malformedAndOversizedTitlesDoNotCreateDeliveryIntent() {
        for (title in listOf("\uD800", "界".repeat(342))) withRepository { repository, platform ->
            repository.manageSession(submission(repository, SessionManagementCommand.Rename("s1", title)))
            assertNoMutation(platform)
        }
    }

    @Test
    fun sessionCommandsRejectTargetsAbsentFromTheCurrentListing() {
        for (command in listOf(
            SessionManagementCommand.Rename("absent", "Title"),
            SessionManagementCommand.Archive("absent"),
            SessionManagementCommand.Pin("absent", true),
        )) withRepository { repository, platform ->
            repository.manageSession(submission(repository, command))
            assertNoMutation(platform)
        }
    }

    @Test
    fun aPreviouslyListedTargetCannotBeManagedAfterRefreshRemovesIt() = withRepository { repository, platform ->
        val captured = submission(repository, SessionManagementCommand.Pin("s1", true))
        repository.refresh()
        platform.sessions(listOf(row("s2", "closed")), null)
        repository.manageSession(captured)
        assertNoMutation(platform)
    }

    @Test
    fun archiveRejectsBusyRowsAndTheSelectedRowsNonemptyDraft() {
        withRepository { repository, platform ->
            repository.manageSession(submission(repository, SessionManagementCommand.Archive("s3")))
            assertNoMutation(platform)
        }
        withRepository { repository, platform ->
            repository.selectSession("s2")
            platform.historyPage(emptyList<Any>(), null)
            repository.draftChanged("Keep this draft")
            repository.manageSession(submission(repository, SessionManagementCommand.Archive("s2")))
            assertNoMutation(platform)
            assertEquals("Keep this draft", repository.state.value.draft)
        }
    }

    @Test
    fun archivingAnUnselectedRowDoesNotDiscardTheSelectedDraft() = withRepository { repository, platform ->
        repository.selectSession("s2")
        platform.historyPage(emptyList<Any>(), null)
        repository.draftChanged("Keep the selected draft")
        repository.manageSession(submission(repository, SessionManagementCommand.Archive("s1")))
        platform.pump()
        assertNotNull(platform.latest().last("archiveSession"))
        assertEquals("Keep the selected draft", repository.state.value.draft)
    }

    @Test
    fun renameAndPinDoNotRequireClearingTheCurrentDraft() {
        for (command in listOf(
            SessionManagementCommand.Rename("s1", "New title"), SessionManagementCommand.Pin("s1", true),
        )) withRepository { repository, platform ->
            repository.draftChanged("Keep this draft")
            repository.manageSession(submission(repository, command))
            platform.pump()
            assertEquals(1, platform.fences.size)
            assertEquals("Keep this draft", repository.state.value.draft)
        }
    }

    @Test
    fun checkingDisabledAndUnavailableAccessCannotAdmitCommands() {
        for (access in listOf(ManagementAccess.CHECKING, ManagementAccess.DISABLED, ManagementAccess.UNAVAILABLE)) {
            withRepository(access) { repository, platform ->
                assertEquals(access, requireNotNull(repository.state.value.screen).sessions.management.access)
                for (command in commands()) repository.manageSession(submission(repository, command))
                assertNoMutation(platform)
            }
        }
    }

    @Test
    fun explicitRefreshCanRecoverDisabledAndUnavailableCatalogs() {
        for (access in listOf(ManagementAccess.DISABLED, ManagementAccess.UNAVAILABLE)) {
            withRepository(access) { repository, platform ->
                val before = platform.latest().requests.count { it["type"] == "listManagementWorkspaces" }
                repository.refreshManagementWorkspaces()
                assertEquals(before + 1, platform.latest().requests.count { it["type"] == "listManagementWorkspaces" })
                workspaces(platform)
                assertEquals(ManagementAccess.ENABLED, requireNotNull(repository.state.value.screen).sessions.management.access)
            }
        }
    }

    @Test
    fun pendingWorkspaceReadAndMutationBlockFurtherCommands() {
        withRepository { repository, platform ->
            repository.refreshManagementWorkspaces()
            assertTrue(requireNotNull(repository.state.value.screen).sessions.management.busy)
            for (command in commands()) repository.manageSession(submission(repository, command))
            assertNoMutation(platform)
        }
        withRepository { repository, platform ->
            repository.manageSession(submission(repository, SessionManagementCommand.Pin("s1", true)))
            platform.pump()
            val first = requireNotNull(platform.latest().last("setSessionPinned"))
            for (command in commands()) repository.manageSession(submission(repository, command))
            platform.pump()
            assertEquals(first, platform.latest().last("setSessionPinned"))
            assertEquals(1, platform.latest().requests.count { it["type"] == "setSessionPinned" })
            assertNull(platform.latest().last("createSession"))
            assertNull(platform.latest().last("renameSession"))
            assertNull(platform.latest().last("archiveSession"))
        }
    }

    @Test
    fun offlinePausedAndStoppedOwnersCannotManageOrReadWorkspaces() {
        for (retire in listOf<(CompanionRepository, ControllerRegression.Fixture) -> Unit>(
            { _, platform -> platform.latest().events.disconnected() },
            { repository, _ -> repository.pauseConnection() },
            { repository, _ -> repository.stop() },
        )) withRepository { repository, platform ->
            val captured = commands().map { submission(repository, it) }
            val link = platform.latest()
            retire(repository, platform)
            val before = link.requests.size
            for (command in captured) repository.manageSession(command)
            repository.refreshManagementWorkspaces()
            repository.loadMoreManagementWorkspaces()
            assertNoMutation(platform)
            assertEquals(before, link.requests.size)
        }
    }

    @Test
    fun aGestureFromBeforePauseCannotManageAfterTheNewForegroundConnects() = withRepository { repository, platform ->
        val captured = submission(repository, SessionManagementCommand.Pin("s1", true))
        repository.pauseConnection()
        repository.resumeConnection()
        platform.pump()
        platform.advance(5000)
        platform.confirm()
        platform.sessions(rows(), null)
        repository.refreshManagementWorkspaces()
        workspaces(platform)
        repository.manageSession(captured)
        assertNoMutation(platform)
    }

    @Test
    fun workspacePagingUsesItsOwnCursorAndSuppressesDuplicateReads() = withRepository { repository, platform ->
        assertTrue(requireNotNull(repository.state.value.screen).sessions.management.canLoadMore)
        repository.loadMoreManagementWorkspaces()
        val page = requireNotNull(platform.latest().last("listManagementWorkspaces"))
        assertEquals("cGFnZQ", page["cursor"])
        val pendingCount = platform.latest().requests.size
        repository.loadMoreManagementWorkspaces()
        repository.refreshManagementWorkspaces()
        assertEquals(pendingCount, platform.latest().requests.size)
        workspaces(platform, "w2", null)
        assertEquals(listOf("w1", "w2"), requireNotNull(repository.state.value.screen).sessions.management.workspaces.map { it.id })
        assertFalse(requireNotNull(repository.state.value.screen).sessions.management.canLoadMore)
        repository.loadMoreManagementWorkspaces()
        assertEquals(pendingCount, platform.latest().requests.size)
        repository.refreshManagementWorkspaces()
        val refresh = requireNotNull(platform.latest().last("listManagementWorkspaces"))
        assertFalse(refresh.containsKey("cursor"))
        workspaces(platform, "w2", null)
        assertEquals(listOf("w2"), requireNotNull(repository.state.value.screen).sessions.management.workspaces.map { it.id })
    }

    private fun commands(): List<SessionManagementCommand> = listOf(
        SessionManagementCommand.Create("w1"), SessionManagementCommand.Rename("s1", "Title"),
        SessionManagementCommand.Archive("s1"), SessionManagementCommand.Pin("s1", true),
    )

    private fun submission(repository: CompanionRepository, command: SessionManagementCommand): SessionManagementSubmission {
        val current = repository.state.value
        return SessionManagementSubmission(current.foregroundGeneration, requireNotNull(current.screen?.pc).id, command)
    }

    private fun assertNoMutation(platform: ControllerRegression.Fixture) {
        platform.pump()
        assertTrue(platform.fences.isEmpty())
        for (type in listOf("createSession", "renameSession", "archiveSession", "setSessionPinned", "submitText")) {
            assertNull(type, platform.latest().last(type))
        }
    }

    private fun row(id: String, status: String): Map<String, Any> =
        mapOf("sessionId" to id, "title" to "Session $id", "status" to status)

    private fun rows() = listOf(row("s1", "idle"), row("s2", "closed"), row("s3", "running"))

    private fun workspaces(platform: ControllerRegression.Fixture, workspaceId: String = "w1", cursor: String? = "cGFnZQ") {
        val request = requireNotNull(platform.latest().last("listManagementWorkspaces"))
        val response = Protocol.`object`("v", 1, "type", "managementWorkspaces", "requestId", request["requestId"],
            "enabled", true, "workspaces", listOf(Protocol.`object`("id", workspaceId, "title", "Workspace $workspaceId",
                "order", if (workspaceId == "w1") 0 else 1))).toMutableMap()
        if (cursor != null) response["cursor"] = cursor
        platform.latest().result(response)
    }

    private fun withRepository(
        access: ManagementAccess = ManagementAccess.ENABLED,
        test: (CompanionRepository, ControllerRegression.Fixture) -> Unit,
    ) {
        val platform = ControllerRegression.Fixture()
        val repository = CompanionRepository(platform.controller)
        try {
            repository.start()
            platform.pump()
            platform.confirm()
            platform.sessions(rows(), null)
            repository.refreshManagementWorkspaces()
            val request = requireNotNull(platform.latest().last("listManagementWorkspaces"))
            when (access) {
                ManagementAccess.CHECKING -> Unit
                ManagementAccess.DISABLED -> platform.latest().result(Protocol.`object`("v", 1,
                    "type", "managementWorkspaces", "requestId", request["requestId"], "enabled", false,
                    "workspaces", emptyList<Any>()))
                ManagementAccess.UNAVAILABLE -> platform.latest().result(Protocol.`object`("v", 1, "type", "error",
                    "requestId", request["requestId"], "code", "unavailable"))
                ManagementAccess.ENABLED -> workspaces(platform)
            }
            test(repository, platform)
        } finally {
            repository.stop()
            platform.pump()
        }
    }
}
