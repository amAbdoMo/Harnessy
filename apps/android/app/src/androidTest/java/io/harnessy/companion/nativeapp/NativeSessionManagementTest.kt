package io.harnessy.companion.nativeapp

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.File
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeSessionManagementTest {
    @get:Rule val compose = createComposeRule()

    private val workspaceA = WorkspaceInfo("workspace-a", "Workspace A (fixture)", 0)
    private val workspaceB = WorkspaceInfo("workspace-b", "Empty registered workspace B (fixture)", 20)
    private val current = row("current", "Current chat")
    private val other = row("other", "Nonselected chat")

    @Test
    fun newChatRequiresExplicitRegisteredWorkspaceAndRecentsRefreshRequiresItsItem() {
        val actions = RecordingActions()
        val workspaces = listOf(workspaceA) + (1..8).map {
            WorkspaceInfo("intermediate-$it", "Registered workspace $it (fixture)", it.toLong())
        } + workspaceB
        render(state(management = ManagementPane(ManagementAccess.ENABLED, workspaces, false, false)), actions)
        openSidebar()
        captureFixture("sidebar", compose.onRoot())
        compose.onNodeWithTag("recents_menu").performClick()
        assertActions(actions)
        compose.onNodeWithTag("refresh_sessions").performClick()
        assertActions(actions, events = listOf("refresh", "refresh-workspaces"))

        compose.onNodeWithTag("new_chat").performClick()
        compose.onNodeWithTag("manage_create_confirm").assertIsNotEnabled()
        assertActions(actions, events = listOf("refresh", "refresh-workspaces"))
        compose.onNodeWithText(workspaceB.title).performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText(workspaceB.title).assertIsSelected()
        compose.onNodeWithTag("manage_create_confirm").assertIsEnabled()
        captureFixture("create", compose.onNodeWithTag("session_management_dialog"))
        assertActions(actions, events = listOf("refresh", "refresh-workspaces"))
        compose.onNodeWithTag("manage_create_confirm").performClick()
        compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        assertActions(actions, listOf(submission(SessionManagementCommand.Create(workspaceB.id))),
            listOf("refresh", "refresh-workspaces"))
    }

    @Test
    fun fullWorkspaceCatalogKeepsItsLastWrappedTitleReachableAndRequiresConfirmation() {
        val actions = RecordingActions()
        val workspaces = (0 until 256).map {
            WorkspaceInfo("catalog-$it", "Registered workspace $it with a long descriptive name / 工作区 (fixture)", it.toLong())
        }
        val target = workspaces.last()
        render(state(management = ManagementPane(ManagementAccess.ENABLED, workspaces, false, false)), actions)
        openSidebar()
        compose.onNodeWithTag("new_chat").performClick()
        compose.onNodeWithTag("manage_create_confirm").assertIsNotEnabled()
        compose.onNodeWithText(target.title).performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithText(target.title).assertIsSelected()
        compose.onNodeWithTag("manage_create_confirm").assertIsEnabled()
        assertActions(actions)
        captureFixture("large-catalog", compose.onNodeWithTag("session_management_dialog"))
        compose.onNodeWithTag("manage_create_confirm").performClick()
        assertActions(actions, listOf(submission(SessionManagementCommand.Create(target.id))))
    }

    @Test
    fun rowEllipsisDoesNotSelectAndRenameKeepsNonselectedTargetAndEditedTitle() {
        val actions = RecordingActions()
        render(state(), actions)
        openSidebar()
        openRowMenu(other.id)
        compose.onNodeWithTag("session_current").assertIsSelected()
        captureFixture("row-menu", compose.onNode(isPopup()))
        assertActions(actions)
        compose.onNodeWithTag("rename_session_${other.id}").performClick()
        compose.onNodeWithTag("manage_target_name").assertTextEquals(other.title)
        compose.onNodeWithTag("manage_rename_input").performScrollTo().performTextReplacement("  Edited nonselected title  ")
        closeSoftKeyboard()
        assertActions(actions)
        compose.onNodeWithTag("manage_rename_confirm").assertIsEnabled()
        captureFixture("rename", compose.onNodeWithTag("session_management_dialog"))
        compose.onNodeWithTag("manage_rename_confirm").performClick()
        compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        compose.onNodeWithTag("session_current").assertIsSelected()
        assertActions(actions, listOf(submission(SessionManagementCommand.Rename(other.id, "Edited nonselected title"))))
    }

    @Test
    fun pinAndUnpinUseRealRowMetadataAndSubmitDesiredStateOnce() {
        val actions = RecordingActions()
        val pinned = row("pinned", "Already pinned chat", pin = 0L)
        render(state(rows = listOf(current, other, pinned)), actions)
        openSidebar()
        val expected = mutableListOf<SessionManagementSubmission>()
        for ((target, desired) in listOf(other to true, pinned to false)) {
            openRowMenu(target.id)
            compose.onNodeWithTag("pin_session_${target.id}")
                .assertTextContains(text(if (desired) R.string.native_manage_pin else R.string.native_manage_unpin))
            assertActions(actions, expected)
            compose.onNodeWithTag("pin_session_${target.id}").performClick()
            expected.add(submission(SessionManagementCommand.Pin(target.id, desired)))
            assertActions(actions, expected)
            compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        }
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_current"))
        compose.onNodeWithTag("session_current").assertIsSelected()
    }

    @Test
    fun busyArchiveCannotStopWorkAndOrdinaryArchiveRequiresConfirmationWithSafeCancel() {
        val actions = RecordingActions()
        val busy = row("busy", "Running chat", status = SessionStatus.BUSY)
        render(state(rows = listOf(current, other, busy)), actions)
        openSidebar()
        openRowMenu(busy.id)
        compose.onNodeWithTag("archive_session_${busy.id}").assertIsNotEnabled()
        // Only Pin, Rename and Archive are offered: no Stop or deferred Delete action.
        compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).assertCountEquals(3)
        compose.onNodeWithTag("archive_session_${busy.id}").performTouchInput { click() }
        compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        assertActions(actions)
        compose.onNode(isPopup()).performKeyInput { pressKey(androidx.compose.ui.input.key.Key.Escape) }

        openRowMenu(other.id)
        compose.onNodeWithTag("archive_session_${other.id}").performClick()
        compose.onNodeWithTag("manage_target_name").assertTextEquals(other.title)
        compose.onNodeWithText(text(R.string.native_manage_archive_explanation)).performScrollTo().assertIsDisplayed()
        assertActions(actions)
        captureFixture("archive", compose.onNodeWithTag("session_management_dialog"))
        compose.onNodeWithTag("manage_cancel").performClick()
        compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        compose.onNodeWithTag("manage_archive_confirm").assertDoesNotExist()
        assertActions(actions)
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_${other.id}"))
        compose.onNodeWithTag("session_${other.id}").assertIsDisplayed()
        compose.onNodeWithTag("close_sessions").performClick()
        compose.onNodeWithText("Preserved answer (fixture)").performScrollTo().assertIsDisplayed()
        assertActions(actions)

        openSidebar()
        openRowMenu(other.id)
        compose.onNodeWithTag("archive_session_${other.id}").performClick()
        compose.onNodeWithTag("manage_archive_confirm").assertIsEnabled().performClick()
        assertActions(actions, listOf(submission(SessionManagementCommand.Archive(other.id))))
    }

    @Test
    fun newChatAndCurrentArchiveKeepActualComposerDraftWithoutAnyCommand() {
        val actions = RecordingActions()
        render(state(draft = "Keep this unsent draft (fixture)"), actions)
        openSidebar()
        compose.onNodeWithTag("new_chat_recents").performClick()
        assertDraftRequired()
        compose.onNodeWithTag("manage_cancel").performClick()
        openRowMenu(current.id)
        compose.onNodeWithTag("archive_session_${current.id}").performClick()
        assertDraftRequired()
        compose.onNodeWithTag("manage_cancel").performClick()
        compose.onNodeWithTag("close_sessions").performClick()
        compose.onNodeWithTag("chat_draft").assertTextEquals("Keep this unsent draft (fixture)")
        compose.onNodeWithTag("send_text").assertIsEnabled()
        compose.onNodeWithText("Preserved answer (fixture)").performScrollTo().assertIsDisplayed()
        assertActions(actions)
    }

    @Test
    fun deniedManagementExplainsPcApprovalAndNeverOffersAPhoneGrant() {
        val actions = RecordingActions()
        render(state(management = ManagementPane(ManagementAccess.DISABLED, emptyList(), false, false)), actions)
        openSidebar()
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_${other.id}"))
        compose.onNodeWithTag("session_menu_${other.id}").assertIsNotEnabled()
        compose.onNodeWithTag("session_menu_${other.id}").performTouchInput { click() }
        compose.onNodeWithTag("rename_session_${other.id}").assertDoesNotExist()
        compose.onNodeWithTag("new_chat").performClick()
        compose.onNodeWithText(text(R.string.native_manage_permission_required)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("manage_create_confirm").assertDoesNotExist()
        compose.onNodeWithTag("manage_workspace_list").assertDoesNotExist()
        compose.onNodeWithTag("manage_cancel").performClick()
        compose.onNodeWithTag("session_menu_${other.id}").assertIsNotEnabled()
        assertActions(actions)
    }

    @Test
    fun retiredForegroundAndChangedPcDismissRenameWithoutSubmitting() {
        val actions = RecordingActions()
        val original = state()
        val replacement = row("replacement", "Replacement selected chat")
        val changedPc = state(pcId = "replacement-pc", rows = listOf(replacement, other), selected = replacement)
        val live = render(original, actions)
        for (next in listOf(original.copy(foregroundGeneration = 42L), changedPc)) {
            compose.runOnIdle { live.value = original }
            openSidebar()
            openRowMenu(other.id)
            compose.onNodeWithTag("rename_session_${other.id}").performClick()
            compose.onNodeWithTag("manage_rename_input").performScrollTo().performTextReplacement("Stale edited title")
            closeSoftKeyboard()
            compose.onNodeWithTag("manage_rename_confirm").assertIsEnabled()
            compose.runOnIdle { live.value = next }
            compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
            compose.onNodeWithTag("manage_rename_confirm").assertDoesNotExist()
            assertActions(actions)
        }
        openSidebar()
        openRowMenu(other.id)
        compose.onNodeWithTag("rename_session_${other.id}").performClick()
        compose.onNodeWithTag("manage_rename_input").performScrollTo().performTextReplacement("Fresh PC title")
        closeSoftKeyboard()
        compose.onNodeWithTag("manage_rename_confirm").assertIsEnabled().performClick()
        assertActions(actions, listOf(SessionManagementSubmission(changedPc.foregroundGeneration, "replacement-pc",
            SessionManagementCommand.Rename(other.id, "Fresh PC title"))))
    }

    private fun captureFixture(name: String, node: SemanticsNodeInteraction) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bitmap = node.captureToImage().asAndroidBitmap()
        val width = context.resources.displayMetrics.widthPixels
        File(requireNotNull(context.getExternalFilesDir(null)), "management-$name-$width.png").outputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }

    private fun assertDraftRequired() {
        compose.onNodeWithText(text(R.string.native_manage_draft_required)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("manage_create_confirm").assertDoesNotExist()
        compose.onNodeWithTag("manage_archive_confirm").assertDoesNotExist()
    }

    private fun openSidebar() {
        if (!compose.onNodeWithTag("new_chat").isDisplayed()) compose.onNodeWithTag("open_sessions").performClick()
        compose.onNodeWithTag("new_chat").assertIsDisplayed()
    }

    private fun openRowMenu(id: String) {
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_$id"))
        compose.onNodeWithTag("session_menu_$id").assertIsDisplayed().performClick()
    }

    private fun render(initial: CompanionState, actions: RecordingActions): MutableState<CompanionState> {
        val live = mutableStateOf(initial)
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeChatScreen(live.value, actions, {}, {})
            }
        }
        return live
    }

    private fun state(
        pcId: String = "fixture-pc",
        rows: List<SessionRow> = listOf(current, other),
        selected: SessionRow = current,
        draft: String = "",
        management: ManagementPane = ManagementPane(ManagementAccess.ENABLED, listOf(workspaceA, workspaceB), false, false),
    ): CompanionState = CompanionState(
        screen = Screen(Pc(pcId, "Fixture PC", Connection.ONLINE),
            SessionPane(rows, selected.id, false, management),
            Conversation(selected, listOf(TextRow("answer", Role.ASSISTANT, "Preserved answer (fixture)")), false),
            Composer(draft, SendState.READY, Feedback.NONE, null), false),
        draft = draft, foreground = true, foregroundGeneration = 41L,
        workspaceExpansion = expandedWorkspaceFixture(pcId, rows.mapNotNull { it.navigation?.workspace?.id }.distinct()),
    )

    private fun row(id: String, title: String, status: SessionStatus = SessionStatus.IDLE, pin: Long? = null) =
        SessionRow(id, title, status, SessionNavigation(workspaceA, pin, 1_700_000_000_000L))

    private fun submission(command: SessionManagementCommand) = SessionManagementSubmission(41L, "fixture-pc", command)

    private fun assertActions(
        actions: RecordingActions,
        submissions: List<SessionManagementSubmission> = emptyList(),
        events: List<String> = emptyList(),
    ) {
        compose.runOnIdle {
            assertEquals(submissions, actions.submissions)
            assertEquals(events, actions.events)
        }
    }

    private fun text(resource: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)

    /** The only fake records outgoing user actions; models, state and Compose components stay real. */
    private class RecordingActions : NativeChatActions {
        override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) { events.add("workspace:$choice") }
        val submissions = mutableListOf<SessionManagementSubmission>()
        val events = mutableListOf<String>()
        override fun manageSession(submission: SessionManagementSubmission) { submissions.add(submission) }
        override fun refreshManagementWorkspaces() { events.add("refresh-workspaces") }
        override fun loadMoreManagementWorkspaces() { events.add("more-workspaces") }
        override fun refreshModels() { events.add("refresh-models") }
        override fun refreshActivationAccess() { events.add("refresh-activation") }
        override fun openSession(submission: SessionOpenSubmission) { events.add("open:$submission") }
        override fun loadNextModels() { events.add("next-models") }
        override fun selectModel(submission: ModelSelectionSubmission) { events.add("model:$submission") }
        override fun sendSubmission(submission: DraftSubmission) { events.add("send:$submission") }
        override fun sendText(text: String) { events.add("send-text:$text") }
        override fun selectSession(sessionId: String) { events.add("select:$sessionId") }
        override fun refresh() { events.add("refresh") }
        override fun showPairing() { events.add("pairing") }
        override fun pairFromLink(link: String) { events.add("enroll:$link") }
        override fun forgetPairing(pcId: String) { events.add("forget:$pcId") }
        override fun draftChanged(draft: String) { events.add("draft:$draft") }
        override fun pairingLinkChanged(link: String) { events.add("link:$link") }
        override fun cancelPairing() { events.add("cancel-pairing") }
        override fun loadMoreSessions() { events.add("more-sessions") }
        override fun loadMoreHistory() { events.add("more-history") }
        override fun resolveUnknown() { events.add("review") }
    }
}
