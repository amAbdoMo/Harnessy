package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

internal data class SessionNavigationActions(
    val refresh: () -> Unit,
    val select: (String) -> Unit,
    val loadMore: () -> Unit,
    val workspaceExpansion: WorkspaceExpansionControls,
    val sidebar: SidebarActions? = null,
)

/** Local filtering covers only the bounded, already-loaded list; it never starts a PC operation. */
@Composable
internal fun NativeSessionNavigation(pane: SessionPane, foreground: Boolean, actions: SessionNavigationActions, modifier: Modifier = Modifier) {
    var query by remember { mutableStateOf("") }
    var openOnly by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    val searchFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    Column(modifier.fillMaxHeight()) {
        NativeSidebarHeader(foreground, {
            if (searching) {
                searchFocus.requestFocus()
                keyboard?.show()
            } else searching = true
        }, actions.sidebar?.close)
        if (searching) ConversationSearchField(query, { query = it.take(256) }, searchFocus)
        Box(Modifier.weight(1f)) {
            WorkspaceSessionList(NavigationListState(pane, NavigationFilter(query, openOnly)), foreground, actions) {
                actions.sidebar?.let { sidebar -> item(key = "navigation:new_chat") {
                    NativePressableRow(enabled = foreground, onClick = sidebar.create,
                        modifier = Modifier.fillMaxWidth().testTag("new_chat")) {
                        Icon(Icons.Default.Edit, null, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurface)
                        Text(stringResource(R.string.native_new_chat), style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurface)
                    }
                } }
                item(key = "navigation:filters") { NavigationFilters(openOnly) { openOnly = it } }
                item(key = "navigation:recents") { RecentsNavigationHeader(foreground, actions) }
                if (actions.sidebar != null && pane.management.access != ManagementAccess.ENABLED) item(key = "navigation:permission") {
                    Text(stringResource(if (pane.management.access == ManagementAccess.CHECKING) R.string.native_manage_access_checking
                        else if (pane.management.access == ManagementAccess.DISABLED) R.string.native_manage_permission_title
                        else R.string.native_manage_unavailable), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                }
                if (query.isNotEmpty()) item(key = "navigation:search_scope") {
                    Text(stringResource(R.string.native_search_loaded), style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun RecentsNavigationHeader(foreground: Boolean, actions: SessionNavigationActions) {
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(foreground) { if (!foreground) expanded = false }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.native_recents), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f).semantics { heading() })
        actions.sidebar?.let { sidebar ->
            IconButton(onClick = sidebar.create, enabled = foreground, modifier = Modifier.testTag("new_chat_recents")) {
                Icon(Icons.Default.Edit, stringResource(R.string.native_new_chat), Modifier.size(18.dp))
            }
        }
        Box {
            IconButton(onClick = { expanded = true }, enabled = foreground, modifier = Modifier.testTag("recents_menu")) {
                Icon(Icons.Default.MoreVert, stringResource(R.string.native_recents_actions), Modifier.size(20.dp).rotate(90f))
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.refresh)) }, enabled = foreground,
                    onClick = { expanded = false; actions.refresh() }, modifier = Modifier.testTag("refresh_sessions"))
            }
        }
    }
}

@Composable
private fun ConversationSearchField(query: String, change: (String) -> Unit, focus: FocusRequester) {
    val keyboard = LocalSoftwareKeyboardController.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        LaunchedEffect(focus) {
            focus.requestFocus()
            keyboard?.show()
        }
        TextField(value = query, onValueChange = change,
            placeholder = { Text(stringResource(R.string.native_search_conversations), style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(18.dp)) },
            trailingIcon = if (query.isEmpty()) null else {
                { IconButton(onClick = { change("") }) { Icon(Icons.Default.Close, stringResource(R.string.native_clear_search)) } }
            }, singleLine = true, textStyle = MaterialTheme.typography.bodyMedium, shape = MaterialTheme.shapes.large,
            colors = TextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = if (maxHeight < 240.dp) 4.dp else 8.dp)
                .focusRequester(focus).testTag("session_search"))
    }
}

