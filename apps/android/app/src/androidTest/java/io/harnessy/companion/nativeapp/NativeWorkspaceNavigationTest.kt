package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import android.graphics.Bitmap
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.File
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeWorkspaceNavigationTest {
    @get:Rule val compose = createComposeRule()
    private val selections = mutableListOf<String>()
    private val now = System.currentTimeMillis()
    private val work = WorkspaceInfo("work", "Workspace A (test)", 0)

    @Test
    fun foldersCollapseWhileRealPinAndActivityRemainReadOnly() {
        render(listOf(navigationRow("pin", work, 4L * 86_400_000L, 0), navigationRow("recent", work, 3_600_000L)), "recent")
        compose.onNodeWithTag("session_recent").assertIsSelected()
        compose.onNodeWithTag("workspace_work").assertIsDisplayed()
        compose.onNodeWithTag("last_active_pin", useUnmergedTree = true).assertTextEquals(text(R.string.native_age_days, 4L))
        compose.onNodeWithTag("pinned_pin", useUnmergedTree = true).assertHasNoClickAction()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val capture = compose.onRoot().captureToImage().asAndroidBitmap()
        File(requireNotNull(context.getExternalFilesDir(null)), "workspace-fixture-${capture.width}.png").outputStream().use {
            check(capture.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        compose.onNodeWithTag("workspace_work").performClick()
        compose.onNodeWithTag("session_pin").assertDoesNotExist()
        compose.onNodeWithTag("workspace_work").performClick()
        compose.onNodeWithTag("session_pin").performClick()
        compose.runOnIdle { assertEquals(listOf("pin"), selections) }
    }

    @Test
    fun perWorkspaceOverflowExpandsWithoutFabricatingLegacyFolderOrActivity() {
        val rows = (0..6).map { navigationRow("chat-$it", work, (it + 1L) * 3_600_000L) } +
            SessionRow("legacy", "Unassigned existing chat", SessionStatus.IDLE)
        render(rows)
        compose.onNodeWithTag("session_chat-6").assertDoesNotExist()
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("more_workspace_work"))
        compose.onNodeWithTag("more_workspace_work").performClick()
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_chat-6"))
        compose.onNodeWithTag("session_chat-6").assertIsDisplayed()
        compose.onNodeWithTag("session_list").performScrollToNode(hasTestTag("session_legacy"))
        compose.onNodeWithTag("session_legacy").assertIsDisplayed()
        compose.onNodeWithTag("last_active_legacy", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("pinned_legacy", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("workspace_null").assertDoesNotExist()
        compose.runOnIdle { assertEquals(emptyList<String>(), selections) }
    }

    @Test
    fun workspaceNameSearchExpandsMatchesAndOpenFilterStillExcludesClosedRows() {
        val other = WorkspaceInfo("other", "Other workspace (test)", 1)
        render(listOf(navigationRow("open", work, 3_600_000L),
            SessionRow("closed", "Older chat", SessionStatus.CLOSED, SessionNavigation(work, null, now - 86_400_000L)),
            navigationRow("elsewhere", other, 3_600_000L)))
        compose.onNodeWithTag("workspace_work").performClick()
        compose.onNodeWithTag("sidebar_search").performClick()
        compose.onNodeWithTag("session_search").performTextReplacement("Workspace A")
        compose.onNodeWithTag("session_open").assertIsDisplayed()
        compose.onNodeWithTag("workspace_other").assertDoesNotExist()
        compose.onNodeWithTag("filter_open_sessions").performClick()
        compose.onNodeWithTag("session_closed").assertDoesNotExist()
        compose.onNodeWithTag("session_open").performClick()
        compose.runOnIdle { assertEquals(listOf("open"), selections) }
    }

    @Test
    fun folderChoicesRemainIndependentAfterNavigationIsRecreatedAndSearchIsCleared() {
        val visible = mutableStateOf(true)
        val other = WorkspaceInfo("other", "Other workspace (test)", 1)
        val rows = listOf(navigationRow("first", work, 3_600_000L), navigationRow("second", other, 3_600_000L))
        compose.setContent {
            NativeTheme(ThemePreference.DARK) {
                val folders = workspaceExpansionFixture()
                if (visible.value) Surface(Modifier.fillMaxSize()) {
                    NativeSessionNavigation(SessionPane(rows, null, false), true,
                        SessionNavigationActions({}, { selections.add(it) }, {}, folders))
                }
            }
        }
        compose.onNodeWithTag("session_first").assertDoesNotExist()
        compose.onNodeWithTag("session_second").assertDoesNotExist()
        compose.onNodeWithTag("workspace_work").performClick()
        compose.onNodeWithTag("workspace_other").performClick()
        compose.onNodeWithTag("session_first").assertIsDisplayed()
        compose.onNodeWithTag("workspace_work").performClick()
        compose.runOnIdle { visible.value = false }
        compose.runOnIdle { visible.value = true }
        compose.onNodeWithTag("session_first").assertDoesNotExist()
        compose.onNodeWithTag("session_second").assertIsDisplayed()
        compose.onNodeWithTag("sidebar_search").performClick()
        compose.onNodeWithTag("session_search").performTextReplacement("Workspace A")
        compose.onNodeWithTag("session_first").assertIsDisplayed()
        compose.onNodeWithTag("session_search").performTextReplacement("")
        compose.onNodeWithTag("session_first").assertDoesNotExist()
        compose.onNodeWithTag("session_second").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), selections) }
    }

    private fun render(rows: List<SessionRow>, selected: String? = null) {
        compose.setContent {
            NativeTheme(ThemePreference.DARK) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    NativeSessionNavigation(SessionPane(rows, selected, false), true,
                        SessionNavigationActions({}, { selections.add(it) }, {},
                            workspaceExpansionFixture(rows.mapNotNull { it.navigation?.workspace?.id }.distinct())))
                }
            }
        }
    }

    private fun navigationRow(id: String, workspace: WorkspaceInfo, elapsed: Long, pin: Long? = null) =
        SessionRow(id, id, SessionStatus.IDLE, SessionNavigation(workspace, pin, now - elapsed))

    private fun text(resource: Int, vararg arguments: Any): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource, *arguments)
}
