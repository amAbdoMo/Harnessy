package io.harnessy.companion.nativeapp

import io.harnessy.companion.R
import io.harnessy.companion.CompanionPlatform.OperationKind
import io.harnessy.companion.presentation.DisplayModels.*

internal fun connectionText(value: Connection): Int = when (value) {
    Connection.ONLINE -> R.string.online
    Connection.OFFLINE -> R.string.offline
    Connection.CONNECTING -> R.string.connecting
}
internal fun sessionText(value: SessionStatus): Int = when (value) {
    SessionStatus.IDLE -> R.string.session_idle
    SessionStatus.BUSY -> R.string.session_busy
    SessionStatus.CLOSED -> R.string.session_closed
}
internal fun roleText(value: Role): Int = when (value) {
    Role.USER -> R.string.role_user
    Role.ASSISTANT -> R.string.role_assistant
    Role.TOOL -> R.string.role_tool
    Role.NOTICE -> R.string.role_notice
}
internal fun sendText(value: SendState): Int = when (value) {
    SendState.READY -> R.string.composer_ready
    SendState.OFFLINE -> R.string.composer_offline
    SendState.BUSY -> R.string.composer_busy
    SendState.CLOSED -> R.string.composer_closed
    SendState.DELIVERY_UNKNOWN -> R.string.composer_unknown
    SendState.NO_SELECTION -> R.string.composer_no_selection
}
internal fun feedbackText(value: Feedback): Int? = when (value) {
    Feedback.NONE -> null
    Feedback.REFRESH_FAILED -> R.string.refresh_failed
    Feedback.SEND_FAILED -> R.string.send_failed
    Feedback.PAIRING_FAILED -> R.string.pairing_failed
    Feedback.PAIRING_INVALID -> R.string.pairing_invalid
    Feedback.REPAIR_REQUIRED -> R.string.repair_required
    Feedback.STORAGE_FAILED -> R.string.storage_failed
    Feedback.PAIRING_CORRUPT -> R.string.pairing_corrupt
    Feedback.FORGET_FAILED -> R.string.forget_failed
    Feedback.DISCONNECTED -> R.string.disconnected
    Feedback.DELIVERY_UNKNOWN -> R.string.delivery_unknown
    Feedback.INBOX_ADMITTED -> R.string.inbox_admitted
    Feedback.ALREADY_PAIRED -> R.string.already_paired
    Feedback.MANAGEMENT_DENIED -> R.string.native_manage_permission_required
    Feedback.MANAGEMENT_BUSY -> R.string.native_manage_busy
    Feedback.MANAGEMENT_DRAFT_REQUIRED -> R.string.native_manage_draft_required
    Feedback.MANAGEMENT_REJECTED -> R.string.native_management_rejected
    Feedback.MODEL_REJECTED -> R.string.native_model_rejected
    Feedback.OPEN_REJECTED -> R.string.native_open_chat_rejected
    Feedback.DRAFT_LIMIT -> R.string.native_draft_limit
}

internal fun managementOperationText(kind: OperationKind): Int = when (kind) {
    OperationKind.SUBMIT_TEXT -> R.string.send
    OperationKind.CREATE_SESSION -> R.string.native_new_chat
    OperationKind.RENAME_SESSION -> R.string.native_manage_rename_confirm
    OperationKind.ARCHIVE_SESSION -> R.string.native_manage_archive_confirm
    OperationKind.SET_SESSION_PINNED -> R.string.native_management_pin_action
    OperationKind.SELECT_SESSION_MODEL -> R.string.native_model_choose
    OperationKind.OPEN_SESSION -> R.string.native_open_chat
}
