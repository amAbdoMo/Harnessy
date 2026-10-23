package io.harnessy.companion.nativeapp

import android.graphics.Bitmap
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityNodeInfo
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.min

/**
 * Real screens in a network-free Activity; outgoing PC actions are recorded, never executed.
 * The IME case requires API 30+ edge-to-edge geometry and a docked keyboard; its runner restores input settings.
 * Font profiles acknowledge only Gboard's known font-change notice before measuring the application viewport.
 */
@RunWith(AndroidJUnit4::class)
class NativeUiPolishTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var decorView: View
    private var keyboard: SoftwareKeyboardController? = null
    private lateinit var inputModes: InputModeManager
    @Volatile private var imeAnimating = false
    private var originalAutomationFlags: Int? = null
    private var keyboardFontNoticeAcknowledged = false

    private val theme: ThemePreference =
        when (InstrumentationRegistry.getArguments().getString("polishTheme")) {
            "dark" -> ThemePreference.DARK
            else -> ThemePreference.LIGHT
        }

    @Before
    @Suppress("DEPRECATION") // Mirrors NativeActivity's adjustResize manifest mode.
    fun prepareHostWindow() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val service = automation.serviceInfo
        originalAutomationFlags = service.flags
        service.flags = service.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        automation.serviceInfo = service
        val activity = compose.activity
        compose.runOnUiThread {
            activity.enableEdgeToEdge()
            activity.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            decorView = activity.window.decorView
            ViewCompat.setWindowInsetsAnimationCallback(decorView,
                object : WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                    override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                        if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) imeAnimating = true
                    }
                    override fun onProgress(insets: WindowInsetsCompat,
                        runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat = insets
                    override fun onEnd(animation: WindowInsetsAnimationCompat) {
                        if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) imeAnimating = false
                    }
                })
        }
    }

    @After
    fun releaseInsetObserver() {
        try {
            if (::decorView.isInitialized) compose.runOnUiThread { ViewCompat.setWindowInsetsAnimationCallback(decorView, null) }
        } finally {
            originalAutomationFlags?.let { flags ->
                val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
                automation.serviceInfo = automation.serviceInfo.apply { this.flags = flags }
            }
        }
    }

    @Test
    fun landingListsRealRecentWorkAndOpeningOneSelectsWithoutCreatingOrSending() {
        val actions = RecordingActions()
        renderChat(landingState(), actions)

        compose.onNodeWithTag("work_landing").assertIsDisplayed()
        for (id in listOf("recent-idle", "recent-long", "recent-closed", "recent-other")) {
            compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_$id"))
            compose.onNodeWithTag("recent_session_$id").assertIsDisplayed()
        }
        compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_recent-long"))
        compose.onNodeWithTag("recent_session_recent-long").assertTextContains(LONG_TITLE)
        compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_recent-closed"))
        compose.onNodeWithTag("recent_session_recent-closed").assertTextContains(text(R.string.native_view_history))
        compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_recent-idle"))
        compose.onNodeWithTag("recent_session_recent-idle").assertTextContains(text(R.string.native_continue))

        compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_recent-other"))
        compose.onNodeWithTag("recent_session_recent-other").assertIsDisplayed()
        compose.onNodeWithTag("work_landing").performTouchInput { swipeUp() }
        compose.onNodeWithTag("work_landing").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }

        compose.onNodeWithTag("work_landing").performScrollToNode(hasTestTag("recent_session_recent-idle"))
        compose.onNodeWithTag("recent_session_recent-idle").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("select:recent-idle"), actions.events) }
        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertIsDisplayed().assertIsNotEnabled()
        capture("landing", compose.onRoot())
    }

    @Test
    fun settingsMovesTheThemeSelectionAndReportsManagementAccessWithoutSideEffects() {
        val actions = RecordingActions()
        val preference = mutableStateOf(theme)
        val companion = mutableStateOf(settingsCompanion(ManagementAccess.ENABLED))
        compose.setContent {
            NativeTheme(preference.value) {
                NativeSettingsScreen(
                    NativeUiState(companion = companion.value, theme = preference.value), actions,
                    NativeSettingsActions(
                        goBack = { actions.events.add("back") },
                        setTheme = {
                            actions.events.add("theme:${it.name}")
                            preference.value = it
                        },
                        pauseConnection = { actions.events.add("pause") },
                        resumeConnection = { actions.events.add("resume") },
                    ))
            }
        }

        for (option in ThemePreference.entries) {
            compose.onNodeWithTag("theme_${option.name.lowercase()}").assertIsDisplayed().assertIsEnabled()
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        }
        compose.onNodeWithTag("theme_${theme.name.lowercase()}").assertIsSelected()
        capture("settings", compose.onRoot())

        val chosen = if (theme == ThemePreference.DARK) ThemePreference.LIGHT else ThemePreference.DARK
        val before = compose.onRoot().captureToImage().asAndroidBitmap()
        compose.onNodeWithTag("theme_${chosen.name.lowercase()}").performClick()
        compose.runOnIdle { assertEquals(listOf("theme:${chosen.name}"), actions.events) }
        compose.onNodeWithTag("theme_${chosen.name.lowercase()}").assertIsSelected()
        compose.onNodeWithTag("theme_${theme.name.lowercase()}").assertIsNotSelected()
        val after = compose.onRoot().captureToImage().asAndroidBitmap()
        assertTrue(
            "The chosen theme must repaint the rendered surface",
            changedPixelRatio(before, after) > 0.5f,
        )

        compose.onNodeWithTag("settings").performScrollToNode(hasText(text(R.string.native_chat_management_enabled)))
        compose.onNodeWithTag("settings_chat_management").assertTextEquals(text(R.string.native_chat_management_enabled))
        compose.onNodeWithTag("settings").performScrollToNode(hasText(text(R.string.native_chat_management_actions)))
        compose.onNodeWithText(text(R.string.native_chat_management_actions)).assertIsDisplayed()
        compose.runOnIdle { companion.value = settingsCompanion(ManagementAccess.DISABLED) }
        compose.waitUntil("the management status reports the withheld permission", 5_000) {
            compose.onAllNodesWithText(text(R.string.native_manage_permission_title)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("settings_chat_management").assertTextEquals(text(R.string.native_manage_permission_title))
        compose.onNodeWithTag("settings").performScrollToNode(hasText(text(R.string.native_manage_permission_required)))
        compose.onNodeWithText(text(R.string.native_manage_permission_required)).assertIsDisplayed()
        capture("settings-permission", compose.onRoot())

        compose.onNodeWithTag("settings").performScrollToNode(hasTestTag("managed_capabilities"))
        compose.onNodeWithTag("managed_capabilities").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithTag("settings").performScrollToNode(hasTestTag("connection_details"))
        compose.onNodeWithTag("connection_details").assertIsDisplayed().assertIsEnabled()

        compose.onNodeWithTag("back_to_chat").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("back_to_chat").performClick()
        compose.runOnIdle { assertEquals(listOf("theme:${chosen.name}", "back"), actions.events) }
    }

    @Test
    fun conversationKeepsUserTextAndProjectsTheAssistantMarkdownWithoutFiringOperations() {
        val actions = RecordingActions()
        renderChat(conversationState(draft = ""), actions)

        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("message_u1"))
        compose.onNodeWithTag("user_message").assertIsDisplayed()
        compose.onNodeWithText(USER_QUESTION).assertIsDisplayed()

        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("assistant_message"))
        compose.waitUntil("the assistant answer is projected into native markdown blocks", 10_000) {
            compose.onAllNodesWithText("1.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Here is the result.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Verified native quote (fixture)").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("val greeting = \"hello\"", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("1.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("first step").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("second step").performScrollTo().assertIsDisplayed()
        capture("conversation", compose.onRoot())
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun toolActivityCollapsesBelowTheAnswerAndOpensWithoutSendingOperations() {
        val actions = RecordingActions()
        val history = listOf(TextRow("intro", Role.ASSISTANT, "I will check the files (fixture)."),
            TextRow("tool-read", Role.TOOL, "read"), TextRow("tool-command", Role.TOOL, "pwsh"),
            TextRow("tool-edit", Role.TOOL, "edit"), TextRow("tool-code", Role.TOOL, "run_code"),
            TextRow("tool-search", Role.TOOL, "grep"), TextRow("update-read", Role.NOTICE, "Tool completed"), TextRow("update-turn", Role.NOTICE, "Turn failed"),
            TextRow("answer", Role.ASSISTANT, "The answer remains readable (fixture)."))
        renderChat(conversationState("", history), actions)
        compose.onNodeWithText("Turn failed").assertIsDisplayed()
        compose.onNodeWithText("The answer remains readable (fixture).").assertIsDisplayed()
        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("activity_toggle:tool-read"))
        val toggle = compose.onNodeWithTag("activity_toggle:tool-read")
        toggle.assertIsDisplayed().assertHeightIsAtLeast(48.dp)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.native_collapsed)))
        compose.onNodeWithTag("activity_body:tool-read").assertDoesNotExist()
        capture("activity-collapsed", compose.onRoot())
        val before = compose.onNodeWithTag("activity_chevron:tool-read", useUnmergedTree = true).captureToImage().asAndroidBitmap()
        compose.mainClock.autoAdvance = false
        try {
            toggle.performClick()
            compose.mainClock.advanceTimeBy(50)
            capture("activity-transition", compose.onRoot())
            compose.mainClock.advanceTimeBy(150)
        } finally { compose.mainClock.autoAdvance = true }
        toggle.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.native_expanded)))
        val after = compose.onNodeWithTag("activity_chevron:tool-read", useUnmergedTree = true).captureToImage().asAndroidBitmap()
        assertTrue("The chevron must visibly change direction", changedPixelRatio(before, after) > 0.01f)
        compose.onNodeWithTag("message_tool-read").assertIsDisplayed()
        capture("activity-icons-top", compose.onRoot())
        compose.onNodeWithTag("message_tool-search").performScrollTo().assertIsDisplayed()
        capture("activity-expanded", compose.onRoot())
        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("activity_toggle:tool-read"))
        toggle.performClick()
        compose.onNodeWithTag("activity_body:tool-read").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun activityDisclosureSurvivesProgressButDoesNotCarryIntoAnotherConversation() {
        val actions = RecordingActions()
        val history = listOf(TextRow("first-tool", Role.TOOL, "read"), TextRow("second-tool", Role.TOOL, "pwsh"))
        val companion = mutableStateOf(conversationState("", history))
        renderChat(companion, actions)
        compose.onNodeWithTag("activity_toggle:first-tool").performClick()
        val appended = history + TextRow("next-tool", Role.TOOL, "grep")
        compose.runOnIdle { companion.value = conversationState("", appended) }
        compose.onNodeWithTag("activity_body:first-tool").assertIsDisplayed()
        compose.onNodeWithTag("message_next-tool").assertIsDisplayed()
        compose.runOnIdle { companion.value = conversationState("", appended, sessionId = "other-session") }
        compose.onNodeWithTag("activity_body:first-tool").assertDoesNotExist()
        compose.onNodeWithTag("activity_toggle:first-tool")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text(R.string.native_collapsed)))
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun longActivityScrollsInsideItsBoundedBodyWithoutLosingFullToolNames() {
        val actions = RecordingActions()
        val longName = "mcp__fixture." + "long_tool_name_".repeat(12)
        val history = (0 until 30).map { index -> TextRow("event-$index", Role.TOOL, if (index == 0) longName else "read") } +
            TextRow("following-answer", Role.ASSISTANT, (1..30).joinToString("\n\n") { "Following answer paragraph $it (fixture)." })
        renderChat(conversationState("", history), actions)
        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("activity_toggle:event-0"))
        compose.onNodeWithTag("activity_toggle:event-0").performClick()
        val body = compose.onNodeWithTag("activity_body:event-0")
        val transcript = compose.onNodeWithTag("transcript").fetchSemanticsNode().boundsInRoot
        assertTrue("Activity must not take over the transcript viewport", body.fetchSemanticsNode().boundsInRoot.height <= transcript.height / 2 + 1f)
        compose.onNodeWithText(longName).assertIsDisplayed()
        val layout = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        compose.onNodeWithText(longName).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
        assertTrue("An expanded tool name must remain complete", layout.isNotEmpty() && !layout.first().hasVisualOverflow)
        capture("activity-long-name", compose.onRoot())
        compose.onNodeWithTag("message_event-29").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("activity_toggle:event-0"))
        compose.onNodeWithTag("activity_toggle:event-0").assertIsDisplayed()
        val range = body.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        body.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, range.maxValue() - range.value()) }
        val headerTop = compose.onNodeWithTag("activity_toggle:event-0").fetchSemanticsNode().boundsInRoot.top
        body.performTouchInput { swipeUp() }
        compose.waitForIdle()
        val headers = compose.onAllNodesWithTag("activity_toggle:event-0").fetchSemanticsNodes()
        assertTrue("A drag at the activity boundary must continue through the transcript",
            headers.isEmpty() || headers.first().boundsInRoot.top < headerTop - 1f)
        capture("activity-long-scrolled", compose.onRoot())
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun browsingOlderMessagesCanJumpToTheLatestWithoutSubmittingWork() {
        val actions = RecordingActions()
        val history = (0 until 18).map { index ->
            TextRow("history-$index", if (index % 2 == 0) Role.USER else Role.ASSISTANT, "History message $index (fixture)")
        }
        renderChat(conversationState("", history), actions)
        compose.onNodeWithTag("transcript").performScrollToNode(hasTestTag("message_history-0"))
        compose.onNodeWithTag("jump_to_latest").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp).performClick()
        compose.waitUntil("the animated scroll reaches the latest message", 5_000) {
            compose.onNodeWithTag("message_history-17").isDisplayed()
        }
        compose.onNodeWithTag("jump_to_latest").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
        capture("history", compose.onRoot())
    }

    @Test
    @SdkSuppress(minSdkVersion = 30)
    fun theRealKeyboardStaysBelowTheComposerAndNavigationDismissesIt() {
        val actions = RecordingActions()
        val draft = (1..5).joinToString("\n") { "Draft line $it kept while editing (fixture)" }
        val state = mutableStateOf(conversationState(draft = draft))
        renderChat(state, actions)

        // A wide layout shows its rail first; hiding it exposes the conversations control.
        if (isWide()) compose.onNodeWithTag("close_sessions").performClick()
        compose.onNodeWithTag("open_sessions").assertIsDisplayed()

        compose.onNodeWithTag("chat_draft").performTouchInput { click() }
        compose.onNodeWithTag("chat_draft").assertIsFocused()
        val selection = compose.onNodeWithTag("chat_draft").fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange]
        compose.runOnIdle { keyboard?.show() }
        try {
            compose.waitUntil("the soft keyboard becomes visible", 15_000) { dockedImeReady() }
        } catch (timeout: ComposeTimeoutException) {
            val insets = ViewCompat.getRootWindowInsets(decorView)
            println("IME diagnostics: visible=${insets?.isVisible(WindowInsetsCompat.Type.ime())}, " +
                "bottom=${imeHeight()}, decorHeight=${decorView.height}, windowFocus=${decorView.hasWindowFocus()}")
            captureDevice("ime-unavailable")
            throw timeout
        }
        compose.waitUntil("the composer moves above the soft keyboard", 15_000) {
            dockedImeReady() && bottomOf("composer_shell") <= imeTop() + tolerancePx()
        }
        compose.waitUntil("the send control stays above the soft keyboard", 15_000) {
            dockedImeReady() && bottomOf("send_text") <= imeTop() + tolerancePx()
        }
        compose.onNodeWithTag("chat_draft").assertIsFocused().assertTextEquals(draft)
        if (imeTop() / decorView.resources.displayMetrics.density < 320f) {
            compose.onNodeWithTag("choose_model").assertDoesNotExist()
            compose.onNodeWithTag("choose_conversation").assertDoesNotExist()
            assertTrue("A short window must use the compact editor", compose.onNodeWithTag("chat_draft")
                .fetchSemanticsNode().boundsInWindow.height <= 48f * decorView.resources.displayMetrics.density + 1f)
        }
        assertEquals("Adapting to the keyboard must retain the editor selection", selection,
            compose.onNodeWithTag("chat_draft").fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        assertHeaderAboveComposer()
        captureDevice("keyboard")

        compose.runOnIdle { state.value = state.value.copy(draftRejected = true) }
        compose.onNodeWithTag("composer_hint").assertIsDisplayed()
        compose.onNodeWithTag("send_text").assertIsNotEnabled()
        compose.onNodeWithTag("chat_draft").assertIsFocused().assertTextEquals(draft)
        assertHeaderAboveComposer()

        compose.onNodeWithTag("open_sessions").performClick()
        compose.waitUntil("the soft keyboard is dismissed", 15_000) { imeHeight() == 0 && !imeAnimating }
        compose.onNodeWithTag("chat_draft").assertIsNotFocused().assertTextEquals(draft)
        if (isWide()) assertArrowCanReachControl()

        compose.onNodeWithTag("sidebar_search").performClick()
        compose.waitUntil("the search keyboard becomes visible", 15_000) { dockedImeReady() }
        compose.waitUntil("the session list stays above the search keyboard", 15_000) {
            dockedImeReady() && bottomOf("session_list") <= imeTop() + tolerancePx()
        }
        val minimumTargetHeight = 48f * decorView.resources.displayMetrics.density - 1f
        try {
            compose.waitUntil("the keyboard leaves room for a chat touch target", 15_000) {
                acknowledgeKeyboardFontNotice()
                dockedImeReady() && compose.onNodeWithTag("session_list").fetchSemanticsNode().boundsInWindow.height >= minimumTargetHeight
            }
        } catch (timeout: ComposeTimeoutException) {
            captureDevice("search-clipped")
            throw timeout
        }
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_s1"))
        compose.onNodeWithTag("session_s1").assertIsDisplayed()
        assertTrue("A complete chat touch target must remain visible above the keyboard",
            compose.onNodeWithTag("session_s1").fetchSemanticsNode().boundsInWindow.height >= 48f * decorView.resources.displayMetrics.density - 1f)
        captureDevice("search-keyboard")

        compose.onNodeWithTag("close_sessions").performClick()
        compose.waitUntil("closing the navigation dismisses the keyboard", 15_000) { imeHeight() == 0 }
        val noticeLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag("composer_hint").assertIsDisplayed().performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
            it(noticeLayouts)
        }
        assertTrue("The full validation notice returns after the keyboard closes", !noticeLayouts.single().hasVisualOverflow)
        compose.onNodeWithTag("send_text").assertIsNotEnabled()
        compose.onNodeWithTag("chat_draft").assertTextEquals(draft)
        compose.onNodeWithTag("open_sessions").performClick()
        compose.onNodeWithTag("sidebar_search").performClick()
        compose.waitUntil("search is ready for selecting a chat", 15_000) { dockedImeReady() }
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_s1"))
        compose.onNodeWithTag("session_s1").performClick()
        compose.waitUntil("selecting a chat dismisses the search keyboard", 15_000) { imeHeight() == 0 }
        compose.onNodeWithTag("chat_draft").assertIsNotFocused().assertTextEquals(draft)
        compose.runOnIdle { assertEquals(listOf("select:s1"), actions.events) }
    }

    @Test
    fun systemBackClosesThePhoneDrawerWhileTheWideRailKeepsItsOwnControls() {
        val actions = RecordingActions()
        val draft = "Draft kept across navigation (fixture)"
        renderChat(conversationState(draft = draft), actions)

        if (isWide()) {
            compose.onNodeWithTag("close_sessions").performClick()
            compose.waitUntil("the wide rail is hidden", 5_000) {
                !compose.onNodeWithTag("close_sessions").isDisplayed()
            }
            compose.onNodeWithTag("open_sessions").assertIsDisplayed().performClick()
            compose.waitUntil("the wide rail is shown again", 5_000) {
                compose.onNodeWithTag("close_sessions").isDisplayed()
            }
            compose.onNodeWithTag("chat_draft").assertTextEquals(draft)
        } else {
            compose.onNodeWithTag("open_sessions").performClick()
            compose.waitUntil("the phone drawer is open", 5_000) {
                compose.onNodeWithTag("close_sessions").isDisplayed()
            }
            val activity = compose.activity
            compose.runOnUiThread { activity.onBackPressedDispatcher.onBackPressed() }
            compose.waitUntil("the phone drawer closes on system back", 5_000) {
                !compose.onNodeWithTag("close_sessions").isDisplayed()
            }
            compose.onNodeWithTag("composer_shell").assertIsDisplayed()
            compose.onNodeWithTag("chat_draft").assertIsDisplayed().assertTextEquals(draft)
        }
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    @Test
    fun loadingUnpairedAndPausedScreensKeepSettingsReachableWithoutAnEditableComposer() {
        val actions = RecordingActions()
        val state = mutableStateOf(loadingState())
        compose.setContent {
            NativeTheme(theme) {
                NativeChatScreen(state.value, actions,
                    openSettings = { actions.events.add("settings") },
                    resumeConnection = { actions.events.add("resume") })
            }
        }

        compose.onNodeWithTag("loading_pc").assertIsDisplayed()
        assertSettingsRemainReachable()

        compose.runOnIdle { state.value = unpairedState() }
        compose.waitUntil("the pairing screen replaces the loading screen", 5_000) {
            compose.onNodeWithTag("link_pc").isDisplayed()
        }
        assertSettingsRemainReachable()
        capture("link", compose.onRoot())

        compose.runOnIdle { state.value = pausedState() }
        compose.waitUntil("the paused screen is shown", 5_000) {
            compose.onNodeWithText(text(R.string.native_connection_paused)).isDisplayed()
        }
        assertSettingsRemainReachable()
        compose.runOnIdle { assertEquals(emptyList<String>(), actions.events) }
    }

    private fun assertSettingsRemainReachable() {
        compose.onNodeWithTag("open_settings").assertIsDisplayed().assertIsEnabled()
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("chat_draft").assertDoesNotExist()
        compose.onNodeWithTag("send_text").assertDoesNotExist()
    }

    private fun acknowledgeKeyboardFontNotice() {
        if (keyboardFontNoticeAcknowledged) return
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        for (window in automation.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != "com.google.android.inputmethod.latin") continue
            if (root.findAccessibilityNodeInfosByText("Keyboard font size updated").isEmpty()) continue
            var button = root.findAccessibilityNodeInfosByText("OK").firstOrNull { it.text?.toString() == "OK" }
            while (button != null && !button.isClickable) button = button.parent
            captureDevice("keyboard-font-notice")
            check(button?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) {
                "The observed Gboard font notice could not be acknowledged"
            }
            keyboardFontNoticeAcknowledged = true
            return
        }
    }

    private fun assertArrowCanReachControl() {
        val original = inputModes.inputMode
        try {
            compose.runOnIdle { assertTrue(inputModes.requestInputMode(InputMode.Keyboard)) }
            compose.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
            compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true)).assertCountEquals(1)
            compose.onNodeWithTag("chat_draft").assertIsNotFocused()
        } finally {
            compose.runOnIdle { inputModes.requestInputMode(original) }
        }
    }

    private fun assertHeaderAboveComposer() {
        val composerTop = compose.onNodeWithTag("composer_region").fetchSemanticsNode().boundsInWindow.top
        for (tag in listOf("open_sessions", "open_settings")) {
            val control = compose.onNodeWithTag(tag).assertIsDisplayed()
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            assertTrue("The composer must not cover $tag", composerTop >= control.fetchSemanticsNode().boundsInWindow.bottom - 1f)
        }
    }

    private fun renderChat(state: CompanionState, actions: RecordingActions) = renderChat(mutableStateOf(state), actions)

    private fun renderChat(state: State<CompanionState>, actions: RecordingActions) {
        compose.setContent {
            keyboard = LocalSoftwareKeyboardController.current
            inputModes = LocalInputModeManager.current
            NativeTheme(theme) {
                NativeChatScreen(state.value, actions,
                    openSettings = { actions.events.add("settings") },
                    resumeConnection = { actions.events.add("resume") })
            }
        }
    }

    private fun landingState(): CompanionState {
        val rows = listOf(
            SessionRow("recent-idle", "Alpha chat", SessionStatus.IDLE),
            SessionRow("recent-long", LONG_TITLE, SessionStatus.BUSY),
            SessionRow("recent-closed", "Archived chat", SessionStatus.CLOSED),
            SessionRow("recent-other", "Beta chat", SessionStatus.IDLE),
        )
        val screen = Screen(Pc("fixture-pc", "Fixture PC", Connection.ONLINE),
            SessionPane(rows, null, false, ManagementPane(ManagementAccess.ENABLED, listOf(workspace), false, false)),
            Conversation(null, emptyList(), false),
            Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false)
        return CompanionState(screen = screen, draft = "", foreground = true, foregroundGeneration = 41L)
    }

    private fun conversationState(draft: String, history: List<TextRow> = listOf(
        TextRow("u1", Role.USER, USER_QUESTION), TextRow("a1", Role.ASSISTANT, MARKDOWN_ANSWER),
    ), sessionId: String = "s1"): CompanionState {
        val session = SessionRow(sessionId, "Selected conversation", SessionStatus.IDLE)
        val screen = Screen(Pc("fixture-pc", "Fixture PC", Connection.ONLINE),
            SessionPane(listOf(session), session.id, false, ManagementPane(ManagementAccess.ENABLED, listOf(workspace), false, false)),
            Conversation(session, history, false),
            Composer(draft, SendState.READY, Feedback.NONE, null), false)
        return CompanionState(screen = screen, draft = draft, foreground = true, foregroundGeneration = 41L)
    }

    private fun settingsCompanion(access: ManagementAccess): CompanionState {
        val session = SessionRow("s1", "Selected conversation", SessionStatus.IDLE)
        val screen = Screen(Pc("fixture-pc", "Fixture PC", Connection.ONLINE),
            SessionPane(listOf(session), session.id, false, ManagementPane(access, listOf(workspace), false, false)),
            Conversation(session, listOf(TextRow("a1", Role.ASSISTANT, "Answer (fixture)")), false),
            Composer("", SendState.READY, Feedback.NONE, null), false)
        return CompanionState(screen = screen, draft = "", foreground = true, foregroundGeneration = 41L)
    }

    private fun loadingState(): CompanionState = CompanionState(screen = null, foreground = true)

    private fun unpairedState(): CompanionState {
        val screen = Screen(null, SessionPane(emptyList(), null, false),
            Conversation(null, emptyList(), false),
            Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false)
        return CompanionState(screen = screen, foreground = true)
    }

    private fun pausedState(): CompanionState {
        val session = SessionRow("s1", "Selected conversation", SessionStatus.IDLE)
        val screen = Screen(Pc("fixture-pc", "Fixture PC", Connection.ONLINE),
            SessionPane(listOf(session), session.id, false, ManagementPane(ManagementAccess.ENABLED, listOf(workspace), false, false)),
            Conversation(session, emptyList(), false),
            Composer("", SendState.READY, Feedback.NONE, null), false)
        return CompanionState(screen = screen, foreground = true, connectionPaused = true)
    }

    /** The keyboard inset the framework reports for the current window. */
    private fun imeHeight(): Int =
        ViewCompat.getRootWindowInsets(decorView)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0

    // Exclude floating toolbar insets and opening frames; this fixture requires a docked keyboard.
    private fun dockedImeReady(): Boolean =
        !imeAnimating && ViewCompat.getRootWindowInsets(decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true &&
            imeHeight() >= 144f * decorView.resources.displayMetrics.density

    /** The top edge of the keyboard in window pixels. */
    private fun imeTop(): Float = decorView.height - imeHeight().toFloat()

    /** The bottom edge of one node in window pixels. */
    private fun bottomOf(tag: String): Float =
        compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInWindow.bottom

    private fun tolerancePx(): Float = 1f

    private fun isWide(): Boolean =
        InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp >= 600

    private fun capture(name: String, node: SemanticsNodeInteraction) {
        write("polish-$name", node.captureToImage().asAndroidBitmap())
    }

    /** A whole-device image, so the real soft keyboard is part of the evidence. */
    private fun captureDevice(name: String) {
        write("polish-$name", InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
    }

    private fun write(name: String, bitmap: Bitmap) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(requireNotNull(context.getExternalFilesDir(null)), "$name-${bitmap.width}.png").outputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        bitmap.recycle()
    }

    /** The share of pixels that differ between two renders of the same surface. */
    private fun changedPixelRatio(first: Bitmap, second: Bitmap): Float {
        assertEquals("Theme choice must not resize the settings screen", first.width, second.width)
        assertEquals("Theme choice must not resize the settings screen", first.height, second.height)
        val width = first.width
        val height = first.height
        val before = IntArray(width * ROW_BATCH)
        val after = IntArray(width * ROW_BATCH)
        var changed = 0L
        var row = 0
        while (row < height) {
            val rows = min(ROW_BATCH, height - row)
            first.getPixels(before, 0, width, 0, row, width, rows)
            second.getPixels(after, 0, width, 0, row, width, rows)
            for (index in 0 until width * rows) if (before[index] != after[index]) changed++
            row += rows
        }
        return changed.toFloat() / (width.toLong() * height)
    }

    private fun text(resource: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)

    /** The only fake records outgoing gestures; models, state and Compose components stay real. */
    private class RecordingActions : NativeChatActions {
        override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) { events.add("workspace:$choice") }
        val events = mutableListOf<String>()
        override fun sendSubmission(submission: DraftSubmission) { events.add("send:${submission.text}") }
        override fun manageSession(submission: SessionManagementSubmission) { events.add("manage:${submission.command}") }
        override fun refreshManagementWorkspaces() { events.add("refresh-workspaces") }
        override fun loadMoreManagementWorkspaces() { events.add("more-workspaces") }
        override fun refreshModels() { events.add("refresh-models") }
        override fun refreshActivationAccess() { events.add("refresh-activation") }
        override fun openSession(submission: SessionOpenSubmission) { events.add("open:$submission") }
        override fun loadNextModels() { events.add("next-models") }
        override fun selectModel(submission: ModelSelectionSubmission) { events.add("model:$submission") }
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

    private companion object {
        const val ROW_BATCH = 64
        val workspace = WorkspaceInfo("workspace-a", "Workspace A (fixture)", 0)
        const val LONG_TITLE = "Windows build verification for the staged companion with a very long descriptive title"
        const val USER_QUESTION = "Question kept in the transcript (fixture)"
        val MARKDOWN_ANSWER: String = buildString {
            appendLine("Here is the result.")
            appendLine()
            appendLine("> **Verified** native quote (fixture)")
            appendLine()
            appendLine("---")
            appendLine()
            appendLine("```kotlin")
            appendLine("val greeting = \"hello\"")
            appendLine("```")
            appendLine()
            appendLine("1. first step")
            appendLine("2. second step")
        }
    }
}
