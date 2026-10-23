package io.harnessy.companion.nativeapp

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.presentation.DisplayModels.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Covers the drawer and composer surface treatment that the reference design introduced. */
@RunWith(AndroidJUnit4::class)
class NativeSurfaceTreatmentTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var inputMode: InputModeManager

    private val workspace = WorkspaceInfo("workspace-a", "Workspace A (fixture)", 0)
    private val current = SessionRow("current", "Current chat", SessionStatus.IDLE,
        SessionNavigation(workspace, null, 1_700_000_000_000L))
    private val other = SessionRow("other", "Nonselected chat", SessionStatus.IDLE)

    @Test
    fun navigationAndComposerRetainDraftSelectionAndUnclippedHeaderActions() {
        val actions = RecordingActions()
        render(state(foreground = true), actions)
        compose.onNodeWithTag("composer_shell").assertIsDisplayed()
        compose.onNodeWithTag("chat_draft").assertTextEquals("Draft (fixture)")
        compose.onNodeWithTag("send_text").assertIsDisplayed().assertIsEnabled()
        capture("chat", compose.onRoot())

        openNavigation()
        compose.onNodeWithTag("sidebar_search").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("close_sessions").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("new_chat").assertIsDisplayed().assertIsEnabled()
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
        compose.onNodeWithTag("session_current").assertIsSelected()
        val config = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration
        if (config.screenWidthDp < 600 && config.screenWidthDp * 0.8f >= 320 && config.fontScale <= 1f) {
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithTag("sidebar_wordmark").assertTextEquals("Harnessy")
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertFalse("The phone wordmark must fit beside search and close", layouts.single().hasVisualOverflow)
        }
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
        capture("drawer", compose.onRoot())
    }

    @Test
    fun sidebarControlsRefuseEveryGestureWhileTheAppIsNotInTheForeground() {
        val actions = RecordingActions()
        render(state(foreground = false), actions)
        openNavigation()
        compose.onNodeWithTag("sidebar_search").assertIsDisplayed().assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithTag("new_chat").assertIsDisplayed().assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun hoveringAndFocusingAChatShowsFeedbackWithoutSelectingUntilEnter() {
        val actions = RecordingActions()
        render(state(foreground = true), actions)
        openNavigation()
        val row = compose.onNodeWithTag("session_other")
        val idleColor = row.captureToImage().asAndroidBitmap().getPixel(2, 2)
        row.performMouseInput { enter(center) }
        val hoverColor = row.captureToImage().asAndroidBitmap().getPixel(2, 2)
        assertNotEquals("Hover must visibly distinguish the row", idleColor, hoverColor)
        capture("hover", compose.onRoot())
        row.performMouseInput { exit() }
        val originalMode = compose.runOnIdle { inputMode.inputMode }
        try {
            compose.runOnIdle { assertTrue(inputMode.requestInputMode(InputMode.Keyboard)) }
            row.performSemanticsAction(SemanticsActions.RequestFocus) { it() }
            row.assertIsFocused()
            val focusColor = row.captureToImage().asAndroidBitmap().getPixel(2, 2)
            assertNotEquals("Keyboard focus must remain visible without a ripple", idleColor, focusColor)
            capture("focus", compose.onRoot())
            compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
            row.performKeyInput { keyDown(Key.Enter); keyUp(Key.Enter) }
            compose.runOnIdle { assertEquals(listOf("select:other"), actions.events) }
        } finally {
            compose.runOnIdle { inputMode.requestInputMode(originalMode) }
        }
    }

    @Test
    fun renamingFromTheDrawerKeepsTheSelectedConversationAndTheDraft() {
        val actions = RecordingActions()
        render(state(foreground = true), actions)
        openNavigation()
        compose.onNodeWithTag("session_menu_other").assertIsDisplayed().performClick()
        compose.onNodeWithTag("rename_session_other").performClick()
        compose.onNodeWithTag("manage_rename_input").performScrollTo().performTextReplacement("Renamed (fixture)")
        closeSoftKeyboard()
        compose.onNodeWithTag("manage_rename_confirm").assertIsEnabled().performClick()
        compose.onNodeWithTag("session_management_dialog").assertDoesNotExist()
        compose.onNodeWithTag("chat_draft").assertTextEquals("Draft (fixture)")
        compose.runOnIdle {
            assertEquals(listOf("rename:other:Renamed (fixture):fixture-pc:41"), actions.events)
        }
    }

    /** A wide layout shows the navigation rail already; a phone layout opens it from the top bar. */
    private fun openNavigation() {
        val wide = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp >= 600
        if (!wide) compose.onNodeWithTag("open_sessions").performClick()
    }

    private fun capture(name: String, node: androidx.compose.ui.test.SemanticsNodeInteraction) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val bitmap = node.captureToImage().asAndroidBitmap()
        val width = context.resources.displayMetrics.widthPixels
        File(requireNotNull(context.getExternalFilesDir(null)), "surface-$name-$width.png").outputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }

    private fun render(initial: CompanionState, actions: RecordingActions) {
        val theme = when (InstrumentationRegistry.getArguments().getString("surfaceTheme")) {
            "dark" -> ThemePreference.DARK
            "light" -> ThemePreference.LIGHT
            else -> ThemePreference.SYSTEM
        }
        compose.setContent {
            inputMode = LocalInputModeManager.current
            NativeTheme(theme) {
                NativeChatScreen(initial, actions, openSettings = {}, resumeConnection = {})
            }
        }
    }

    private fun state(foreground: Boolean): CompanionState {
        val screen = Screen(Pc("fixture-pc", "Fixture PC", Connection.ONLINE),
            SessionPane(listOf(current, other), current.id, false,
                ManagementPane(ManagementAccess.ENABLED, listOf(workspace), false, false)),
            Conversation(current, listOf(TextRow("answer", Role.ASSISTANT, "Preserved answer (fixture)")), false),
            Composer("Draft (fixture)", SendState.READY, Feedback.NONE, null), false)
        return CompanionState(screen = screen, draft = "Draft (fixture)", foreground = foreground,
            foregroundGeneration = 41L, workspaceExpansion = expandedWorkspaceFixture("fixture-pc", listOf(workspace.id)))
    }

    /** Records only the outgoing management gestures; models, state and Compose components stay real. */
    private class RecordingActions : NativeChatActions {
        override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) { events.add("workspace:$choice") }
        val events = mutableListOf<String>()
        override fun manageSession(submission: SessionManagementSubmission) {
            val command = submission.command
            events.add("rename:${(command as SessionManagementCommand.Rename).sessionId}:" +
                "${command.title}:${submission.pcId}:${submission.foregroundGeneration}")
        }
        override fun refreshManagementWorkspaces() { events.add("refresh-workspaces") }
        override fun loadMoreManagementWorkspaces() { events.add("more-workspaces") }
        override fun refreshModels() { events.add("refresh-models") }
        override fun refreshActivationAccess() { events.add("refresh-activation") }
        override fun openSession(submission: SessionOpenSubmission) { events.add("open:$submission") }
        override fun loadNextModels() { events.add("next-models") }
        override fun selectModel(submission: ModelSelectionSubmission) { events.add("model:$submission") }
        override fun sendSubmission(submission: DraftSubmission) { events.add("send:${submission.text}") }
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
