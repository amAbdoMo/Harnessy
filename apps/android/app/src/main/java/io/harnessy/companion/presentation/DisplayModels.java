package io.harnessy.companion.presentation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/** Immutable, in-memory presentation only; the controller validates and projects approved wire text. */
public final class DisplayModels {
    private DisplayModels() {}

    public enum Connection { ONLINE, OFFLINE, CONNECTING }
    public enum SessionStatus { IDLE, BUSY, CLOSED }
    public enum Role { USER, ASSISTANT, TOOL, NOTICE }
    public enum SendState { READY, OFFLINE, BUSY, CLOSED, DELIVERY_UNKNOWN, NO_SELECTION }
    public enum PairingState { EDITING, ENROLLING }
    public enum Feedback {
        NONE, REFRESH_FAILED, SEND_FAILED, PAIRING_FAILED, PAIRING_INVALID,
        REPAIR_REQUIRED, STORAGE_FAILED, PAIRING_CORRUPT, FORGET_FAILED, DISCONNECTED,
        DELIVERY_UNKNOWN, INBOX_ADMITTED, ALREADY_PAIRED
    }

    public static final class Pc {
        public final String id;
        public final String displayName;
        public final Connection connection;

        public Pc(String id, String displayName, Connection connection) {
            this.id = Objects.requireNonNull(id);
            this.displayName = Objects.requireNonNull(displayName);
            this.connection = Objects.requireNonNull(connection);
        }
    }

    public static final class SessionRow {
        public final String id;
        public final String title;
        public final SessionStatus status;

        public SessionRow(String id, String title, SessionStatus status) {
            this.id = Objects.requireNonNull(id);
            this.title = Objects.requireNonNull(title);
            this.status = Objects.requireNonNull(status);
        }
    }

    /** Text is already approved for phone display; no raw tool arguments or hidden transcript fields. */
    public static final class TextRow {
        public final String id;
        public final Role role;
        public final String text;

        public TextRow(String id, Role role, String text) {
            this.id = Objects.requireNonNull(id);
            this.role = Objects.requireNonNull(role);
            this.text = Objects.requireNonNull(text);
        }
    }

    public static final class SessionPane {
        public final List<SessionRow> rows;
        /** Null means no selection. IDs are presentation strings, not wire declarations. */
        public final String selectedId;
        public final boolean canLoadMore;

        public SessionPane(List<SessionRow> rows, String selectedId, boolean canLoadMore) {
            this.rows = snapshot(rows);
            this.selectedId = selectedId;
            this.canLoadMore = canLoadMore;
        }
    }

    public static final class Conversation {
        /** Null means no selected session. */
        public final SessionRow session;
        public final List<TextRow> rows;
        public final boolean canLoadMore;

        public Conversation(SessionRow session, List<TextRow> rows, boolean canLoadMore) {
            this.session = session;
            this.rows = snapshot(rows);
            this.canLoadMore = canLoadMore;
        }
    }

    /** The owner retains draft and delivery intent; gestures never clear or resend them automatically. */
    public static final class Composer {
        public final String draft;
        public final SendState state;
        public final Feedback feedback;
        public final DeliveryReview review;

        public Composer(String draft, SendState state, Feedback feedback, DeliveryReview review) {
            this.draft = Objects.requireNonNull(draft);
            this.state = Objects.requireNonNull(state);
            this.feedback = Objects.requireNonNull(feedback);
            this.review = review;
        }
    }

    /** Public identifiers only, including the original PC when its local pairing has been forgotten. */
    public static final class DeliveryReview {
        public final String pcId;
        public final String sessionId;
        public final String submissionId;
        public DeliveryReview(String pcId, String sessionId, String submissionId) {
            this.pcId = Objects.requireNonNull(pcId);
            this.sessionId = Objects.requireNonNull(sessionId);
            this.submissionId = Objects.requireNonNull(submissionId);
        }
    }

    public static final class Screen {
        /** Null means no paired PC, never an implicit trusted PC. */
        public final Pc pc;
        public final SessionPane sessions;
        public final Conversation conversation;
        public final Composer composer;

        public Screen(Pc pc, SessionPane sessions, Conversation conversation, Composer composer) {
            this.pc = pc;
            this.sessions = Objects.requireNonNull(sessions);
            this.conversation = Objects.requireNonNull(conversation);
            this.composer = Objects.requireNonNull(composer);
        }
    }

    /** Invitation text is transient; drop this snapshot after successful enrollment. */
    public static final class Pairing {
        public final String link;
        public final PairingState state;
        public final Feedback feedback;
        public final String fingerprint;

        public Pairing(String link, PairingState state, Feedback feedback, String fingerprint) {
            this.link = Objects.requireNonNull(link);
            this.state = Objects.requireNonNull(state);
            this.feedback = Objects.requireNonNull(feedback);
            this.fingerprint = Objects.requireNonNull(fingerprint);
        }
    }

    private static <T> List<T> snapshot(List<T> rows) {
        ArrayList<T> copy = new ArrayList<>(rows.size());
        for (T row : rows) copy.add(Objects.requireNonNull(row));
        return Collections.unmodifiableList(copy);
    }
}
