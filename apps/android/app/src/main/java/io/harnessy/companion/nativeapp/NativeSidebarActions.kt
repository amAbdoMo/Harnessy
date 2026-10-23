package io.harnessy.companion.nativeapp

import io.harnessy.companion.presentation.DisplayModels.ManagementAccess
import io.harnessy.companion.presentation.DisplayModels.SessionRow

internal enum class SessionMenuAction { RENAME, ARCHIVE, PIN, UNPIN }
internal data class SessionRowMenu(val enabled: Boolean, val invoke: (SessionMenuAction) -> Unit)

/** View-only closing and explicit, target-bound management gestures share one sidebar actor. */
internal data class SidebarActions(
    val close: () -> Unit,
    val create: () -> Unit,
    val manage: (SessionRow, SessionMenuAction) -> Unit,
)

/** Captures the displayed target; confirmations never substitute the currently selected chat. */
internal fun sidebarManagementActions(
    state: CompanionState,
    actions: NativeChatActions,
    close: () -> Unit,
    showDialog: (SidebarManagementDialog) -> Unit,
): SidebarActions {
    val screen = state.screen
    val pcId = screen?.pc?.id
    return SidebarActions(close, create@{
        if (!state.foreground || pcId == null || screen == null) return@create
        when {
            state.draft.isNotEmpty() -> showDialog(SidebarManagementDialog.DraftRequired)
            screen.sessions.management.access != ManagementAccess.ENABLED -> showDialog(SidebarManagementDialog.PcPermissionRequired)
            else -> showDialog(SidebarManagementDialog.Create(state.foregroundGeneration, pcId))
        }
    }, manage@{ row, action ->
        if (!state.foreground || pcId == null || screen == null) return@manage
        val target = SidebarManagementTarget(state.foregroundGeneration, pcId, row)
        when (action) {
            SessionMenuAction.RENAME -> showDialog(SidebarManagementDialog.Rename(target))
            SessionMenuAction.ARCHIVE -> {
                if (screen.sessions.selectedId == row.id && state.draft.isNotEmpty()) showDialog(SidebarManagementDialog.DraftRequired)
                else showDialog(SidebarManagementDialog.Archive(target))
            }
            SessionMenuAction.PIN, SessionMenuAction.UNPIN -> actions.manageSession(SessionManagementSubmission(
                state.foregroundGeneration, pcId, SessionManagementCommand.Pin(row.id, action == SessionMenuAction.PIN),
            ))
        }
    })
}
