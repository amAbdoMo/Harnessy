package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.List
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

/** Offers only already-loaded PC conversations; opening a row never creates or submits work. */
@Composable
internal fun NativeWorkLanding(screen: Screen, foreground: Boolean, actions: NativeChatActions, modifier: Modifier) {
    LazyColumn(modifier.testTag("work_landing"), contentPadding = PaddingValues(bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom)) {
        if (screen.composer.review == null && screen.composer.feedback == Feedback.NONE) {
            recentConversations(screen.sessions, foreground, actions)
        }
        if (screen.composer.feedback != Feedback.NONE && screen.composer.feedback != Feedback.DELIVERY_UNKNOWN) item {
            Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FeedbackNotice(screen.composer.feedback)
                if (screen.composer.feedback == Feedback.REFRESH_FAILED && screen.pc?.connection == Connection.ONLINE) {
                    TextButton(onClick = actions::refresh, modifier = Modifier.testTag("retry_conversation")) {
                        Text(stringResource(R.string.native_retry))
                    }
                }
            }
        }
        screen.composer.review?.let { review -> item {
            Box(Modifier.padding(horizontal = 16.dp)) { DeliveryReviewCard(review, actions::resolveUnknown) }
        } }
    }
}

private fun LazyListScope.recentConversations(pane: SessionPane, foreground: Boolean, actions: NativeChatActions) {
    item {
        Text(stringResource(if (pane.rows.isEmpty()) R.string.native_choose_conversation else R.string.native_continue_pc),
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 20.dp).semantics { heading() })
    }
    if (pane.rows.isEmpty()) item {
        Text(stringResource(R.string.native_select_explanation), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp))
    } else items(pane.rows.take(4), key = { it.id }) { row ->
        RecentConversationRow(row, foreground) { actions.selectSession(row.id) }
    }
}

@Composable
private fun RecentConversationRow(row: SessionRow, foreground: Boolean, select: () -> Unit) {
    val status = stringResource(sessionText(row.status))
    NativePressableRow(enabled = foreground, onClick = select,
        modifier = Modifier.fillMaxWidth().testTag("recent_session_${row.id}").semantics { stateDescription = status },
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp), spacing = 12.dp) {
        Icon(Icons.AutoMirrored.Outlined.List, null, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.title.ifBlank { stringResource(R.string.native_untitled_conversation) },
                style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(stringResource(if (row.status == SessionStatus.CLOSED) R.string.native_view_history else R.string.native_continue),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
