package io.harnessy.companion.nativeapp

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import io.harnessy.companion.presentation.DisplayModels.*

@Preview(name = "Unpaired phone", widthDp = 390, heightDp = 844)
@Composable
private fun UnpairedPhonePreview() {
    NativeTheme(ThemePreference.LIGHT) {
        NativeChatScreen(CompanionState(
            screen = Screen(null, SessionPane(emptyList(), null, false), Conversation(null, emptyList(), false),
                Composer("", SendState.NO_SELECTION, Feedback.NONE, null), false), foreground = true,
        ), PreviewActions, {}, {})
    }
}

@Preview(name = "Phone conversation", widthDp = 390, heightDp = 844)
@Preview(name = "Tablet conversation", widthDp = 1024, heightDp = 768)
@Composable
private fun ConversationPreview() {
    val session = SessionRow("preview-session", "Native Android layout", SessionStatus.BUSY)
    NativeTheme(ThemePreference.DARK) {
        NativeChatScreen(CompanionState(
            screen = Screen(Pc("preview-pc", "Preview PC", Connection.ONLINE),
                SessionPane(listOf(session), session.id, false),
                Conversation(session, listOf(
                    TextRow("preview-user", Role.USER, "Check the chat layout and keyboard spacing."),
                    TextRow("preview-assistant", Role.ASSISTANT, "## Layout review\n\nThe conversation fills the screen.\n\n```kotlin\nval state = viewModel.state\n```"),
                ), false), Composer("", SendState.READY, Feedback.NONE, null), false), foreground = true,
        ), PreviewActions, {}, {})
    }
}

/** Debug-only preview fixture: no ViewModel, socket, enrollment or external storage is created. */
private object PreviewActions : NativeChatActions {
    override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) = Unit
    override fun sendSubmission(submission: DraftSubmission) = Unit
    override fun manageSession(submission: SessionManagementSubmission) = Unit
    override fun refreshManagementWorkspaces() = Unit
    override fun loadMoreManagementWorkspaces() = Unit
    override fun refreshModels() = Unit
    override fun refreshActivationAccess() = Unit
    override fun openSession(submission: SessionOpenSubmission) = Unit
    override fun loadNextModels() = Unit
    override fun selectModel(submission: ModelSelectionSubmission) = Unit
    override fun pairFromLink(link: String) = Unit
    override fun selectSession(sessionId: String) = Unit
    override fun refresh() = Unit
    override fun sendText(text: String) = Unit
    override fun forgetPairing(pcId: String) = Unit
    override fun showPairing() = Unit
    override fun draftChanged(draft: String) = Unit
    override fun pairingLinkChanged(link: String) = Unit
    override fun cancelPairing() = Unit
    override fun loadMoreSessions() = Unit
    override fun loadMoreHistory() = Unit
    override fun resolveUnknown() = Unit
}
