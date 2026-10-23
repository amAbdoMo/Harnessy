package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*

/** History remains readable without granting or invoking writable chat activation. */
@Composable
internal fun NativeSessionActivation(
    state: CompanionState, screen: Screen, actions: NativeChatActions, openSessions: (() -> Unit)?,
) {
    val pc = screen.pc
    val session = screen.conversation.session
    LaunchedEffect(state.foregroundGeneration, pc?.id, session?.id, pc?.connection) {
        if (state.foreground && pc?.connection == Connection.ONLINE) actions.refreshActivationAccess()
    }
    val details = if (pc?.connection != Connection.ONLINE) R.string.native_open_chat_offline else when (screen.activation.access) {
        ActivationAccess.CHECKING -> R.string.native_open_chat_checking
        ActivationAccess.DISABLED -> R.string.native_open_chat_permission
        ActivationAccess.ENABLED -> R.string.native_open_chat_details
        ActivationAccess.UNAVAILABLE -> R.string.native_open_chat_unavailable
    }
    Column(Modifier.fillMaxWidth().testTag("session_activation"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.native_open_chat_title), style = MaterialTheme.typography.labelLarge)
                Text(stringResource(details), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            openSessions?.let { open ->
                IconButton(onClick = open, modifier = Modifier.size(48.dp).testTag("browse_sessions")) {
                    Icon(Icons.Default.Menu, stringResource(R.string.native_open_conversations), Modifier.size(20.dp))
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = open@{
                val pcId = pc?.id ?: return@open
                val sessionId = session?.id ?: return@open
                actions.openSession(SessionOpenSubmission(state.foregroundGeneration, pcId, sessionId))
            }, enabled = state.foreground && !state.connectionPaused && pc?.connection == Connection.ONLINE &&
                screen.activation.access == ActivationAccess.ENABLED && !screen.activation.busy &&
                screen.composer.state == SendState.CLOSED, modifier = Modifier.testTag("open_session")) {
                Text(stringResource(if (screen.activation.busy) R.string.native_open_chat_opening else R.string.native_open_chat))
            }
            if (!screen.activation.busy && screen.activation.access != ActivationAccess.ENABLED) {
                TextButton(onClick = actions::refreshActivationAccess,
                    enabled = state.foreground && pc?.connection == Connection.ONLINE &&
                        screen.activation.access != ActivationAccess.CHECKING,
                    modifier = Modifier.testTag("check_session_activation")) {
                    Text(stringResource(R.string.native_open_chat_check_access))
                }
            }
        }
    }
}
