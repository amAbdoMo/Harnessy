package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels
import io.harnessy.companion.presentation.DisplayModels.Connection
import io.harnessy.companion.presentation.DisplayModels.ManagementAccess
import io.harnessy.companion.presentation.DisplayModels.SessionStatus
import io.harnessy.companion.protocol.ApplicationCodec
import io.harnessy.companion.protocol.StrictJson

internal data class SidebarManagementTarget(
    val foregroundGeneration: Long,
    val pcId: String,
    val row: DisplayModels.SessionRow,
)

internal sealed interface SidebarManagementDialog {
    data class Create(val foregroundGeneration: Long, val pcId: String) : SidebarManagementDialog
    data class Rename(val target: SidebarManagementTarget) : SidebarManagementDialog
    data class Archive(val target: SidebarManagementTarget) : SidebarManagementDialog
    data object DraftRequired : SidebarManagementDialog
    data object PcPermissionRequired : SidebarManagementDialog
}

/** Dialog input is RAM-only; the parent owns visibility and the repository revalidates submissions. */
@Composable
internal fun NativeSessionManagementDialog(
    dialog: SidebarManagementDialog,
    state: CompanionState,
    actions: NativeChatActions,
    dismiss: () -> Unit,
) {
    val latestState = rememberUpdatedState(state)
    val latestActions = rememberUpdatedState(actions)
    val latestDismiss = rememberUpdatedState(dismiss)
    val context = remember(dialog) {
        ManagementDialogContext(dialogIdentity(dialog, state), { latestState.value },
            { latestActions.value }, { latestDismiss.value() })
    }
    DisposableEffect(context) { onDispose { context.retire() } }
    val current = context.isCurrent(state)
    LaunchedEffect(current, dialog) { if (!current) latestDismiss.value() }
    if (!current) return
    when (dialog) {
        is SidebarManagementDialog.Create -> CreateManagementDialog(dialog, context)
        is SidebarManagementDialog.Rename -> RenameManagementDialog(dialog, context)
        is SidebarManagementDialog.Archive -> ArchiveManagementDialog(dialog, context)
        SidebarManagementDialog.DraftRequired -> ManagementInformation(context,
            R.string.native_manage_draft_title, R.string.native_manage_draft_required)
        SidebarManagementDialog.PcPermissionRequired -> ManagementInformation(context,
            R.string.native_manage_permission_title, R.string.native_manage_permission_required)
    }
}

private data class ManagementDialogIdentity(val foregroundGeneration: Long, val pcId: String?)

private fun dialogIdentity(dialog: SidebarManagementDialog, state: CompanionState): ManagementDialogIdentity = when (dialog) {
    is SidebarManagementDialog.Create -> ManagementDialogIdentity(dialog.foregroundGeneration, dialog.pcId)
    is SidebarManagementDialog.Rename -> ManagementDialogIdentity(dialog.target.foregroundGeneration, dialog.target.pcId)
    is SidebarManagementDialog.Archive -> ManagementDialogIdentity(dialog.target.foregroundGeneration, dialog.target.pcId)
    SidebarManagementDialog.DraftRequired, SidebarManagementDialog.PcPermissionRequired ->
        ManagementDialogIdentity(state.foregroundGeneration, state.screen?.pc?.id)
}

private class ManagementDialogContext(
    private val identity: ManagementDialogIdentity,
    val state: () -> CompanionState,
    private val actions: () -> NativeChatActions,
    private val dismissDialog: () -> Unit,
) {
    private var retired = false
    fun retire() { retired = true }
    fun dismiss() { retire(); dismissDialog() }

    var submitted by mutableStateOf(false)
        private set

    fun isCurrent(current: CompanionState): Boolean = !retired && current.foreground && !current.connectionPaused &&
        current.pairing == null && current.foregroundGeneration == identity.foregroundGeneration &&
        identity.pcId != null && current.screen?.pc?.id == identity.pcId

    fun ready(current: CompanionState): Boolean {
        val screen = current.screen ?: return false
        return isCurrent(current) && !submitted && !screen.metadataLoading && screen.pc?.connection == Connection.ONLINE &&
            screen.sessions.management.access == ManagementAccess.ENABLED && !screen.sessions.management.busy
    }

    fun withCurrent(gesture: (CompanionState) -> Unit) {
        val current = state()
        if (!isCurrent(current)) dismiss() else gesture(current)
    }

    fun refreshWorkspaces() = withCurrent { current ->
        if (ready(current)) actions().refreshManagementWorkspaces()
    }

    fun loadMoreWorkspaces() = withCurrent { current ->
        if (ready(current) && current.screen?.sessions?.management?.canLoadMore == true)
            actions().loadMoreManagementWorkspaces()
    }

    fun create(workspaceId: String) = withCurrent { current ->
        if (ready(current) && current.draft.isEmpty() &&
            current.screen?.sessions?.management?.workspaces?.any { it.id == workspaceId } == true)
            send(SessionManagementCommand.Create(workspaceId))
    }

    fun rename(target: SidebarManagementTarget, title: String) = withCurrent { current ->
        if (ready(current) && currentRow(current, target) != null && title.isNotBlank() && validManagementTitle(title))
            send(SessionManagementCommand.Rename(target.row.id, title.trim()))
    }

    fun archive(target: SidebarManagementTarget) = withCurrent { current ->
        val row = currentRow(current, target)
        if (ready(current) && row != null && row.status != SessionStatus.BUSY && !archiveNeedsDraft(current, target))
            send(SessionManagementCommand.Archive(target.row.id))
    }

    private fun send(command: SessionManagementCommand) {
        submitted = true
        actions().manageSession(SessionManagementSubmission(identity.foregroundGeneration, requireNotNull(identity.pcId), command))
        dismiss()
    }
}

