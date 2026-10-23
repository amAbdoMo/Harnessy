package io.harnessy.companion.nativeapp

import androidx.annotation.MainThread
import dagger.hilt.android.scopes.ViewModelScoped
import io.harnessy.companion.CompanionController
import io.harnessy.companion.protocol.ApplicationCodec
import io.harnessy.companion.protocol.Invitation
import io.harnessy.companion.protocol.StrictJson
import io.harnessy.companion.presentation.DisplayModels
import io.harnessy.companion.presentation.ModelAccess
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Immutable RAM snapshots; no draft, history, invitation or navigation argument is persisted. */
data class CompanionState(
    val screen: DisplayModels.Screen? = null,
    val pairing: DisplayModels.Pairing? = null,
    val draft: String = "",
    val foreground: Boolean = false,
    val connectionPaused: Boolean = false,
    val foregroundGeneration: Long = 0,
    val draftRejected: Boolean = false,
    val pairingRejected: Boolean = false,
    val workspaceExpansion: WorkspaceExpansion = WorkspaceExpansion(),
    val workspacePreferenceFailed: Boolean = false,
)

/** Main-thread controller adapter, owned by one ViewModel. Storage and transport stay Java-owned. */
@MainThread
@ViewModelScoped
class CompanionRepository @Inject constructor(
    private val controller: CompanionController,
) : NativeControllerActions {
    private val mutableState = MutableStateFlow(CompanionState())
    val state: StateFlow<CompanionState> = mutableState.asStateFlow()
    private var generation = 0L
    private var active = false

    fun start() {
        if (state.value.foreground) return
        mutableState.value = state.value.copy(foreground = true)
        if (!state.value.connectionPaused) startController()
    }

    /** Retires callbacks before stop; configuration changes must call this too. */
    fun stop() {
        retireController()
        mutableState.value = state.value.copy(foreground = false, screen = null, pairing = null, pairingRejected = false)
    }

    private fun startController() {
        if (active || !state.value.foreground) return
        active = true
        val owner = ++generation
        mutableState.value = state.value.copy(foregroundGeneration = owner)
        controller.attach(object : CompanionController.Output {
            override fun companion(screen: DisplayModels.Screen) {
                if (!active || owner != generation || !state.value.foreground) return
                mutableState.value = state.value.copy(screen = screen, pairing = null, draft = screen.composer.draft)
            }

            override fun pairing(pairing: DisplayModels.Pairing) {
                if (!active || owner != generation || !state.value.foreground) return
                val projected = if (state.value.pairingRejected) DisplayModels.Pairing(
                    pairing.link, pairing.state, DisplayModels.Feedback.PAIRING_INVALID, pairing.fingerprint,
                ) else pairing
                mutableState.value = state.value.copy(pairing = projected)
            }
        })
        controller.start()
    }

    private fun retireController() {
        active = false
        ++generation
        // Java stop invalidates its own epoch and closes the socket; it owns asynchronous quiescence.
        controller.stop()
        controller.detach()
    }

    fun pauseConnection() {
        if (!state.value.foreground) return
        retireController()
        mutableState.value = state.value.copy(connectionPaused = true, screen = null, pairing = null, pairingRejected = false)
    }

    fun resumeConnection() {
        if (!state.value.foreground) return
        mutableState.value = state.value.copy(connectionPaused = false)
        startController()
    }

    fun importLink(link: String) {
        if (!state.value.foreground) return
        if (state.value.connectionPaused) resumeConnection()
        if (!active) return
        mutableState.value = state.value.copy(pairingRejected = false)
        controller.importLink(link)
    }
    override fun pairFromLink(link: String) {
        val pairing = state.value.pairing ?: return
        if (!active || state.value.pairingRejected || pairing.state != DisplayModels.PairingState.EDITING ||
            pairing.feedback == DisplayModels.Feedback.PAIRING_INVALID || pairing.link != link) return
        controller.pairFromLink(link)
    }
    override fun selectSession(sessionId: String) { if (active) controller.selectSession(sessionId) }
    override fun refresh() { if (active) controller.refresh() }
    override fun sendText(text: String) { if (active) controller.sendText(text) }

    /** Rejects a click captured before a foreground, selection or draft change. */
    override fun sendSubmission(submission: DraftSubmission) {
        val current = state.value
        val screen = current.screen ?: return
        if (!active || !current.foreground || current.connectionPaused || current.draftRejected) return
        if (submission.foregroundGeneration != current.foregroundGeneration ||
            submission.pcId != screen.pc?.id || submission.sessionId != screen.conversation.session?.id ||
            submission.text != current.draft) return
        controller.sendText(submission.text)
    }
    override fun refreshModels() { if (active) controller.refreshModels() }
    override fun refreshActivationAccess() {
        val current = state.value
        if (active && current.foreground && !current.connectionPaused &&
            current.screen?.pc?.connection == DisplayModels.Connection.ONLINE) controller.refreshActivationAccess()
    }

    override fun openSession(submission: SessionOpenSubmission) {
        val current = state.value
        val screen = current.screen ?: return
        if (!active || !current.foreground || current.connectionPaused ||
            submission.foregroundGeneration != current.foregroundGeneration || submission.pcId != screen.pc?.id ||
            submission.sessionId != screen.conversation.session?.id || screen.pc.connection != DisplayModels.Connection.ONLINE ||
            screen.conversation.session.status != DisplayModels.SessionStatus.CLOSED ||
            screen.composer.state != DisplayModels.SendState.CLOSED || screen.activation.busy ||
            screen.activation.access != DisplayModels.ActivationAccess.ENABLED) return
        controller.openSession(submission.sessionId)
    }
    override fun loadNextModels() { if (active) controller.loadNextModels() }

    override fun selectModel(submission: ModelSelectionSubmission) {
        val current = state.value
        val screen = current.screen ?: return
        if (!active || !current.foreground || current.connectionPaused ||
            submission.foregroundGeneration != current.foregroundGeneration || submission.pcId != screen.pc?.id ||
            submission.sessionId != screen.conversation.session?.id || screen.composer.state != DisplayModels.SendState.READY ||
            screen.conversation.session.status != DisplayModels.SessionStatus.IDLE ||
            screen.models.access != ModelAccess.READY ||
            submission.revision != screen.models.revision || screen.models.choices.none { it.id == submission.choiceId }) return
        controller.selectModel(submission.sessionId, submission.revision, submission.choiceId)
    }

    /** Rechecks rendered authority and targets; Java owns final authorization and mutation delivery. */
    override fun manageSession(submission: SessionManagementSubmission) {
        val current = state.value
        val screen = managementScreen(current) ?: return
        if (submission.foregroundGeneration != current.foregroundGeneration || submission.pcId != screen.pc.id) return
        when (val command = submission.command) {
            is SessionManagementCommand.Create -> {
                if (current.draftRejected || current.draft.isNotEmpty() ||
                    screen.sessions.management.workspaces.none { it.id == command.workspaceId }) return
                controller.createSession(command.workspaceId)
            }
            is SessionManagementCommand.Rename -> {
                if (screen.sessions.rows.none { it.id == command.sessionId }) return
                controller.renameSession(command.sessionId, command.title)
            }
            is SessionManagementCommand.Archive -> {
                val row = screen.sessions.rows.firstOrNull { it.id == command.sessionId } ?: return
                if (row.status == DisplayModels.SessionStatus.BUSY ||
                    (screen.sessions.selectedId == row.id && current.draft.isNotEmpty())) return
                controller.archiveSession(row.id)
            }
            is SessionManagementCommand.Pin -> {
                if (screen.sessions.rows.none { it.id == command.sessionId }) return
                controller.setSessionPinned(command.sessionId, command.pinned)
            }
        }
    }

    override fun refreshManagementWorkspaces() {
        val current = state.value
        if (active && current.foreground && !current.connectionPaused &&
            current.screen?.pc?.connection == DisplayModels.Connection.ONLINE) controller.refreshManagementWorkspaces()
    }

    override fun loadMoreManagementWorkspaces() {
        val screen = managementScreen(state.value) ?: return
        if (screen.sessions.management.canLoadMore) controller.loadMoreManagementWorkspaces()
    }

    private fun managementScreen(current: CompanionState): DisplayModels.Screen? {
        val screen = current.screen ?: return null
        if (!active || !current.foreground || current.connectionPaused ||
            screen.pc?.connection != DisplayModels.Connection.ONLINE ||
            screen.sessions.management.access != DisplayModels.ManagementAccess.ENABLED || screen.sessions.management.busy) return null
        return screen
    }

    override fun forgetPairing(pcId: String) { if (active) controller.forgetPairing(pcId) }
    override fun showPairing() { if (active) controller.showPairing() }

    override fun draftChanged(draft: String) {
        if (!state.value.foreground) return
        try {
            StrictJson.requireText(draft, ApplicationCodec.MAX_TEXT_BYTES)
        } catch (invalid: IllegalArgumentException) {
            mutableState.value = state.value.copy(draftRejected = true)
            return
        }
        // The controller retains drafts without publishing; keystrokes must update the UI immediately.
        mutableState.value = state.value.copy(draft = draft, draftRejected = false)
        controller.draftChanged(draft)
    }

    override fun pairingLinkChanged(link: String) {
        if (!active) return
        val pairing = state.value.pairing ?: return
        if (pairing.state != DisplayModels.PairingState.EDITING) return
        try {
            StrictJson.requireText(link, Invitation.MAX_LINK_BYTES)
        } catch (invalid: IllegalArgumentException) {
            mutableState.value = state.value.copy(pairingRejected = true, pairing = DisplayModels.Pairing(
                pairing.link, pairing.state, DisplayModels.Feedback.PAIRING_INVALID, "",
            ))
            return
        }
        controller.pairingLinkChanged(link)
        mutableState.value = state.value.copy(pairingRejected = false, pairing = DisplayModels.Pairing(
            link, pairing.state, DisplayModels.Feedback.NONE, "",
        ))
    }

    override fun cancelPairing() {
        if (!active) return
        mutableState.value = state.value.copy(pairingRejected = false)
        controller.cancelPairing()
    }
    override fun loadMoreSessions() { if (active) controller.loadMoreSessions() }
    override fun loadMoreHistory() { if (active) controller.loadMoreHistory() }
    override fun resolveUnknown() { if (active) controller.resolveUnknown() }
}
