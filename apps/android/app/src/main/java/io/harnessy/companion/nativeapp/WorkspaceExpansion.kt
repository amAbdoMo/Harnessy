package io.harnessy.companion.nativeapp

/** An explicit phone-local display choice; it never changes the PC Workspace. */
data class WorkspaceExpansionChoice(val pcId: String, val workspaceId: String, val expanded: Boolean)

/** Stable PC/Workspace identities retain choices across navigation, refresh and process restart. */
data class WorkspaceExpansion(val expandedKeys: Set<String> = emptySet()) {
    fun isExpanded(pcId: String, workspaceId: String): Boolean = key(pcId, workspaceId) in expandedKeys

    fun updated(choice: WorkspaceExpansionChoice): WorkspaceExpansion {
        val identity = key(choice.pcId, choice.workspaceId)
        return copy(expandedKeys = if (choice.expanded) expandedKeys + identity else expandedKeys - identity)
    }

    private fun key(pcId: String, workspaceId: String): String = "${pcId.length}:$pcId$workspaceId"
}

internal data class WorkspaceExpansionControls(
    val pcId: String,
    val state: WorkspaceExpansion,
    val failed: Boolean,
    val change: (WorkspaceExpansionChoice) -> Unit,
)
