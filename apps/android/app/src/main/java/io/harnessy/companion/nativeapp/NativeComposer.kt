package io.harnessy.companion.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.harnessy.companion.R
import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.presentation.DisplayModels.*
import io.harnessy.companion.protocol.ApplicationCodec

@Composable
internal fun NativeComposer(state: CompanionState, screen: Screen, actions: NativeChatActions, openSessions: (() -> Unit)?) {
    Surface(modifier = Modifier.testTag("composer_region"), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val imeHeight = with(LocalDensity.current) { WindowInsets.ime.getBottom(this).toDp() }
            val shortKeyboardWindow = imeHeight > 0.dp && maxHeight - imeHeight < 320.dp
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().navigationBarsPadding().imePadding()
                .padding(horizontal = 16.dp, vertical = if (shortKeyboardWindow) 4.dp else 8.dp),
                verticalArrangement = Arrangement.spacedBy(if (shortKeyboardWindow) 4.dp else 10.dp)) {
                if (screen.conversation.session?.status == SessionStatus.CLOSED &&
                    screen.composer.state != SendState.DELIVERY_UNKNOWN) NativeSessionActivation(state, screen, actions, openSessions)
                else {
                    if (state.draftRejected || (screen.composer.state != SendState.READY && screen.composer.state != SendState.NO_SELECTION)) {
                        ComposerHint(state, screen.composer.state, if (shortKeyboardWindow) 1 else Int.MAX_VALUE)
                    }
                    DraftComposer(state, screen, actions)
                }
            }
        }
    }
}

@Composable
private fun DraftComposer(state: CompanionState, screen: Screen, actions: NativeChatActions) {
    Surface(modifier = Modifier.fillMaxWidth().testTag("composer_shell"), shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp, shadowElevation = 2.dp) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val compact = maxHeight < 320.dp * LocalDensity.current.fontScale.coerceAtLeast(1f)
            Column {
                val inputModifier = Modifier.fillMaxWidth().heightIn(min = if (compact) 52.dp else 44.dp)
                    .padding(start = 16.dp, end = if (compact) 68.dp else 16.dp,
                        top = if (compact) 2.dp else 12.dp, bottom = if (compact) 2.dp else 12.dp)
                if (screen.conversation.session == null) {
                    Box(inputModifier, contentAlignment = Alignment.CenterStart) {
                        Text(stringResource(R.string.native_message_placeholder), style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else DraftInput(state, actions, if (compact) 1 else 5, inputModifier)
                if (!compact) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 12.dp, end = 68.dp, bottom = 12.dp),
                        contentAlignment = Alignment.CenterStart) {
                        NativeModelSelector(state, screen, actions, Modifier.widthIn(max = 280.dp))
                    }
                }
            }
            SendFollowupButton(state, screen, actions,
                Modifier.align(Alignment.BottomEnd).padding(if (compact) 2.dp else 12.dp))
        }
    }
}

/** One editor remains composed while its available width and line count change. */
@Composable
private fun DraftInput(state: CompanionState, actions: NativeChatActions, maxLines: Int, modifier: Modifier) {
    val screen = state.screen
    val review = screen?.composer?.review
    val archiving = review?.kind == OperationKind.ARCHIVE_SESSION && review.pcId == screen.pc?.id &&
        review.sessionId == screen.conversation.session?.id
    BasicTextField(value = state.draft, onValueChange = actions::draftChanged,
        modifier = modifier.testTag("chat_draft"),
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary), enabled = state.foreground && !archiving, minLines = 1, maxLines = maxLines,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
        decorationBox = { input ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (state.draft.isEmpty()) Text(stringResource(R.string.native_message_placeholder),
                    style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                input()
            }
        })
}

/** The snapshot captured by this click must still match the controller's foreground, PC, session and draft. */
@Composable
private fun SendFollowupButton(state: CompanionState, screen: Screen, actions: NativeChatActions, modifier: Modifier) {
    FilledIconButton(onClick = submit@{
        val pcId = screen.pc?.id ?: return@submit
        val sessionId = screen.conversation.session?.id ?: return@submit
        actions.sendSubmission(DraftSubmission(state.foregroundGeneration, pcId, sessionId, state.draft))
    }, enabled = state.foreground && !state.draftRejected && screen.composer.state == SendState.READY && state.draft.isNotBlank(),
        modifier = modifier.size(48.dp).testTag("send_text"), shape = CircleShape) {
        Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send), Modifier.size(20.dp))
    }
}

@Composable
private fun ComposerHint(state: CompanionState, sendState: SendState, maxLines: Int) {
    val hint = if (state.draftRejected) stringResource(R.string.native_draft_rejected, ApplicationCodec.MAX_TEXT_BYTES)
        else stringResource(sendText(sendState))
    Text(hint, style = if (state.draftRejected) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.labelSmall,
        textAlign = TextAlign.Center, maxLines = maxLines, overflow = TextOverflow.Ellipsis,
        color = if (state.draftRejected) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp).testTag("composer_hint").semantics {
            liveRegion = LiveRegionMode.Polite
            if (state.draftRejected) error(hint)
        })
}
