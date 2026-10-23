package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.SessionRow
import io.harnessy.companion.presentation.DisplayModels.SessionStatus
import io.harnessy.companion.presentation.DisplayModels.WorkspaceInfo

internal data class NavigationRowState(val selected: Boolean, val foreground: Boolean, val indented: Boolean, val now: Long)
internal data class WorkspaceHeaderState(val expanded: Boolean, val foreground: Boolean)

@Composable
internal fun WorkspaceNavigationHeader(workspace: WorkspaceInfo, state: WorkspaceHeaderState, toggle: () -> Unit) {
    val expansion = stringResource(if (state.expanded) R.string.native_expanded else R.string.native_collapsed)
    NativePressableRow(enabled = state.foreground, onClick = toggle,
        modifier = Modifier.fillMaxWidth().testTag("workspace_${workspace.id}")
            .semantics { heading(); stateDescription = expansion },
        contentPadding = PaddingValues(start = 20.dp, end = 12.dp), spacing = 10.dp) {
        Icon(painterResource(R.drawable.native_workspace_folder), null, Modifier.size(18.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        Text(workspace.title.ifBlank { stringResource(R.string.native_untitled_workspace) },
            style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f),
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(if (state.expanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, null,
            Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun WorkspaceSessionRow(row: SessionRow, state: NavigationRowState, select: () -> Unit, menu: SessionRowMenu? = null) {
    val status = stringResource(sessionText(row.status))
    NativePressableRow(selected = state.selected, enabled = state.foreground, onClick = select,
        modifier = Modifier.fillMaxWidth().testTag("session_${row.id}").semantics { stateDescription = status },
        contentPadding = PaddingValues(start = if (state.indented) 34.dp else 20.dp, end = 12.dp), spacing = 6.dp) {
        Text(row.title.ifBlank { stringResource(R.string.native_untitled_conversation) },
            style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        row.navigation?.let { navigation ->
            val age = sessionAgeLabel(navigation.updatedAt, state.now)
            val ageDescription = stringResource(R.string.native_last_active, age)
            Text(age, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("last_active_${row.id}").semantics { contentDescription = ageDescription })
            if (navigation.pinOrder != null) Icon(painterResource(R.drawable.native_pinned), stringResource(R.string.native_pinned),
                Modifier.size(12.dp).testTag("pinned_${row.id}"), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (menu != null) SessionRowActions(row, state.foreground, menu)
    }
}

@Composable
private fun SessionRowActions(row: SessionRow, foreground: Boolean, menu: SessionRowMenu) {
    var expanded by remember(row.id) { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(foreground, menu.enabled) { if (!foreground || !menu.enabled) expanded = false }
    Box {
        IconButton(onClick = { focus.clearFocus(); keyboard?.hide(); expanded = true },
            enabled = foreground && menu.enabled, modifier = Modifier.testTag("session_menu_${row.id}")) {
            Icon(Icons.Default.MoreVert, stringResource(R.string.native_manage_chat_actions), Modifier.size(18.dp).rotate(90f))
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            val pinned = row.navigation?.pinOrder != null
            val pinAction = if (pinned) SessionMenuAction.UNPIN else SessionMenuAction.PIN
            DropdownMenuItem(text = { Text(stringResource(if (pinned) R.string.native_manage_unpin else R.string.native_manage_pin)) },
                enabled = foreground && menu.enabled,
                onClick = { expanded = false; menu.invoke(pinAction) }, modifier = Modifier.testTag("pin_session_${row.id}"))
            DropdownMenuItem(text = { Text(stringResource(R.string.native_manage_rename_confirm)) },
                enabled = foreground && menu.enabled,
                onClick = { expanded = false; menu.invoke(SessionMenuAction.RENAME) }, modifier = Modifier.testTag("rename_session_${row.id}"))
            DropdownMenuItem(text = { Text(stringResource(R.string.native_manage_archive_confirm)) },
                enabled = foreground && menu.enabled && row.status != SessionStatus.BUSY,
                onClick = { expanded = false; menu.invoke(SessionMenuAction.ARCHIVE) }, modifier = Modifier.testTag("archive_session_${row.id}"))
        }
    }
}

@Composable
private fun sessionAgeLabel(updatedAt: Long, now: Long): String {
    val age = sessionAge(updatedAt, now)
    val resource = when (age.unit) {
        SessionAgeUnit.NOW -> R.string.native_age_now
        SessionAgeUnit.MINUTES -> R.string.native_age_minutes
        SessionAgeUnit.HOURS -> R.string.native_age_hours
        SessionAgeUnit.DAYS -> R.string.native_age_days
        SessionAgeUnit.MONTHS -> R.string.native_age_months
        SessionAgeUnit.YEARS -> R.string.native_age_years
    }
    return if (age.unit == SessionAgeUnit.NOW) stringResource(resource) else stringResource(resource, age.count)
}
