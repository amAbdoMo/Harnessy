package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.BuildConfig
import io.harnessy.companion.R
import io.harnessy.companion.presentation.DisplayModels.*
import io.harnessy.companion.presentation.ModelAccess
import io.harnessy.companion.presentation.ModelFeedback

private class ModelDialogLifetime { var current = true }

@Composable
internal fun NativeModelSelector(state: CompanionState, screen: Screen, actions: NativeChatActions, modifier: Modifier) {
    val identity = Triple(state.foregroundGeneration, screen.pc?.id, screen.conversation.session?.id)
    var open by remember(identity) { mutableStateOf(false) }
    val lifetime = remember(identity) { ModelDialogLifetime() }
    DisposableEffect(lifetime) { onDispose { lifetime.current = false } }
    val currentState by rememberUpdatedState(state)
    val currentActions by rememberUpdatedState(actions)
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val label = if (BuildConfig.PC_MODEL_SELECTION) screen.models.current?.title ?: stringResource(R.string.native_model_label)
        else stringResource(R.string.native_model_label)
    val ready = state.foreground && !state.connectionPaused && !screen.metadataLoading &&
        screen.pc?.connection == Connection.ONLINE && screen.conversation.session != null && screen.composer.state == SendState.READY
    TextButton(onClick = {
        if (lifetime.current && ready) {
            focus.clearFocus()
            keyboard?.hide()
            open = true
            if (BuildConfig.PC_MODEL_SELECTION) currentActions.refreshModels()
        }
    }, enabled = ready, modifier = modifier.heightIn(min = 48.dp).testTag("choose_model"),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Icon(painterResource(R.drawable.native_tool_generic), null, Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.width(4.dp))
        Icon(Icons.Default.KeyboardArrowDown, stringResource(R.string.native_model_choose), Modifier.size(18.dp))
    }
    if (open && lifetime.current && ready) {
        ModelSelectionDialog(screen, dismiss = { open = false }, refresh = {
            if (BuildConfig.PC_MODEL_SELECTION && open && lifetime.current) currentActions.refreshModels()
        }, next = {
            if (BuildConfig.PC_MODEL_SELECTION && open && lifetime.current) currentActions.loadNextModels()
        }, choose = { id ->
            val latest = currentState
            val current = latest.screen
            val revision = current?.models?.revision
            if (BuildConfig.PC_MODEL_SELECTION && open && lifetime.current && latest.foreground && revision != null &&
                latest.foregroundGeneration == identity.first && current.pc?.id == identity.second &&
                current.conversation.session?.id == identity.third && current.models.choices.any { it.id == id }) {
                open = false
                currentActions.selectModel(ModelSelectionSubmission(latest.foregroundGeneration,
                    requireNotNull(current.pc?.id), requireNotNull(current.conversation.session?.id), revision, id))
            }
        })
    }
}

@Composable
private fun ModelSelectionDialog(screen: Screen, dismiss: () -> Unit, refresh: () -> Unit,
    next: () -> Unit, choose: (String) -> Unit) {
    val pane = screen.models
    val height = minOf(320.dp, LocalConfiguration.current.screenHeightDp.dp * 0.4f)
    AlertDialog(onDismissRequest = dismiss, modifier = Modifier.testTag("model_dialog"),
        title = { Text(stringResource(R.string.native_model_choose)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!BuildConfig.PC_MODEL_SELECTION) Text(stringResource(R.string.native_model_pc_support_required))
                else when (pane.access) {
                    ModelAccess.EMPTY, ModelAccess.LOADING -> Box(Modifier.fillMaxWidth(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(24.dp).testTag("model_loading"))
                    }
                    ModelAccess.DENIED -> Text(stringResource(R.string.native_model_permission))
                    ModelAccess.BUSY -> Text(stringResource(R.string.native_model_busy))
                    ModelAccess.CLOSED -> Text(stringResource(R.string.native_model_closed))
                    ModelAccess.UNAVAILABLE -> Text(stringResource(if (pane.feedback == ModelFeedback.REJECTED)
                        R.string.native_model_rejected else R.string.native_model_unavailable))
                    ModelAccess.READY -> {
                        if (pane.choices.isEmpty()) Text(stringResource(R.string.native_model_empty))
                        else LazyColumn(Modifier.fillMaxWidth().heightIn(max = height).testTag("model_choices")) {
                            items(pane.choices, key = { it.id }) { choice ->
                                val selected = choice.id == pane.current?.id
                                val stateLabel = stringResource(if (selected) R.string.native_model_selected else R.string.native_model_not_selected)
                                NativePressableRow(screen.conversation.session?.status == SessionStatus.IDLE,
                                    { choose(choice.id) }, selected = selected,
                                    modifier = Modifier.testTag("model_choice:${choice.id}").semantics { stateDescription = stateLabel },
                                    contentPadding = PaddingValues(vertical = 8.dp, horizontal = 8.dp), spacing = 8.dp) {
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(choice.title, style = MaterialTheme.typography.bodyMedium)
                                        Text(choice.providerTitle, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (selected) Icon(Icons.Default.Check, null, Modifier.size(18.dp))
                                }
                            }
                        }
                    }
                }
                if (BuildConfig.PC_MODEL_SELECTION && pane.access != ModelAccess.LOADING && pane.access != ModelAccess.EMPTY) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = refresh, modifier = Modifier.testTag("model_refresh")) {
                            Text(stringResource(R.string.refresh))
                        }
                        if (pane.cursor != null) TextButton(onClick = next, modifier = Modifier.testTag("model_next")) {
                            Text(stringResource(R.string.native_model_next))
                        }
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } })
}
