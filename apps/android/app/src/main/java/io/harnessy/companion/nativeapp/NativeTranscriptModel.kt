package io.harnessy.companion.nativeapp

import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.Role
import io.harnessy.companion.presentation.DisplayModels.TextRow

internal sealed interface TranscriptEntry {
    val key: String

    data class Message(val row: TextRow) : TranscriptEntry {
        override val key = "text:${row.id}"
    }

    data class Activity(val rows: List<TextRow>) : TranscriptEntry {
        override val key = "activity:${rows.first().id}"
    }
}

/** Adjacency is available on the phone; Desktop turn and call/result identities are not. */
internal fun transcriptEntries(rows: List<TextRow>): List<TranscriptEntry> = buildList {
    val activity = mutableListOf<TextRow>()
    fun flushActivity() {
        if (activity.isNotEmpty()) {
            add(if (activity.size == 1) TranscriptEntry.Message(activity.single()) else TranscriptEntry.Activity(activity.toList()))
            activity.clear()
        }
    }
    for (row in rows) {
        when (row.role) {
            Role.TOOL -> activity.add(row)
            Role.USER, Role.ASSISTANT, Role.NOTICE -> {
                flushActivity()
                add(TranscriptEntry.Message(row))
            }
        }
    }
    flushActivity()
}

/** Exact shipped tool variants; unknown names keep the generic glyph and their original text. */
internal fun toolGlyph(name: String): Int = when (name) {
    "read", "read_image", "web_fetch", "cordis_package_inspect", "cordis_runtime_inspect" -> R.drawable.native_tool_read
    "web_search", "grep", "glob" -> R.drawable.native_tool_search
    "bash", "pwsh" -> R.drawable.native_tool_command
    "write", "edit" -> R.drawable.native_tool_edit
    "run_code" -> R.drawable.native_tool_code
    else -> R.drawable.native_tool_generic
}
