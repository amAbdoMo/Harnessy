package io.harnessy.companion.nativeapp

import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.Role
import io.harnessy.companion.presentation.DisplayModels.TextRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class NativeTranscriptModelTest {
    @Test
    fun onlyAdjacentToolNamesCollapseAndEveryNoticeRemainsVisible() {
        val rows = listOf(TextRow("u", Role.USER, "Check files"),
            TextRow("t1", Role.TOOL, "read"), TextRow("t2", Role.TOOL, "pwsh"),
            TextRow("n1", Role.NOTICE, "Tool completed"), TextRow("n2", Role.NOTICE, "Turn failed"),
            TextRow("a", Role.ASSISTANT, "The answer"), TextRow("t3", Role.TOOL, "unknown_tool"))
        val entries = transcriptEntries(rows)
        assertEquals(6, entries.size)
        assertEquals(listOf("read", "pwsh"), (entries[1] as TranscriptEntry.Activity).rows.map { it.text })
        assertSame(rows[3], (entries[2] as TranscriptEntry.Message).row)
        assertSame(rows[4], (entries[3] as TranscriptEntry.Message).row)
        val retained = entries.flatMap {
            when (it) {
                is TranscriptEntry.Activity -> it.rows
                is TranscriptEntry.Message -> listOf(it.row)
            }
        }
        rows.zip(retained).forEach { (before, after) -> assertSame(before, after) }
        assertEquals(rows.size, retained.size)
    }

    @Test
    fun emptyAndIsolatedEventsNeverCreateAnEmptyDisclosure() {
        assertEquals(emptyList<TranscriptEntry>(), transcriptEntries(emptyList()))
        for (role in Role.values()) {
            val row = TextRow("only", role, "Original text")
            assertSame(row, (transcriptEntries(listOf(row)).single() as TranscriptEntry.Message).row)
        }
    }

    @Test
    fun userAndAssistantMessagesSeparateIndependentToolRuns() {
        for (role in listOf(Role.USER, Role.ASSISTANT)) {
            val rows = listOf(TextRow("t1", Role.TOOL, "read"), TextRow("t2", Role.TOOL, "glob"),
                TextRow("m", role, "Separate work"), TextRow("t3", Role.TOOL, "write"), TextRow("t4", Role.TOOL, "edit"))
            val entries = transcriptEntries(rows)
            assertEquals(listOf("activity:t1", "text:m", "activity:t3"), entries.map { it.key })
        }
    }

    @Test
    fun appendingRetainsGroupIdentityButTrimmingItsFirstRowStartsANewGroup() {
        val rows = listOf(TextRow("t1", Role.TOOL, "read"), TextRow("t2", Role.TOOL, "glob"))
        val appended = rows + TextRow("t3", Role.TOOL, "pwsh")
        assertEquals(transcriptEntries(rows).single().key, transcriptEntries(appended).single().key)
        assertEquals("activity:t2", transcriptEntries(appended.drop(1)).single().key)
        assertEquals("text:t3", transcriptEntries(appended.drop(2)).single().key)
    }

    @Test
    fun exactKnownNamesSelectTheirToolFamilyAndUnrecognizedNamesStayGeneric() {
        val variants = mapOf(
            R.drawable.native_tool_read to listOf("read", "read_image", "web_fetch", "cordis_package_inspect", "cordis_runtime_inspect"),
            R.drawable.native_tool_search to listOf("web_search", "grep", "glob"),
            R.drawable.native_tool_command to listOf("bash", "pwsh"),
            R.drawable.native_tool_edit to listOf("write", "edit"),
            R.drawable.native_tool_code to listOf("run_code"),
            R.drawable.native_tool_generic to listOf("tool", "Read", "read_file", "web_searcher", "pwsh.exe", "mcp__provider.read"),
        )
        for ((glyph, names) in variants) for (name in names) assertEquals(name, glyph, toolGlyph(name))
    }
}