@Composable
private fun NavigationFilters(openOnly: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = !openOnly, onClick = { change(false) }, label = { Text(stringResource(R.string.native_filter_all)) },
            modifier = Modifier.testTag("filter_all_sessions"))
        FilterChip(selected = openOnly, onClick = { change(true) }, label = { Text(stringResource(R.string.native_filter_open)) },
            modifier = Modifier.testTag("filter_open_sessions"))
    }
}

private data class NavigationListState(val pane: SessionPane, val filter: NavigationFilter)

@Composable
private fun WorkspaceSessionList(state: NavigationListState, foreground: Boolean,
    actions: SessionNavigationActions, controls: LazyListScope.() -> Unit) {
    val pane = state.pane
    val filter = state.filter
    val groups = remember(pane.rows, filter) { navigationGroups(pane.rows, filter) }
    val expansion = actions.workspaceExpansion
    val expandedLists = remember { mutableStateMapOf<String?, Boolean>() }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(foreground) {
        if (!foreground) return@LaunchedEffect
        while (isActive) {
            now = System.currentTimeMillis()
            delay(60_000L)
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("session_list")) {
        controls()
        if (expansion.failed) item(key = "workspace_preferences_failed") {
            Text(stringResource(R.string.native_workspace_preference_failed), modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
        if (pane.rows.any { it.navigation == null }) item(key = "metadata_unavailable") {
            Text(stringResource(R.string.native_navigation_unavailable), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
        }
        if (groups.isEmpty()) item(key = "no_matching_sessions") {
            Text(stringResource(if (filter.query.isNotEmpty() || filter.openOnly) R.string.native_search_empty else R.string.sessions_empty),
                modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        groups.forEach { group ->
            val workspace = group.workspace
            val expanded = workspace == null || filter.query.isNotEmpty() || expansion.state.isExpanded(expansion.pcId, workspace.id)
            if (workspace != null) item(key = "workspace:${workspace.id}") {
                WorkspaceNavigationHeader(workspace, WorkspaceHeaderState(expanded, foreground && filter.query.isEmpty())) {
                    expansion.change(WorkspaceExpansionChoice(expansion.pcId, workspace.id, !expanded))
                }
            }
            if (expanded) {
                val pinnedCount = group.sessions.count { it.navigation?.pinOrder != null }
                val visibleCount = if (filter.query.isNotEmpty() || expandedLists[workspace?.id] == true) group.sessions.size else minOf(group.sessions.size, maxOf(5, pinnedCount))
                items(group.sessions.take(visibleCount), key = { "session:${it.id}" }) { row ->
                    val menu = actions.sidebar?.let { sidebar ->
                        SessionRowMenu(pane.management.access == ManagementAccess.ENABLED && !pane.management.busy) {
                            sidebar.manage(row, it)
                        }
                    }
                    WorkspaceSessionRow(row, NavigationRowState(pane.selectedId == row.id, foreground, workspace != null, now), {
                        if (foreground) {
                            focus.clearFocus(force = true)
                            keyboard?.hide()
                            actions.select(row.id)
                        }
                    }, menu)
                }
                val remaining = group.sessions.size - visibleCount
                if (remaining > 0) item(key = "more:${workspace?.id}") {
                    TextButton(onClick = { expandedLists[workspace?.id] = true }, enabled = foreground,
                        modifier = Modifier.padding(start = if (workspace == null) 6.dp else 20.dp).testTag("more_workspace_${workspace?.id}")) {
                        Text(pluralStringResource(R.plurals.native_more_sessions, remaining, remaining), style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
        if (pane.canLoadMore) item(key = "more_sessions") {
            TextButton(onClick = actions.loadMore, enabled = foreground, modifier = Modifier.padding(horizontal = 4.dp)) {
                Text(stringResource(R.string.load_sessions))
            }
        }
    }
}
