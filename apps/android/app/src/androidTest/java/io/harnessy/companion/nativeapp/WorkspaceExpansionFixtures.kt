package io.harnessy.companion.nativeapp

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/** Fixture-owned display state outlives any navigation subtree; no PC or persistent user data is touched. */
@Composable
internal fun workspaceExpansionFixture(
    initiallyExpanded: List<String> = emptyList(),
    pcId: String = "fixture-pc",
): WorkspaceExpansionControls {
    var state by remember {
        mutableStateOf(expandedWorkspaceFixture(pcId, initiallyExpanded))
    }
    return WorkspaceExpansionControls(pcId, state, false) { state = state.updated(it) }
}

internal fun expandedWorkspaceFixture(pcId: String, workspaceIds: List<String>): WorkspaceExpansion =
    workspaceIds.fold(WorkspaceExpansion()) { expansion, workspaceId ->
        expansion.updated(WorkspaceExpansionChoice(pcId, workspaceId, true))
    }
