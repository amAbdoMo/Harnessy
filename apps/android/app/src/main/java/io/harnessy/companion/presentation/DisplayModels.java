package io.harnessy.companion.presentation;

import io.harnessy.companion.CompanionPlatform;
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
    public enum ManagementAccess { CHECKING, DISABLED, ENABLED, UNAVAILABLE }
    public enum ActivationAccess { CHECKING, DISABLED, ENABLED, UNAVAILABLE }
    public enum Feedback {
        NONE, REFRESH_FAILED, SEND_FAILED, PAIRING_FAILED, PAIRING_INVALID,
        REPAIR_REQUIRED, STORAGE_FAILED, PAIRING_CORRUPT, FORGET_FAILED, DISCONNECTED,
        DELIVERY_UNKNOWN, INBOX_ADMITTED, ALREADY_PAIRED,
        MANAGEMENT_DENIED, MANAGEMENT_BUSY, MANAGEMENT_DRAFT_REQUIRED, MANAGEMENT_REJECTED, MODEL_REJECTED, OPEN_REJECTED, DRAFT_LIMIT
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

    public static final class WorkspaceInfo {
        public final String id;
        public final String title;
        public final long order;

        public WorkspaceInfo(String id, String title, long order) {
            this.id = Objects.requireNonNull(id);
            this.title = Objects.requireNonNull(title);
            this.order = order;
        }
    }

    /** PC-owned read-only navigation metadata; null workspace/pinOrder mean unassigned/unpinned. */
    public static final class SessionNavigation {
        public final WorkspaceInfo workspace;
        public final Long pinOrder;
        public final long updatedAt;

        public SessionNavigation(WorkspaceInfo workspace, Long pinOrder, long updatedAt) {
            this.workspace = workspace;
            this.pinOrder = pinOrder;
            this.updatedAt = updatedAt;
        }
    }

    public static final class SessionRow {
        public final String id;
        public final String title;
        public final SessionStatus status;
        /** Null means metadata was not supplied, not a fabricated group, pin or activity time. */
        public final SessionNavigation navigation;

        public SessionRow(String id, String title, SessionStatus status) {
            this(id, title, status, null);
        }

        public SessionRow(String id, String title, SessionStatus status, SessionNavigation navigation) {
            this.id = Objects.requireNonNull(id);
            this.title = Objects.requireNonNull(title);
            this.status = Objects.requireNonNull(status);
            this.navigation = navigation;
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

    public static final class ManagementPane {
        public static final ManagementPane NOT_READY = new ManagementPane(
            ManagementAccess.CHECKING, Collections.emptyList(), false, false);
        public final ManagementAccess access;
        public final List<WorkspaceInfo> workspaces;
        public final boolean canLoadMore;
        public final boolean busy;

        public ManagementPane(ManagementAccess access, List<WorkspaceInfo> workspaces, boolean canLoadMore, boolean busy) {
            this.access = Objects.requireNonNull(access);
            this.workspaces = snapshot(workspaces);
            this.canLoadMore = canLoadMore;
            this.busy = busy;
        }
    }

    public static final class SessionPane {
        public final List<SessionRow> rows;
        /** Null means no selection. IDs are presentation strings, not wire declarations. */
        public final String selectedId;
        public final boolean canLoadMore;
        public final ManagementPane management;

        public SessionPane(List<SessionRow> rows, String selectedId, boolean canLoadMore) {
            this(rows, selectedId, canLoadMore, ManagementPane.NOT_READY);
        }

        public SessionPane(List<SessionRow> rows, String selectedId, boolean canLoadMore, ManagementPane management) {
            this.rows = snapshot(rows);
            this.selectedId = selectedId;
            this.canLoadMore = canLoadMore;
            this.management = Objects.requireNonNull(management);
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
        public final CompanionPlatform.OperationKind kind;
        public DeliveryReview(String pcId, String sessionId, String submissionId) {
            this(pcId, sessionId, submissionId, CompanionPlatform.OperationKind.SUBMIT_TEXT);
        }
        public DeliveryReview(String pcId, String sessionId, String submissionId, CompanionPlatform.OperationKind kind) {
            this.pcId = Objects.requireNonNull(pcId);
            this.sessionId = Objects.requireNonNull(sessionId);
            this.submissionId = Objects.requireNonNull(submissionId);
            this.kind = Objects.requireNonNull(kind);
        }
    }

    /** Separate PC permission and the currently pending explicit opening, never inferred from history reads. */
    public static final class ActivationPane {
        public static final ActivationPane NOT_READY = new ActivationPane(ActivationAccess.CHECKING, false);
        public final ActivationAccess access;
        public final boolean busy;
        public ActivationPane(ActivationAccess access, boolean busy) {
            this.access = Objects.requireNonNull(access);
            this.busy = busy;
        }
    }

    public static final class Screen {
        /** Null means no paired PC, never an implicit trusted PC. */
        public final Pc pc;
        public final SessionPane sessions;
        public final Conversation conversation;
        public final Composer composer;
        public final boolean metadataLoading;
        public final ModelSelectionPane models;
        public final ActivationPane activation;

        public Screen(Pc pc, SessionPane sessions, Conversation conversation, Composer composer, boolean metadataLoading) {
            this(pc, sessions, conversation, composer, metadataLoading, ModelSelectionPane.empty());
        }

        public Screen(Pc pc, SessionPane sessions, Conversation conversation, Composer composer, boolean metadataLoading,
            ModelSelectionPane models) {
            this(pc, sessions, conversation, composer, metadataLoading, models, ActivationPane.NOT_READY);
        }

        public Screen(Pc pc, SessionPane sessions, Conversation conversation, Composer composer, boolean metadataLoading,
            ModelSelectionPane models, ActivationPane activation) {
            this.pc = pc;
            this.sessions = Objects.requireNonNull(sessions);
            this.conversation = Objects.requireNonNull(conversation);
            this.composer = Objects.requireNonNull(composer);
            this.metadataLoading = metadataLoading;
            this.models = Objects.requireNonNull(models);
            this.activation = Objects.requireNonNull(activation);
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
