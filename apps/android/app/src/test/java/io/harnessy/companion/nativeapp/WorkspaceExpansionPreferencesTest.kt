package io.harnessy.companion.nativeapp

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class WorkspaceExpansionPreferencesTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun committedFolderChoicesSurviveReopeningWithoutChangingThemeOrOtherPcChoices() = runBlocking {
        val file = File(temporary.root, "folders.preferences_pb")
        val firstOwner = SupervisorJob()
        val firstStore = PreferenceDataStoreFactory.create(scope = CoroutineScope(firstOwner + Dispatchers.IO), produceFile = { file })
        val first = NativePreferences(firstStore)
        try {
            assertFalse(first.settings.first().workspaceExpansion.isExpanded("pc-a", "work"))
            first.setTheme(ThemePreference.DARK)
            first.setWorkspaceExpansion(WorkspaceExpansionChoice("pc-a", "work", true))
            first.setWorkspaceExpansion(WorkspaceExpansionChoice("pc-b", "work", true))
            first.setWorkspaceExpansion(WorkspaceExpansionChoice("pc-a", "other", true))
            first.setWorkspaceExpansion(WorkspaceExpansionChoice("pc-a", "work", false))
        } finally { firstOwner.cancelAndJoin() }

        val secondOwner = SupervisorJob()
        val secondStore = PreferenceDataStoreFactory.create(scope = CoroutineScope(secondOwner + Dispatchers.IO), produceFile = { file })
        try {
            val reopened = NativePreferences(secondStore).settings.first()
            assertEquals(ThemePreference.DARK, reopened.theme)
            assertFalse(reopened.readFailed)
            assertFalse(reopened.workspaceExpansion.isExpanded("pc-a", "work"))
            assertTrue(reopened.workspaceExpansion.isExpanded("pc-b", "work"))
            assertTrue(reopened.workspaceExpansion.isExpanded("pc-a", "other"))
            assertFalse(reopened.workspaceExpansion.isExpanded("pc-other", "other"))
        } finally { secondOwner.cancelAndJoin() }
    }

    @Test
    fun corruptPreferenceStorageReportsFailureWithoutResettingOrClaimingASavedFolderChoice() = runBlocking {
        val file = File(temporary.root, "broken.preferences_pb")
        val corruptBytes = byteArrayOf(-1, -1)
        file.writeBytes(corruptBytes)
        val owner = SupervisorJob()
        val store = PreferenceDataStoreFactory.create(scope = CoroutineScope(owner + Dispatchers.IO), produceFile = { file })
        val preferences = NativePreferences(store)
        try {
            assertTrue(preferences.settings.first().readFailed)
            try {
                preferences.setWorkspaceExpansion(WorkspaceExpansionChoice("pc", "work", true))
                fail("A failed filesystem write cannot confirm a saved choice")
            } catch (expected: IOException) {
                assertArrayEquals(corruptBytes, file.readBytes())
            }
        } finally { owner.cancelAndJoin() }
    }
}
