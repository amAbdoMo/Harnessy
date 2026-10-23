package io.harnessy.companion.nativeapp

import io.harnessy.companion.presentation.DisplayModels.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeNavigationGroupingTest {
    @Test
    fun duplicateWorkspaceTitlesKeepTheirIdentityAndPcOrderWhilePinsLeadByPcRank() {
        val first = WorkspaceInfo("first", "Same name", 0)
        val second = WorkspaceInfo("second", "Same name", 1)
        val rows = listOf(
            row("second-chat", second, null, 900), row("recent", first, null, 800),
            row("pin-later", first, 4, 700), row("pin-first", first, 1, 200),
            row("old", first, null, 100), row("loose", null, null, 1000),
        )
        val groups = navigationGroups(rows, NavigationFilter("", false))
        assertEquals(listOf("first", "second", null), groups.map { it.workspace?.id })
        assertEquals(listOf("pin-first", "pin-later", "recent", "old"), groups[0].sessions.map { it.id })
        assertEquals(listOf("loose"), groups.last().sessions.map { it.id })
    }

    @Test
    fun workspaceSearchAndOpenFilterUsePcMetadataWithoutInventingLegacyMembership() {
        val workspace = WorkspaceInfo("work", "Android project", 0)
        val rows = listOf(row("open", workspace, null, 100),
            SessionRow("closed", "Archived work", SessionStatus.CLOSED, SessionNavigation(workspace, null, 200)),
            SessionRow("legacy", "Android project", SessionStatus.IDLE))
        val groups = navigationGroups(rows, NavigationFilter("ANDROID", true))
        assertEquals(listOf("open"), groups.first().sessions.map { it.id })
        assertNull(groups.last().workspace)
        assertEquals(listOf("legacy"), groups.last().sessions.map { it.id })
        assertEquals(emptyList<WorkspaceGroup>(), navigationGroups(rows, NavigationFilter("missing", false)))
        assertEquals(emptyList<WorkspaceGroup>(), navigationGroups(emptyList(), NavigationFilter("", false)))
    }

    @Test
    fun relativeTimeMatchesDesktopBoundariesAndNeverShowsNegativeFutureActivity() {
        val day = 86_400_000L
        val now = 1000L * day
        val cases = listOf(
            -1L to SessionAge(SessionAgeUnit.NOW, 0), 0L to SessionAge(SessionAgeUnit.NOW, 0),
            59_999L to SessionAge(SessionAgeUnit.NOW, 0), 60_000L to SessionAge(SessionAgeUnit.MINUTES, 1),
            3_599_999L to SessionAge(SessionAgeUnit.MINUTES, 59), 3_600_000L to SessionAge(SessionAgeUnit.HOURS, 1),
            day - 1 to SessionAge(SessionAgeUnit.HOURS, 23), day to SessionAge(SessionAgeUnit.DAYS, 1),
            30L * day - 1 to SessionAge(SessionAgeUnit.DAYS, 29), 30L * day to SessionAge(SessionAgeUnit.MONTHS, 1),
            365L * day - 1 to SessionAge(SessionAgeUnit.MONTHS, 12), 365L * day to SessionAge(SessionAgeUnit.YEARS, 1),
        )
        for ((elapsed, expected) in cases) assertEquals("elapsed=$elapsed", expected, sessionAge(now - elapsed, now))
    }

    private fun row(id: String, workspace: WorkspaceInfo?, pinOrder: Long?, updatedAt: Long) =
        SessionRow(id, id, SessionStatus.IDLE, SessionNavigation(workspace, pinOrder, updatedAt))
}