private fun currentRow(state: CompanionState, target: SidebarManagementTarget): DisplayModels.SessionRow? =
    state.screen?.sessions?.rows?.firstOrNull { it.id == target.row.id }
        ?: state.screen?.conversation?.session?.takeIf { it.id == target.row.id }

private fun archiveNeedsDraft(state: CompanionState, target: SidebarManagementTarget): Boolean = state.draft.isNotEmpty() &&
    (state.screen?.sessions?.selectedId == target.row.id || state.screen?.conversation?.session?.id == target.row.id)

private fun validManagementTitle(title: String): Boolean = try {
    StrictJson.requireText(title, ApplicationCodec.MAX_TITLE_BYTES)
    true
} catch (invalid: IllegalArgumentException) {
    false
}

@Composable
private fun CreateManagementDialog(dialog: SidebarManagementDialog.Create, context: ManagementDialogContext) {
    var selectedId by remember(dialog) { mutableStateOf<String?>(null) }
    val current = context.state()
    val management = current.screen!!.sessions.management
    val enabled = context.ready(current)
    val selectedKnown = selectedId != null && management.workspaces.any { it.id == selectedId }
    ManagementDialogFrame(context, R.string.native_manage_create_title, confirm = {
        TextButton(onClick = { selectedId?.let(context::create) },
            enabled = enabled && current.draft.isEmpty() && selectedKnown, modifier = Modifier.heightIn(min = 48.dp).testTag("manage_create_confirm")) {
            Text(stringResource(R.string.native_manage_create_confirm))
        }
    }) {
        ManagementAccessNotice(current)
        if (current.draft.isNotEmpty()) ManagementCopy(R.string.native_manage_draft_required)
        if (management.access == ManagementAccess.ENABLED) {
            ManagementCopy(R.string.native_manage_workspace_explanation)
            when {
                management.busy && management.workspaces.isEmpty() -> ManagementCopy(R.string.native_manage_workspaces_loading)
                management.workspaces.isEmpty() -> ManagementCopy(R.string.native_manage_workspaces_empty)
            }
            if (management.workspaces.isNotEmpty()) WorkspacePicker(context, selectedId) { selectedId = it }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = context::refreshWorkspaces, enabled = enabled,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("manage_workspaces_refresh")) {
                    Text(stringResource(R.string.native_manage_refresh_workspaces))
                }
                if (management.canLoadMore) TextButton(onClick = context::loadMoreWorkspaces, enabled = enabled,
                    modifier = Modifier.heightIn(min = 48.dp).testTag("manage_workspaces_more")) {
                    Text(stringResource(R.string.native_manage_load_workspaces))
                }
            }
        }
        ManagementCopy(R.string.native_manage_uncertain_hint)
    }
}

