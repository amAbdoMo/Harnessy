package io.harnessy.companion.presentation;

import io.harnessy.companion.R;

import static io.harnessy.companion.presentation.DisplayModels.*;

final class UiText {
    private UiText() {}

    static int connection(Connection connection) {
        switch (connection) {
            case ONLINE: return R.string.online;
            case OFFLINE: return R.string.offline;
            case CONNECTING: return R.string.connecting;
        }
        throw new AssertionError(connection);
    }

    static int sessionStatus(SessionStatus status) {
        switch (status) {
            case IDLE: return R.string.session_idle;
            case BUSY: return R.string.session_busy;
            case CLOSED: return R.string.session_closed;
        }
        throw new AssertionError(status);
    }

    static int role(Role role) {
        switch (role) {
            case USER: return R.string.role_user;
            case ASSISTANT: return R.string.role_assistant;
            case TOOL: return R.string.role_tool;
            case NOTICE: return R.string.role_notice;
        }
        throw new AssertionError(role);
    }

    static int sendStatus(SendState state) {
        switch (state) {
            case READY: return R.string.composer_ready;
            case OFFLINE: return R.string.composer_offline;
            case BUSY: return R.string.composer_busy;
            case CLOSED: return R.string.composer_closed;
            case DELIVERY_UNKNOWN: return R.string.composer_unknown;
            case NO_SELECTION: return R.string.composer_no_selection;
        }
        throw new AssertionError(state);
    }

    static int feedback(Feedback feedback) {
        switch (feedback) {
            case NONE: return 0;
            case REFRESH_FAILED: return R.string.refresh_failed;
            case SEND_FAILED: return R.string.send_failed;
            case PAIRING_FAILED: return R.string.pairing_failed;
            case PAIRING_INVALID: return R.string.pairing_invalid;
            case REPAIR_REQUIRED: return R.string.repair_required;
            case STORAGE_FAILED: return R.string.storage_failed;
            case PAIRING_CORRUPT: return R.string.pairing_corrupt;
            case FORGET_FAILED: return R.string.forget_failed;
            case DISCONNECTED: return R.string.disconnected;
            case DELIVERY_UNKNOWN: return R.string.delivery_unknown;
            case INBOX_ADMITTED: return R.string.inbox_admitted;
            case ALREADY_PAIRED: return R.string.already_paired;
        }
        throw new AssertionError(feedback);
    }
}
