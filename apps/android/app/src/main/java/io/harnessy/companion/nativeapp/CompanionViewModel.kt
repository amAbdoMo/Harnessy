package io.harnessy.companion.nativeapp

import androidx.annotation.MainThread
import io.harnessy.companion.CompanionPlatform.OperationKind
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import java.io.IOException
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface Confirmation {
    data class Forget(val pcId: String, val name: String) : Confirmation
    data class Review(val pcId: String, val sessionId: String, val submissionId: String, val kind: OperationKind) : Confirmation
}

data class NativeUiState(
    val companion: CompanionState = CompanionState(),
    val theme: ThemePreference = ThemePreference.SYSTEM,
    val preferenceFailed: Boolean = false,
    val savingTheme: Boolean = false,
    val confirmation: Confirmation? = null,
    val workspaceExpansion: WorkspaceExpansion = WorkspaceExpansion(),
    val workspacePreferenceFailed: Boolean = false,
)

/** UDF screen owner. Sensitive text lives only in repository/controller RAM, never SavedStateHandle. */
@MainThread
@HiltViewModel
class CompanionViewModel @Inject constructor(
    private val repository: CompanionRepository,
    private val preferences: NativePreferences,
) : ViewModel(), NativeChatActions {
    private val mutableState = MutableStateFlow(NativeUiState(companion = repository.state.value))
    val state: StateFlow<NativeUiState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            repository.state.collect { companion ->
                mutableState.value = state.value.copy(companion = companion)
            }
        }
        viewModelScope.launch {
            preferences.settings.collect { settings ->
                mutableState.value = state.value.copy(theme = settings.theme, preferenceFailed = settings.readFailed,
                    workspaceExpansion = settings.workspaceExpansion)
            }
        }
    }

    private inline fun update(action: () -> Unit) {
        action()
        mutableState.value = state.value.copy(companion = repository.state.value)
    }

    fun start() = update { repository.start() }
    fun stop() {
        update { repository.stop() }
        dismissConfirmation()
    }
    fun importLink(link: String) = update { repository.importLink(link) }
    fun pauseConnection() {
        update { repository.pauseConnection() }
        dismissConfirmation()
    }
    fun resumeConnection() = update { repository.resumeConnection() }

    fun setTheme(theme: ThemePreference) {
        if (state.value.savingTheme) return
        mutableState.value = state.value.copy(savingTheme = true)
        viewModelScope.launch {
            try {
                preferences.setTheme(theme)
                mutableState.value = state.value.copy(theme = theme, preferenceFailed = false)
            } catch (failure: IOException) {
                mutableState.value = state.value.copy(preferenceFailed = true)
            } finally {
                mutableState.value = state.value.copy(savingTheme = false)
            }
        }
    }

    override fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) {
        val companion = state.value.companion
        val screen = companion.screen ?: return
        if (!companion.foreground || screen.pc?.id != choice.pcId ||
            screen.sessions.rows.none { it.navigation?.workspace?.id == choice.workspaceId }) return
        viewModelScope.launch {
            try {
                preferences.setWorkspaceExpansion(choice)
                mutableState.value = state.value.copy(workspacePreferenceFailed = false)
            } catch (failure: IOException) {
                mutableState.value = state.value.copy(workspacePreferenceFailed = true)
            }
        }
    }

    override fun forgetPairing(pcId: String) {
        val companion = state.value.companion
        val pc = companion.screen?.pc ?: return
        if (!companion.foreground || companion.connectionPaused || pc.id != pcId) return
        mutableState.value = state.value.copy(confirmation = Confirmation.Forget(pc.id, pc.displayName))
    }

    override fun resolveUnknown() {
        val companion = state.value.companion
        val review = companion.screen?.composer?.review ?: return
        if (!companion.foreground || companion.connectionPaused) return
        mutableState.value = state.value.copy(confirmation = Confirmation.Review(
            review.pcId, review.sessionId, review.submissionId, review.kind,
        ))
    }

    /** Rechecks identifiers and foreground ownership; a stale dialog never authorizes a new target. */
    fun confirm() {
        val confirmation = state.value.confirmation ?: return
        dismissConfirmation()
        val companion = state.value.companion
        if (!companion.foreground || companion.connectionPaused) return
        when (confirmation) {
            is Confirmation.Forget -> if (companion.screen?.pc?.id == confirmation.pcId) {
                update { repository.forgetPairing(confirmation.pcId) }
            }
            is Confirmation.Review -> {
                val review = companion.screen?.composer?.review ?: return
                if (review.pcId == confirmation.pcId && review.sessionId == confirmation.sessionId &&
                    review.submissionId == confirmation.submissionId && review.kind == confirmation.kind) update { repository.resolveUnknown() }
            }
        }
    }

    fun dismissConfirmation() { mutableState.value = state.value.copy(confirmation = null) }
    override fun pairFromLink(link: String) = update { repository.pairFromLink(link) }
    override fun selectSession(sessionId: String) = update { repository.selectSession(sessionId) }
    override fun refresh() = update { repository.refresh() }
    override fun sendText(text: String) = update { repository.sendText(text) }
    override fun sendSubmission(submission: DraftSubmission) = update { repository.sendSubmission(submission) }
    override fun manageSession(submission: SessionManagementSubmission) = update { repository.manageSession(submission) }
    override fun refreshManagementWorkspaces() = update { repository.refreshManagementWorkspaces() }
    override fun loadMoreManagementWorkspaces() = update { repository.loadMoreManagementWorkspaces() }
    override fun refreshModels() = update { repository.refreshModels() }
    override fun refreshActivationAccess() = update { repository.refreshActivationAccess() }
    override fun openSession(submission: SessionOpenSubmission) = update { repository.openSession(submission) }
    override fun loadNextModels() = update { repository.loadNextModels() }
    override fun selectModel(submission: ModelSelectionSubmission) = update { repository.selectModel(submission) }
    override fun showPairing() = update { repository.showPairing() }
    override fun draftChanged(draft: String) = update { repository.draftChanged(draft) }
    override fun pairingLinkChanged(link: String) = update { repository.pairingLinkChanged(link) }
    override fun cancelPairing() = update { repository.cancelPairing() }
    override fun loadMoreSessions() = update { repository.loadMoreSessions() }
    override fun loadMoreHistory() = update { repository.loadMoreHistory() }

    override fun onCleared() { repository.stop() }
}