@Composable
private fun WorkspacePicker(context: ManagementDialogContext, selectedId: String?, select: (String) -> Unit) {
    val current = context.state()
    val workspaces = current.screen!!.sessions.management.workspaces.sortedWith(compareBy({ it.order }, { it.id }))
    // Keep bounded catalog rows in the dialog's single vertical viewport.
    Column(Modifier.fillMaxWidth().selectableGroup().testTag("manage_workspace_list")) {
        for (workspace in workspaces) key(workspace.id) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .selectable(selected = selectedId == workspace.id, enabled = context.ready(current), role = Role.RadioButton,
                    onClick = { context.withCurrent { latest ->
                        if (context.ready(latest) && latest.screen?.sessions?.management?.workspaces?.any { it.id == workspace.id } == true)
                            select(workspace.id)
                    } }).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selectedId == workspace.id, onClick = null, enabled = context.ready(current))
                Spacer(Modifier.width(12.dp))
                Text(workspace.title.ifBlank { stringResource(R.string.native_manage_untitled_workspace) },
                    style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun RenameManagementDialog(dialog: SidebarManagementDialog.Rename, context: ManagementDialogContext) {
    var title by remember(dialog) { mutableStateOf(dialog.target.row.title) }
    var rejected by remember(dialog) { mutableStateOf(false) }
    val current = context.state()
    val enabled = context.ready(current) && currentRow(current, dialog.target) != null
    ManagementDialogFrame(context, R.string.native_manage_rename_title, confirm = {
        TextButton(onClick = { if (!rejected) context.rename(dialog.target, title) },
            enabled = enabled && !rejected && title.trim().isNotEmpty(),
            modifier = Modifier.heightIn(min = 48.dp).testTag("manage_rename_confirm")) {
            Text(stringResource(R.string.native_manage_rename_confirm))
        }
    }) {
        ManagementAccessNotice(current)
        TargetName(dialog.target)
        if (currentRow(current, dialog.target) == null) ManagementCopy(R.string.native_manage_target_unavailable)
        OutlinedTextField(value = title, onValueChange = { proposed -> context.withCurrent { latest ->
            if (context.ready(latest) && currentRow(latest, dialog.target) != null) {
                rejected = !validManagementTitle(proposed)
                if (!rejected) title = proposed
            }
        } }, enabled = enabled, singleLine = true, isError = rejected || title.isBlank(),
            label = { Text(stringResource(R.string.native_manage_title_label)) },
            supportingText = { Text(stringResource(when {
                rejected -> R.string.native_manage_title_invalid
                title.isBlank() -> R.string.native_manage_title_blank
                else -> R.string.native_manage_title_limit
            }, ApplicationCodec.MAX_TITLE_BYTES)) },
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth().testTag("manage_rename_input"))
        ManagementCopy(R.string.native_manage_uncertain_hint)
    }
}

@Composable
private fun ArchiveManagementDialog(dialog: SidebarManagementDialog.Archive, context: ManagementDialogContext) {
    val current = context.state()
    if (archiveNeedsDraft(current, dialog.target)) {
        ManagementInformation(context, R.string.native_manage_draft_title, R.string.native_manage_draft_required)
        return
    }
    val row = currentRow(current, dialog.target)
    ManagementDialogFrame(context, R.string.native_manage_archive_title, confirm = {
        TextButton(onClick = { context.archive(dialog.target) },
            enabled = context.ready(current) && row != null && row.status != SessionStatus.BUSY,
            modifier = Modifier.heightIn(min = 48.dp).testTag("manage_archive_confirm")) {
            Text(stringResource(R.string.native_manage_archive_confirm))
        }
    }) {
        TargetName(dialog.target)
        ManagementCopy(R.string.native_manage_archive_explanation)
        ManagementAccessNotice(current)
        if (row == null) ManagementCopy(R.string.native_manage_target_unavailable)
        else if (row.status == SessionStatus.BUSY) ManagementCopy(R.string.native_manage_archive_busy)
        ManagementCopy(R.string.native_manage_uncertain_hint)
    }
}

@Composable
private fun TargetName(target: SidebarManagementTarget) {
    Text(target.row.title.ifBlank { stringResource(R.string.native_manage_untitled_chat) },
        style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("manage_target_name"))
}

@Composable
private fun ManagementInformation(context: ManagementDialogContext, title: Int, explanation: Int) {
    ManagementDialogFrame(context, title, confirm = {}) { ManagementCopy(explanation) }
}

@Composable
private fun ManagementAccessNotice(state: CompanionState) {
    val screen = state.screen ?: return
    val message = when (screen.sessions.management.access) {
        ManagementAccess.CHECKING -> R.string.native_manage_access_checking
        ManagementAccess.DISABLED -> R.string.native_manage_permission_required
        ManagementAccess.UNAVAILABLE -> R.string.native_manage_unavailable
        ManagementAccess.ENABLED -> when {
            screen.metadataLoading || screen.pc?.connection != Connection.ONLINE -> R.string.native_manage_connection_required
            screen.sessions.management.busy -> R.string.native_manage_busy
            else -> null
        }
    }
    message?.let { ManagementCopy(it) }
}

@Composable
private fun ManagementCopy(resource: Int) {
    Text(stringResource(resource), style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

@Composable
private fun ManagementDialogFrame(
    context: ManagementDialogContext,
    title: Int,
    confirm: @Composable () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cancelFocus = remember(context) { FocusRequester() }
    Dialog(onDismissRequest = context::dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.fillMaxWidth().safeDrawingPadding().imePadding().padding(24.dp), contentAlignment = Alignment.Center) {
            Surface(Modifier.widthIn(max = 560.dp).fillMaxWidth().heightIn(max = maxHeight.coerceAtMost(640.dp)),
                shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.surfaceContainerHigh, tonalElevation = 0.dp) {
                Column(Modifier.padding(24.dp).testTag("session_management_dialog"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(stringResource(title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                    Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = context::dismiss, modifier = Modifier.heightIn(min = 48.dp)
                            .focusRequester(cancelFocus).testTag("manage_cancel")) { Text(stringResource(R.string.native_manage_cancel)) }
                        confirm()
                    }
                }
            }
        }
        LaunchedEffect(context) { cancelFocus.requestFocus() }
    }
}
