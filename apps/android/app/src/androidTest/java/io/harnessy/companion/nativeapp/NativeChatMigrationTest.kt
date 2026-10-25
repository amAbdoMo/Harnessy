package io.harnessy.companion.nativeapp

import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.BuildConfig
import io.harnessy.companion.R
import org.junit.Assume.assumeTrue
import org.junit.Assume.assumeFalse
import android.graphics.Bitmap
import java.io.File
import io.harnessy.companion.presentation.DisplayModels.*
import io.harnessy.companion.presentation.ModelAccess
import io.harnessy.companion.presentation.ModelFeedback
import io.harnessy.companion.presentation.ModelOption
import io.harnessy.companion.presentation.ModelSelectionPane
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeChatMigrationTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun unpairedStateOffersLinkPcInsteadOfComposer() {
        val actions = RecordingActions()
        val screen = Screen(null, SessionPane(emptyList(), null, false),
            Conversation(null, emptyList(), false), Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false)
        render(CompanionState(screen = screen, foreground = true), actions)

        compose.onNodeWithTag("link_pc").performScrollTo().assertIsDisplayed().assertIsEnabled()
            .assertTextContains(text(R.string.pair_pc))
        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("link_pc").performClick()
        compose.runOnIdle { assertEquals(listOf("pairing"), actions.events) }
    }

    @Test
    fun deliveryUnknownBlocksSendAndRequiresExplicitReview() {
        val actions = RecordingActions()
        val review = DeliveryReview("original-pc", "s1", "original-submission")
        render(pairedState(SendState.DELIVERY_UNKNOWN, review), actions)

        compose.onNodeWithTag("send_text").assertIsNotEnabled()
        compose.onNodeWithTag("review_delivery").performScrollTo().assertIsDisplayed().assertIsEnabled()
            .assertTextContains(text(R.string.resolve_unknown))
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("send_text").performTouchInput { click() }
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
        compose.onNodeWithTag("review_delivery").performClick()
        compose.runOnIdle { assertEquals(listOf("review"), actions.events) }
        compose.onNodeWithTag("send_text").assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
        compose.runOnIdle { assertEquals(listOf("review"), actions.events) }
    }

    @Test
    fun busySessionWithReadyComposerAllowsExplicitQueuedFollowup() {
        val actions = RecordingActions()
        render(pairedState(SendState.READY), actions)

        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
        compose.onNodeWithTag("send_text").assertIsDisplayed().assertIsEnabled()
            .assertContentDescriptionEquals(text(R.string.send))
        compose.onNodeWithTag("review_delivery").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("send_text").performClick()
        compose.runOnIdle { assertEquals(listOf("send:queued follow-up"), actions.events) }
    }

    @Test
    fun noSelectionKeepsRecentChatsWithoutComposerHelperOrSessionChip() {
        val actions = RecordingActions()
        val session = SessionRow("s1", "Existing conversation", SessionStatus.IDLE)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE),
            SessionPane(listOf(session), null, false), Conversation(null, emptyList(), false),
            Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false)
        render(CompanionState(screen = screen, foreground = true), actions)

        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("composer_shell").assertIsDisplayed()
        compose.onNodeWithTag("send_text").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithTag("recent_session_s1").assertIsDisplayed()
        val wide = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp >= 600
        compose.onNodeWithTag("choose_conversation").assertDoesNotExist()
        compose.onNodeWithTag("composer_hint").assertDoesNotExist()
        compose.onNodeWithTag("choose_model").assertIsDisplayed().assertIsNotEnabled()
        if (!wide) compose.onNodeWithTag("open_sessions").performClick()
        compose.onNodeWithTag("session_search").assertDoesNotExist()
        compose.onNodeWithTag("sidebar_search").assertIsDisplayed()
        compose.onNodeWithTag("session_s1").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun modelSelectorShowsPcChoicesAndSubmitsOnlyTheRenderedOfferWithoutSendingTheDraft() {
        assumeTrue(BuildConfig.PC_MODEL_SELECTION)
        val actions = RecordingActions()
        val session = SessionRow("s1", "Existing conversation", SessionStatus.IDLE)
        val first = ModelOption("AQEBAQEBAQEBAQEBAQEBAQ", "Current PC model", "PC provider")
        val next = ModelOption("AgICAgICAgICAgICAgICAg", "Next PC model", "Another provider")
        val revision = "AwMDAwMDAwMDAwMDAwMDAw"
        val pane = ModelSelectionPane(ModelAccess.READY, listOf(first, next), first, revision, null, ModelFeedback.NONE)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE), SessionPane(listOf(session), session.id, false),
            Conversation(session, emptyList(), false), Composer("Keep this draft", SendState.READY, Feedback.NONE, null), false, pane)
        render(CompanionState(screen = screen, draft = "Keep this draft", foreground = true, foregroundGeneration = 45L), actions)

        compose.onNodeWithTag("choose_conversation").assertDoesNotExist()
        compose.onNodeWithTag("composer_hint").assertDoesNotExist()
        compose.onNodeWithTag("choose_model").assertTextContains(first.title).assertIsEnabled().performClick()
        compose.onNodeWithTag("model_dialog").assertIsDisplayed()
        compose.onNodeWithTag("model_choice:${first.id}").assertIsSelected()
        captureModelDialog("ready")
        compose.onNodeWithTag("model_choice:${next.id}").assertIsDisplayed().performClick()
        compose.onNodeWithTag("model_dialog").assertDoesNotExist()
        compose.onNodeWithTag("chat_draft").assertTextContains("Keep this draft")
        compose.runOnIdle {
            assertEquals(listOf("refresh-models", "model"), actions.events)
            assertEquals(listOf(ModelSelectionSubmission(45L, "paired-pc", "s1", revision, next.id)), actions.models)
        }
    }

    @Test
    fun modelPermissionExplainsPcConsentWithoutInventingChoicesOrChangingTheDraft() {
        assumeTrue(BuildConfig.PC_MODEL_SELECTION)
        val actions = RecordingActions()
        val session = SessionRow("s1", "Existing conversation", SessionStatus.IDLE)
        val pane = ModelSelectionPane(ModelAccess.DENIED, emptyList(), null, null, null, ModelFeedback.NONE)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE), SessionPane(listOf(session), session.id, false),
            Conversation(session, emptyList(), false), Composer("Keep this draft", SendState.READY, Feedback.NONE, null), false, pane)
        render(CompanionState(screen = screen, draft = "Keep this draft", foreground = true), actions)
        compose.onNodeWithTag("choose_model").performClick()
        compose.onNodeWithText(text(R.string.native_model_permission)).assertIsDisplayed()
        captureModelDialog("permission")
        compose.onNodeWithTag("model_choices").assertDoesNotExist()
        compose.onNodeWithText(text(R.string.cancel)).performClick()
        compose.onNodeWithTag("chat_draft").assertTextContains("Keep this draft")
        compose.runOnIdle { assertEquals(listOf("refresh-models"), actions.events) }
    }

    @Test
    fun androidOnlyModelControlExplainsPcSupportWithoutIssuingModelRequests() {
        assumeFalse(BuildConfig.PC_MODEL_SELECTION)
        val actions = RecordingActions()
        val session = SessionRow("s1", "Existing conversation", SessionStatus.IDLE)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE), SessionPane(listOf(session), session.id, false),
            Conversation(session, emptyList(), false), Composer("Keep this draft", SendState.READY, Feedback.NONE, null), false)
        render(CompanionState(screen = screen, draft = "Keep this draft", foreground = true), actions)
        compose.onNodeWithTag("choose_model").assertIsEnabled().performClick()
        compose.onNodeWithText(text(R.string.native_model_pc_support_required)).assertIsDisplayed()
        compose.onNodeWithTag("model_refresh").assertDoesNotExist()
        compose.onNodeWithTag("model_choices").assertDoesNotExist()
        captureModelDialog("pc-support-required")
        compose.onNodeWithText(text(R.string.cancel)).performClick()
        compose.onNodeWithTag("chat_draft").assertTextContains("Keep this draft")
        compose.runOnIdle {
            assertEquals(emptyList<String>(), actions.events)
            assertEquals(emptyList<ModelSelectionSubmission>(), actions.models)
        }
    }

    @Test
    fun sidebarCloseAndReopenPreserveTheCurrentDraftAtBothLayoutSizes() {
        val actions = RecordingActions()
        render(pairedState(SendState.READY), actions)
        val wide = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp >= 600
        if (!wide) compose.onNodeWithTag("open_sessions").performClick()
        compose.onNodeWithTag("close_sessions").assertIsDisplayed().performClick()
        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
        compose.onNodeWithTag("open_sessions").assertIsDisplayed().performClick()
        compose.onNodeWithTag("close_sessions").assertIsDisplayed()
        compose.onNodeWithTag("sidebar_search").assertIsDisplayed()
        compose.onNodeWithTag("close_sessions").performClick()
        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun recentConversationCardSelectsOnlyOnAnExplicitForegroundGesture() {
        val actions = RecordingActions()
        val foreground = mutableStateOf(false)
        val session = SessionRow("recent", "Existing PC work", SessionStatus.CLOSED)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE),
            SessionPane(listOf(session), null, false), Conversation(null, emptyList(), false),
            Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false)
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeWorkLanding(screen, foreground.value, actions, Modifier.fillMaxSize())
            }
        }
        compose.onNodeWithTag("recent_session_recent").assertIsDisplayed().assertIsNotEnabled()
            .performTouchInput { click() }
        compose.runOnIdle {
            assertEquals(emptyList<String>(), actions.events)
            foreground.value = true
        }
        compose.onNodeWithTag("recent_session_recent").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("select:recent"), actions.events) }
    }

    @Test
    fun unselectedWorkLandingPrioritizesDeliveryReviewOverSuggestions() {
        val actions = RecordingActions()
        val session = SessionRow("recent", "Existing PC work", SessionStatus.IDLE)
        val review = DeliveryReview("paired-pc", "original-session", "pending-submission")
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE),
            SessionPane(listOf(session), null, false), Conversation(null, emptyList(), false),
            Composer("", SendState.DELIVERY_UNKNOWN, Feedback.DELIVERY_UNKNOWN, review), false)
        render(CompanionState(screen = screen, foreground = true), actions)

        compose.onNodeWithTag("recent_session_recent").assertDoesNotExist()
        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertIsNotEnabled()
        compose.onNodeWithTag("review_delivery").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("review"), actions.events) }
    }

    @Test
    fun closedSessionPreservesHistoryAndRolesWithoutComposer() {
        val actions = RecordingActions()
        val session = SessionRow("closed", "Unloaded conversation", SessionStatus.CLOSED)
        val history = listOf(
            TextRow("u1", Role.USER, "Original question"),
            TextRow("a1", Role.ASSISTANT, "Preserved answer"),
        )
        render(pairedState(SendState.CLOSED, session = session, history = history), actions)

        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertDoesNotExist()
        compose.onNodeWithText(text(R.string.native_open_chat_title)).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.native_open_chat_checking)).assertIsDisplayed()
        compose.onNodeWithTag("open_session").assertIsNotEnabled()
        compose.onNodeWithTag("user_message").performScrollTo().assertIsDisplayed()
            .assert(hasAnyAncestor(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.role_user))))
        compose.onNodeWithText("Original question").assertIsDisplayed()
        compose.onNodeWithTag("assistant_message").performScrollTo().assertIsDisplayed()
            .assert(hasAnyAncestor(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.role_assistant))))
        compose.onNodeWithText("Preserved answer").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("refresh-activation"), actions.events) }
    }

    @Test
    fun openingAColdChatRequiresAnExplicitGestureBoundToTheRenderedPcAndChat() {
        val actions = RecordingActions()
        val session = SessionRow("cold-target", "Existing conversation", SessionStatus.CLOSED)
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE),
            SessionPane(listOf(session), session.id, false), Conversation(session, emptyList(), false),
            Composer("retained draft", SendState.CLOSED, Feedback.NONE, null), false,
            ModelSelectionPane.empty(), ActivationPane(ActivationAccess.ENABLED, false))
        render(CompanionState(screen = screen, foreground = true, foregroundGeneration = 37,
            draft = "retained draft"), actions)
        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(emptyList<SessionOpenSubmission>(), actions.openings)
            assertEquals(listOf("refresh-activation"), actions.events)
        }
        compose.onNodeWithTag("open_session").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(listOf(SessionOpenSubmission(37, "paired-pc", "cold-target")), actions.openings)
            assertEquals(listOf("refresh-activation", "open"), actions.events)
        }
    }

    @Test
    fun onlineReadFailureRetainsHistoryAndRetriesOnlyOnExplicitClick() {
        val actions = RecordingActions()
        render(pairedState(SendState.READY, feedback = Feedback.REFRESH_FAILED,
            history = listOf(TextRow("a1", Role.ASSISTANT, "Previously loaded answer"))), actions)

        compose.onNodeWithText("Previously loaded answer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(R.string.native_chat_read_error)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("retry_conversation").performScrollTo().assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("retry_conversation").performClick()
        compose.runOnIdle { assertEquals(listOf("refresh"), actions.events) }
        compose.onNodeWithTag("chat_draft").assertTextContains("queued follow-up")
    }

    @Test
    fun searchAndOpenFilterUseLoadedRowsAndSelectExactlyOneSessionId() {
        val actions = RecordingActions()
        val selected = SessionRow("s1", "Alpha active", SessionStatus.BUSY)
        val closed = SessionRow("s2", "Alpha archived", SessionStatus.CLOSED)
        val other = SessionRow("s3", "Beta idle", SessionStatus.IDLE)
        renderNavigation(SessionPane(listOf(selected, closed, other), selected.id, true), actions)

        compose.onNodeWithTag("session_s1").assertIsSelected()
        compose.onNodeWithTag("sidebar_search").performClick()
        compose.onNodeWithTag("session_search").performTextReplacement("  ALPHA  ")
        compose.onNodeWithText(text(R.string.native_search_loaded)).assertIsDisplayed()
        compose.onNodeWithTag("session_s1").assertIsDisplayed()
        compose.onNodeWithTag("session_s2").assertIsDisplayed()
        compose.onNodeWithTag("session_s3").assertDoesNotExist()
        compose.onNodeWithTag("filter_open_sessions").performClick().assertIsSelected()
        compose.onNodeWithTag("session_s1").assertIsDisplayed()
        compose.onNodeWithTag("session_s2").assertDoesNotExist()
        compose.onNodeWithTag("filter_all_sessions").performClick().assertIsSelected()
        compose.onNodeWithTag("session_s2").assertIsDisplayed()
        compose.onNodeWithTag("session_search").performTextReplacement("not loaded")
        compose.onNodeWithText(text(R.string.native_search_empty)).assertIsDisplayed()
        compose.onNodeWithTag("session_s1").assertDoesNotExist()
        compose.onNodeWithTag("session_s2").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("session_search").performTextReplacement("")
        compose.onNodeWithTag("session_s3").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("select:s3"), actions.events) }
    }

    @Test
    fun foregroundRetirementBlocksSessionSelectionAndRefresh() {
        val actions = RecordingActions()
        val foreground = mutableStateOf(true)
        val session = SessionRow("s1", "Loaded session", SessionStatus.IDLE)
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeSessionNavigation(SessionPane(listOf(session), session.id, false), foreground.value,
                    SessionNavigationActions(actions::refresh, actions::selectSession, actions::loadMoreSessions,
                        workspaceExpansionFixture()))
            }
        }
        compose.onNodeWithTag("session_s1").assertIsDisplayed()
        compose.runOnIdle { foreground.value = false }

        compose.onNodeWithTag("session_s1").performClick()
        compose.onNodeWithTag("recents_menu").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun settingsDoesNotPresentHistoryFailureAsPcConnectionFailure() {
        val actions = RecordingActions()
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeSettingsScreen(NativeUiState(companion = pairedState(SendState.READY, feedback = Feedback.REFRESH_FAILED)),
                    actions, NativeSettingsActions({}, {}, {}, {}))
            }
        }
        compose.onNodeWithText(text(R.string.native_pc_online)).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.native_chat_read_error)).assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun pairedSettingsCanStartAnotherPcLinkWithoutForgettingTheCurrentPc() {
        val actions = RecordingActions()
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeSettingsScreen(NativeUiState(companion = pairedState(SendState.READY)), actions,
                    NativeSettingsActions({}, {}, {}, {}))
            }
        }

        compose.onNodeWithTag("settings").performScrollToNode(hasTestTag("pair_pc"))
        compose.onNodeWithTag("pair_pc").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("pairing"), actions.events) }
    }

    @Test
    fun settingsDisclosuresExposeForgetOnlyWhenOpenedWithoutIssuingCommands() {
        val actions = RecordingActions()
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeSettingsScreen(NativeUiState(companion = pairedState(SendState.READY)), actions,
                    NativeSettingsActions(
                        goBack = { actions.events.add("back") },
                        setTheme = { actions.events.add("theme:${it.name}") },
                        pauseConnection = { actions.events.add("pause") },
                        resumeConnection = { actions.events.add("resume") },
                    ))
            }
        }

        compose.onNodeWithTag("theme_system").assertIsSelected()
        scrollSettingsTo("connection_details")
        compose.onNodeWithTag("forget_pairing").assertDoesNotExist()
        scrollSettingsTo("managed_capabilities")
        compose.onNodeWithTag("managed_capabilities").performClick()
        compose.onNodeWithTag("settings").performScrollToNode(hasText(text(R.string.native_models_unavailable)))
        compose.onNodeWithText(text(R.string.native_models_unavailable)).assertIsDisplayed()
        scrollSettingsTo("connection_details")
        compose.onNodeWithTag("forget_pairing").assertDoesNotExist()
        compose.onNodeWithTag("connection_details")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.native_collapsed))).performClick()
        scrollSettingsTo("forget_pairing")
        compose.onNodeWithTag("forget_pairing").assertIsDisplayed().assertIsEnabled()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        scrollSettingsTo("connection_details")
        compose.onNodeWithTag("connection_details")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.native_expanded))).performClick()
        compose.onNodeWithTag("forget_pairing").assertDoesNotExist()
        scrollSettingsTo("theme_light")
        compose.onNodeWithTag("theme_light").performClick()
        compose.runOnIdle { assertEquals(listOf("theme:LIGHT"), actions.events) }
    }

    private fun scrollSettingsTo(tag: String) {
        compose.onNodeWithTag("settings").performScrollToNode(hasTestTag(tag))
    }

    private fun renderNavigation(pane: SessionPane, actions: RecordingActions) {
        compose.setContent {
            NativeTheme(ThemePreference.SYSTEM) {
                NativeSessionNavigation(pane, true,
                    SessionNavigationActions(actions::refresh, actions::selectSession, actions::loadMoreSessions,
                        workspaceExpansionFixture()))
            }
        }
    }

    private fun render(state: CompanionState, actions: RecordingActions) {
        val theme = InstrumentationRegistry.getArguments().getString("polishTheme")?.let {
            ThemePreference.valueOf(it.uppercase(java.util.Locale.ROOT))
        } ?: ThemePreference.SYSTEM
        compose.setContent {
            NativeTheme(theme) {
                NativeChatScreen(state, actions,
                    openSettings = { actions.events.add("settings") },
                    resumeConnection = { actions.events.add("resume") })
            }
        }
    }

    private fun pairedState(
        sendState: SendState,
        review: DeliveryReview? = null,
        session: SessionRow = SessionRow("s1", "Busy session", SessionStatus.BUSY),
        history: List<TextRow> = emptyList(),
        feedback: Feedback = if (review == null) Feedback.NONE else Feedback.DELIVERY_UNKNOWN,
    ): CompanionState {
        val screen = Screen(Pc("paired-pc", "Linked PC", Connection.ONLINE),
            SessionPane(listOf(session), session.id, false), Conversation(session, history, false),
            Composer("queued follow-up", sendState, feedback, review), false)
        return CompanionState(screen = screen, draft = "queued follow-up", foreground = true)
    }

    private fun captureModelDialog(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val screenshot = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {
            val directory = requireNotNull(instrumentation.targetContext.getExternalFilesDir(null))
            File(directory, "model-picker-$name.png").outputStream().use { output ->
                check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
            }
        } finally { screenshot.recycle() }
    }

    private fun text(resource: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)

    /** Records caller-facing gestures only; all state and presentation models are real. */
    private class RecordingActions : NativeChatActions {
        override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) { events.add("workspace:$choice") }
        val events = mutableListOf<String>()
        val models = mutableListOf<ModelSelectionSubmission>()
        val openings = mutableListOf<SessionOpenSubmission>()
        override fun showPairing() { events.add("pairing") }
        override fun sendText(text: String) { events.add("send:$text") }
        override fun sendSubmission(submission: DraftSubmission) { events.add("send:${submission.text}") }
        override fun manageSession(submission: SessionManagementSubmission) { events.add("manage:${submission.command}") }
        override fun refreshManagementWorkspaces() { events.add("refresh-management") }
        override fun loadMoreManagementWorkspaces() { events.add("more-workspaces") }
        override fun refreshModels() { events.add("refresh-models") }
        override fun refreshActivationAccess() { events.add("refresh-activation") }
        override fun openSession(submission: SessionOpenSubmission) { events.add("open"); openings.add(submission) }
        override fun loadNextModels() { events.add("next-models") }
        override fun selectModel(submission: ModelSelectionSubmission) { events.add("model"); models.add(submission) }
        override fun resolveUnknown() { events.add("review") }
        override fun draftChanged(draft: String) { events.add("draft:$draft") }
        override fun pairFromLink(link: String) { events.add("enroll:$link") }
        override fun selectSession(sessionId: String) { events.add("select:$sessionId") }
        override fun refresh() { events.add("refresh") }
        override fun forgetPairing(pcId: String) { events.add("forget:$pcId") }
        override fun pairingLinkChanged(link: String) { events.add("link:$link") }
        override fun cancelPairing() { events.add("cancel") }
        override fun loadMoreSessions() { events.add("more-sessions") }
        override fun loadMoreHistory() { events.add("more-history") }
    }
}
