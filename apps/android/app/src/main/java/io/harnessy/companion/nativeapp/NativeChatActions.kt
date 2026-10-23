package io.harnessy.companion.nativeapp

import io.harnessy.companion.presentation.CompanionActions

/** A Send click carries the exact rendered foreground, target and draft, never a replayable payload. */
data class DraftSubmission(
    val foregroundGeneration: Long,
    val pcId: String,
    val sessionId: String,
    val text: String,
)

/** Management gestures belong to one rendered foreground and PC, not a retry queue. */
data class SessionManagementSubmission(
    val foregroundGeneration: Long,
    val pcId: String,
    val command: SessionManagementCommand,
)

sealed interface SessionManagementCommand {
    data class Create(val workspaceId: String) : SessionManagementCommand
    data class Rename(val sessionId: String, val title: String) : SessionManagementCommand
    data class Archive(val sessionId: String) : SessionManagementCommand
    data class Pin(val sessionId: String, val pinned: Boolean) : SessionManagementCommand
}

/** A model gesture is bound to the rendered chat and PC offer; it carries no provider route or reusable command. */
data class ModelSelectionSubmission(
    val foregroundGeneration: Long,
    val pcId: String,
    val sessionId: String,
    val revision: String,
    val choiceId: String,
)

/** An explicit opening gesture belongs to exactly the rendered PC, chat and foreground. */
data class SessionOpenSubmission(
    val foregroundGeneration: Long,
    val pcId: String,
    val sessionId: String,
)

/** Controller operations forwarded through the foreground repository. */
interface NativeControllerActions : CompanionActions {
    fun sendSubmission(submission: DraftSubmission)
    fun manageSession(submission: SessionManagementSubmission)
    fun refreshManagementWorkspaces()
    fun loadMoreManagementWorkspaces()
    fun refreshModels()
    fun refreshActivationAccess()
    fun openSession(submission: SessionOpenSubmission)
    fun loadNextModels()
    fun selectModel(submission: ModelSelectionSubmission)
}

/** The ViewModel additionally owns ordinary phone presentation preferences. */
interface NativeChatActions : NativeControllerActions {
    fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice)
}
