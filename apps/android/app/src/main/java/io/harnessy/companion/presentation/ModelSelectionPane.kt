package io.harnessy.companion.presentation

import io.harnessy.companion.protocol.ApplicationCodec

/** Only approved display labels and channel-local opaque choices; no provider routes or account configuration. */
data class ModelOption(
    @JvmField val id: String,
    @JvmField val title: String,
    @JvmField val providerTitle: String,
) {
    companion object {
        @JvmStatic
        fun from(choice: ApplicationCodec.ModelChoice): ModelOption = ModelOption(choice.id, choice.title, choice.providerTitle)
    }
}

enum class ModelAccess { EMPTY, LOADING, READY, DENIED, BUSY, CLOSED, UNAVAILABLE }
enum class ModelFeedback { NONE, REFRESH_FAILED, REJECTED }

/** A single bounded catalog page. Revision/cursor values belong only to the current connection and selected chat. */
class ModelSelectionPane(
    @JvmField val access: ModelAccess,
    choices: List<ModelOption>,
    @JvmField val current: ModelOption?,
    @JvmField val revision: String?,
    @JvmField val cursor: String?,
    @JvmField val feedback: ModelFeedback,
) {
    @JvmField val choices: List<ModelOption> = java.util.Collections.unmodifiableList(choices.toList())

    fun loading(): ModelSelectionPane = ModelSelectionPane(ModelAccess.LOADING, emptyList(), current, null, null, ModelFeedback.NONE)
    fun invalidated(): ModelSelectionPane = ModelSelectionPane(ModelAccess.EMPTY, emptyList(), current, null, null, ModelFeedback.NONE)
    fun failed(): ModelSelectionPane = ModelSelectionPane(ModelAccess.UNAVAILABLE, emptyList(), current, null, null, ModelFeedback.REFRESH_FAILED)
    fun rejected(): ModelSelectionPane = ModelSelectionPane(ModelAccess.UNAVAILABLE, emptyList(), current, null, null, ModelFeedback.REJECTED)
    fun applied(choice: ApplicationCodec.ModelChoice): ModelSelectionPane =
        ModelSelectionPane(ModelAccess.EMPTY, emptyList(), ModelOption.from(choice), null, null, ModelFeedback.NONE)

    companion object {
        @JvmStatic
        fun empty(): ModelSelectionPane = ModelSelectionPane(ModelAccess.EMPTY, emptyList(), null, null, null, ModelFeedback.NONE)

        @JvmStatic
        fun from(result: ApplicationCodec.Result): ModelSelectionPane = ModelSelectionPane(
            when (result.modelState) {
                "ready" -> ModelAccess.READY
                "denied" -> ModelAccess.DENIED
                "busy" -> ModelAccess.BUSY
                "closed" -> ModelAccess.CLOSED
                else -> error("Expected a validated model catalog result")
            },
            result.modelChoices.map(ModelOption::from), result.currentModel?.let(ModelOption::from),
            result.modelRevision, result.cursor, ModelFeedback.NONE,
        )
    }
}
