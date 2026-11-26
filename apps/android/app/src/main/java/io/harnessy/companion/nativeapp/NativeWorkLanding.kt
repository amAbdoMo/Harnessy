package io.harnessy.companion.nativeapp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*

/** Presents the loaded PC conversations and explicit entry points for starting work. */
@Composable
internal fun NativeWorkLanding(
    screen: Screen,
    foreground: Boolean,
    actions: NativeChatActions,
    create: () -> Unit,
    select: (String) -> Unit,
    openBrowser: (() -> Unit)?,
    modifier: Modifier,
) {
    val online = screen.pc?.connection == Connection.ONLINE
    val canCreate = online && foreground
    val pane = screen.sessions
    val review = screen.composer.review
    LazyColumn(modifier.testTag("work_landing"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp,
            bottom = if (review == null && canCreate && pane.rows.isNotEmpty()) 84.dp else 20.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item(key = "work_landing_header") {
            Column(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.native_conversations), style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() })
                screen.pc?.displayName?.takeIf { it.isNotBlank() }?.let { name ->
                    Text(name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (screen.composer.feedback != Feedback.NONE && screen.composer.feedback != Feedback.DELIVERY_UNKNOWN) item {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FeedbackNotice(screen.composer.feedback)
                if (screen.composer.feedback == Feedback.REFRESH_FAILED && online) {
                    TextButton(onClick = actions::refresh, modifier = Modifier.testTag("retry_conversation")) {
                        Text(stringResource(R.string.native_retry))
                    }
                }
            }
        }
        if (review != null) {
            item { DeliveryReviewCard(review, actions::resolveUnknown) }
        } else if (pane.rows.isEmpty()) {
            item(key = "work_empty") { EmptyWorkCard(online, canCreate, create) }
        } else {
            recentConversations(pane, foreground, select)
        }
        if (review == null && pane.canLoadMore) item(key = "work_more_conversations") {
            TextButton(onClick = actions::loadMoreSessions, enabled = foreground) {
                Text(stringResource(R.string.load_sessions))
            }
        }
        if (openBrowser != null) item(key = "work_live_browser") {
            Surface(Modifier.fillMaxWidth().padding(top = 12.dp), shape = RoundedCornerShape(20.dp),
                color = MaterialTheme.colorScheme.surface) {
                NativePressableRow(enabled = foreground, onClick = openBrowser, minimumHeight = 56.dp,
                    modifier = Modifier.fillMaxWidth().testTag("work_open_browser"),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp), spacing = 12.dp) {
                    Icon(Icons.Default.PlayArrow, null, Modifier.size(22.dp), MaterialTheme.colorScheme.primary)
                    Text(stringResource(R.string.native_browser_share_title), Modifier.weight(1f),
                        style = MaterialTheme.typography.titleMedium)
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun EmptyWorkCard(online: Boolean, canCreate: Boolean, create: () -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.AutoMirrored.Outlined.List, null, Modifier.size(24.dp), MaterialTheme.colorScheme.primary)
            Text(stringResource(R.string.native_work_empty), style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.semantics { heading() })
            Text(stringResource(if (online) R.string.native_work_empty_online else R.string.native_work_empty_offline),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (online) {
                Button(onClick = create, enabled = canCreate, modifier = Modifier.heightIn(min = 48.dp).testTag("work_new_chat")) {
                    Icon(Icons.Default.Add, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.native_new_chat))
                }
            }
        }
    }
}

private fun LazyListScope.recentConversations(pane: SessionPane, foreground: Boolean, select: (String) -> Unit) {
    item(key = "work_landing_recents") {
        Text(stringResource(R.string.native_recents), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 4.dp).semantics { heading() })
    }
    items(pane.rows, key = { it.id }) { row ->
        RecentConversationRow(row, foreground) { select(row.id) }
    }
}

@Composable
private fun RecentConversationRow(row: SessionRow, foreground: Boolean, select: () -> Unit) {
    val status = stringResource(sessionText(row.status))
    NativePressableRow(enabled = foreground, onClick = select, minimumHeight = 56.dp,
        modifier = Modifier.fillMaxWidth().testTag("recent_session_${row.id}").semantics { stateDescription = status },
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp), spacing = 12.dp) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
            Box(Modifier.size(38.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Outlined.List, null, Modifier.size(20.dp), MaterialTheme.colorScheme.primary)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.title.ifBlank { stringResource(R.string.native_untitled_conversation) },
                style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                row.navigation?.workspace?.title?.takeIf { it.isNotBlank() }?.let { workspace ->
                    Text(workspace, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Box(Modifier.size(3.dp).background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
                }
                Text(stringResource(when (row.status) {
                    SessionStatus.CLOSED -> R.string.native_view_history
                    SessionStatus.BUSY -> sessionText(row.status)
                    SessionStatus.IDLE -> R.string.native_continue
                }), style = MaterialTheme.typography.bodySmall,
                    color = if (row.status == SessionStatus.BUSY) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
