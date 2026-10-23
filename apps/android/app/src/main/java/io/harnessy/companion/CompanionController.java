package io.harnessy.companion;

import io.harnessy.companion.protocol.ApplicationCodec;
import io.harnessy.companion.protocol.Invitation;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import io.harnessy.companion.presentation.CompanionActions;
import io.harnessy.companion.presentation.ModelAccess;
import io.harnessy.companion.presentation.ModelOption;
import io.harnessy.companion.presentation.ModelSelectionPane;
import io.harnessy.companion.transport.PhoneTransport;
import java.io.IOException;
import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.RejectedExecutionException;
import static io.harnessy.companion.CompanionPlatform.*;
import static io.harnessy.companion.presentation.DisplayModels.*;

/**
 * Main-thread state owner. UI completions require the current foreground epoch; confirmed storage
 * settlements survive retirement and reconcile with the next foreground metadata load.
 * Retirement invalidates synchronously; a new network attempt waits for the previous link's quiescence.
 * Mutations are never recreated by connection recovery; the only persistent task state is an uncertainty fence.
 */
public final class CompanionController implements CompanionActions {
    public interface Output {
        void companion(Screen screen);
        void pairing(Pairing pairing);
    }
    private final CompanionPlatform platform;
    private final ControllerLimits limits;
    private final String pcLabel;
    private final ConversationMemory conversations;
    private Output output;
    private volatile long epoch;
    private long metadataReadyEpoch;
    private boolean foreground;
    private boolean pairingVisible;
    private boolean enrolling;
    private boolean repairRequired;
    private boolean storageBlocked;
    private boolean confirmed;
    private boolean connecting;
    private long attempt;
    private long nextAttemptAt;
    private Paired paired;
    private Repair repairTarget;
    private Identity enrollmentIdentity;
    private Invitation invitation;
    private String pairingLink = "";
    private String fingerprint = "";
    private String draft = "";
    private String selected;
    private String sessionsCursor;
    private String historyCursor;
    private String managementCursor;
    private ModelSelectionPane models = ModelSelectionPane.empty();
    private ManagementAccess managementAccess = ManagementAccess.CHECKING;
    private ActivationAccess activationAccess = ActivationAccess.CHECKING;
    private final Map<String, WorkspaceInfo> managementWorkspaces = new LinkedHashMap<>();
    private final java.util.Set<String> visibleSessions = new java.util.HashSet<>();
    private boolean sessionListingReady;
    private long interactionVersion;
    private ActiveWatch activeWatch;
    private SessionScan sessionScan;
    private String statusSession;
    private StorageTransaction storageTransaction;
    private Fence fence;
    private Mutation mutation;
    private Link link;
    private CompletionStage<Void> retired = CompletableFuture.completedFuture(null);
    private Cancellable reconnect;
    private Cancellable heartbeat;
    private Cancellable expiry;
    private Cancellable watchRenewal;
    private Feedback feedback = Feedback.NONE;
    private long readFailureVersion;
    private final Map<String, SessionRow> sessions = new LinkedHashMap<>();
    private final Map<String, ApplicationCodec.HistoryRow> history = new LinkedHashMap<>();
    private final Map<String, Read> reads = new LinkedHashMap<>();

    public CompanionController(CompanionPlatform platform, ControllerLimits limits, String pcLabel) {
        this.platform = Objects.requireNonNull(platform);
        this.limits = Objects.requireNonNull(limits);
        this.pcLabel = Objects.requireNonNull(pcLabel);
        this.conversations = new ConversationMemory(limits.sessionWindow);
    }

    /** Main-thread attachment does not start network activity. */
    public void attach(Output output) { this.output = Objects.requireNonNull(output); }
    public void detach() { output = null; }

    public void start() {
        if (foreground) return;
        foreground = true;
        long current = ++epoch;
        publish();
        work(current, () -> {
            List<Paired> saved = platform.pairings();
            List<Fence> uncertain = platform.fences();
            List<Repair> repairs = platform.repairs();
            Repair pendingRepair = repairs.isEmpty() ? null : repairs.get(0);
            Paired chosen = firstPairing(saved, pendingRepair);
            return () -> {
                String imported = pairingLink;
                settleStorage();
                paired = chosen;
                if (pendingRepair != null || !storageBlocked) repairTarget = pendingRepair;
                repairRequired |= pendingRepair != null;
                conversations.restoreFences(uncertain);
                if (fence != null) conversations.rememberFence(fence);
                if (selected == null) {
                    Fence recovery = conversations.firstFence(paired == null ? null : paired.pcId);
                    if (recovery != null) selected = recovery.sessionId;
                }
                fence = selectedFence();
                draft = conversations.draft(paired == null ? null : paired.pcId, selected);
                if (fence != null) feedback = Feedback.DELIVERY_UNKNOWN;
                if (repairRequired || storageBlocked) feedback = Feedback.REPAIR_REQUIRED;
                metadataReadyEpoch = current;
                if (!imported.isEmpty()) {
                    pairingLink = "";
                    importLink(imported);
                } else if (!pairingVisible && paired != null && !repairRequired && !storageBlocked) reconnect();
                publish();
            };
        }, Feedback.PAIRING_CORRUPT);
    }

    private static Paired firstPairing(List<Paired> saved, Repair repair) {
        if (repair == null) return saved.isEmpty() ? null : saved.get(0);
        for (Paired previous : saved) {
            if (previous.pcId.equals(repair.pcId)) {
                if (!previous.alias.equals(repair.alias)) throw new IllegalArgumentException("Repair alias mismatch");
                return previous;
            }
        }
        return null;
    }

    /** Stop network activity immediately; admitted storage work settles independently. Draft/selection stay in RAM. */
    public void stop() {
        if (!foreground) return;
        foreground = false;
        ++epoch;
        retireAttempt();
        dropInvitation();
        pairingVisible = false;
        pairingLink = "";
        cleanupEnrollment();
    }

    private void retireAttempt() {
        ++attempt;
        confirmed = connecting = false;
        if (reconnect != null) reconnect.cancel();
        reconnect = null;
        if (heartbeat != null) heartbeat.cancel();
        heartbeat = null;
        for (Read read : reads.values()) read.deadline.cancel();
        reads.clear(); activeWatch = null; statusSession = null;
        // Cursors are signed by this PC channel; retained text has no such lifetime.
        sessionsCursor = historyCursor = managementCursor = null; sessionScan = null;
        managementWorkspaces.clear(); managementAccess = ManagementAccess.CHECKING;
        activationAccess = ActivationAccess.CHECKING;
        models = ModelSelectionPane.empty();
        visibleSessions.clear(); sessionListingReady = false;
        if (watchRenewal != null) watchRenewal.cancel();
        watchRenewal = null;
        if (mutation != null) deliveryUnknown();
        if (link != null) {
            Link previous = link;
            link = null;
            previous.close();
            retired = previous.quiescence();
        }
    }

    private boolean current(long owner, long connection) {
        return foreground && epoch == owner && attempt == connection;
    }

    private void reconnect() {
        if (!foreground || metadataReadyEpoch != epoch || pairingVisible || paired == null || repairRequired || storageBlocked) return;
        long remaining = nextAttemptAt - platform.elapsed();
        if (remaining > 0) {
            long owner = epoch, connection = attempt;
            if (reconnect != null) reconnect.cancel();
            reconnect = platform.later((int) Math.min(limits.reconnectMs, remaining), () -> {
                if (current(owner, connection)) reconnect();
            });
            connecting = true; publish(); return;
        }
        retireAttempt();
        connecting = true;
        long owner = epoch;
        long connection = attempt;
        Paired stored = paired;
        retired.whenComplete((ignored, failure) -> platform.main(() -> {
            if (!current(owner, connection)) return;
            if (failure != null) { failStorage(Feedback.REPAIR_REQUIRED); return; }
            work(owner, () -> {
                Identity identity = platform.identity(stored.alias);
                Protocol.Inputs inputs = inputs(identity, stored.origin, stored.pcKey,
                    Protocol.Authorization.grant(stored.grantId, stored.generation));
                return new RetiredCleanup() {
                    public void run() { if (current(owner, connection)) open(inputs, owner, connection); else close(); }
                    public void close() { inputs.authorization.close(); }
                };
            }, Feedback.REPAIR_REQUIRED);
        }));
        publish();
    }

    private Protocol.Inputs inputs(Identity identity, String origin, String pcKey, Protocol.Authorization authorization)
        throws GeneralSecurityException {
        try {
            return new Protocol.Inputs(identity.spki, transcript -> platform.sign(identity.alias, transcript),
                origin, pcKey, Protocol.randomId(16), authorization);
        } catch (GeneralSecurityException | IllegalArgumentException invalidInputs) {
            authorization.close(); throw invalidInputs;
        }
    }

    private void open(Protocol.Inputs inputs, long owner, long connection) {
        nextAttemptAt = platform.elapsed() + limits.reconnectMs;
        Events events = new Events() {
                public void confirmed(String grantId, long generation, String pcKey) {
                    if (current(owner, connection)) confirm(grantId, generation, pcKey);
                }
                public void application(byte[] bytes) {
                    try { if (current(owner, connection)) receive(ApplicationCodec.result(bytes)); }
                    catch (IllegalArgumentException malformedApplication) { disconnected(); }
                    finally { Arrays.fill(bytes, (byte) 0); }
                }
                public void disconnected() {
                    if (current(owner, connection)) disconnectedAttempt();
                }
            };
        CompletableFuture<Void> released = new CompletableFuture<>();
        retired = released;
        try { platform.io(() -> {
            if (epoch != owner) { inputs.authorization.close(); released.complete(null); return; }
            try {
                Link created = platform.connect(inputs, events);
                created.quiescence().whenComplete((ignored, failure) -> {
                    if (failure == null) released.complete(null); else released.completeExceptionally(failure);
                });
                platform.main(() -> {
                    if (!current(owner, connection)) { created.close(); return; }
                    link = created;
                    if (!created.start()) disconnectedAttempt();
                });
            } catch (GeneralSecurityException invalidInputs) {
                inputs.authorization.close(); released.complete(null);
                platform.main(() -> { if (current(owner, connection)) failStorage(Feedback.REPAIR_REQUIRED); });
            }
        }); } catch (RejectedExecutionException unavailableOwner) {
            inputs.authorization.close(); released.complete(null); failStorage(Feedback.STORAGE_FAILED);
        }
    }

    private void confirm(String grantId, long generation, String pcKey) {
        connecting = false;
        if (enrolling) { saveEnrollment(grantId, generation, pcKey); return; }
        confirmed = true;
        feedback = fence == null ? Feedback.NONE : Feedback.DELIVERY_UNKNOWN;
        refresh();
        // Deployment requires the matching PC runtime first; there is no legacy capability probe or fallback.
        refreshManagementWorkspaces();
        scheduleHeartbeat();
        publish();
    }

    private void disconnectedAttempt() {
        boolean wasEnrollment = enrolling;
        retireAttempt();
        if (wasEnrollment) {
            dropInvitation(); cleanupEnrollment(); enrolling = false; pairingLink = "";
            feedback = Feedback.PAIRING_FAILED;
        } else {
            if (fence == null) feedback = Feedback.DISCONNECTED;
            if (foreground && !pairingVisible && !repairRequired && !storageBlocked) {
                reconnect = platform.later(limits.reconnectMs, this::reconnect);
            }
        }
        publish();
    }

    private void scheduleHeartbeat() {
        long owner = epoch, connection = attempt;
        heartbeat = platform.later(limits.heartbeatMs, () -> {
            if (!current(owner, connection) || !confirmed) return;
            if (!hasRead(ApplicationCodec.Type.SESSIONS)) heartbeatRead();
            scheduleHeartbeat();
        });
    }

    @Override public void showPairing() {
        if (!foreground || storagePending() || storageBlocked || repairRequired) { publish(); return; }
        retireAttempt();
        pairingVisible = true; feedback = Feedback.NONE; publish();
    }

    /** Custom intents import text only; they never authorize enrollment or navigate an arbitrary URL. */
    public void importLink(String text) {
        if (!foreground) return;
        try { StrictJson.requireText(text, Invitation.MAX_LINK_BYTES); }
        catch (IllegalArgumentException invalid) { feedback = Feedback.PAIRING_INVALID; publish(); return; }
        if (metadataReadyEpoch != epoch) { pairingLink = text; return; }
        if (enrolling || storageBlocked || repairRequired) return;
        showPairing(); pairingLink = text;
        long owner = epoch;
        work(owner, () -> {
            Invitation parsed = Invitation.parse(text, platform.now());
            return new RetiredCleanup() {
                public void run() {
                    if (!pairingVisible || !text.equals(pairingLink)) { close(); return; }
                    dropInvitation(); invitation = parsed; scheduleExpiry(parsed); publish();
                }
                public void close() { parsed.close(); }
            };
        }, Feedback.PAIRING_INVALID);
        publish();
    }

    @Override public void pairingLinkChanged(String text) {
        if (!enrolling) { dropInvitation(); pairingLink = text; feedback = Feedback.NONE; }
    }

    @Override public void pairFromLink(String text) {
        if (!foreground || !pairingVisible || enrolling || storagePending() || storageBlocked || repairRequired) return;
        enrolling = true; pairingLink = ""; feedback = Feedback.NONE;
        long owner = epoch;
        long connection = ++attempt;
        work(owner, () -> {
            Invitation parsed = Invitation.parse(text, platform.now());
            Identity fresh;
            try {
                for (Paired previous : platform.pairings()) {
                    if (previous.pcId.equals(parsed.pcId)) {
                        parsed.close();
                        return () -> {
                            if (current(owner, connection)) { enrolling = false; feedback = Feedback.ALREADY_PAIRED; publish(); }
                        };
                    }
                }
                fresh = platform.createIdentity();
            } catch (IOException | GeneralSecurityException | IllegalArgumentException creationFailure) {
                parsed.close(); throw creationFailure;
            }
            return new RetiredCleanup() {
                public void run() { beginEnrollment(parsed, fresh, owner, connection); }
                public void close() { parsed.close(); cleanupIdentity(fresh.alias, owner, connection); }
            };
        }, Feedback.PAIRING_FAILED);
        publish();
    }

    private void beginEnrollment(Invitation parsed, Identity fresh, long owner, long connection) {
        if (!current(owner, connection) || !enrolling) {
            parsed.close(); cleanupIdentity(fresh.alias, owner, connection); return;
        }
        dropInvitation(); invitation = parsed; enrollmentIdentity = fresh; fingerprint = fresh.fingerprint;
        scheduleExpiry(parsed);
        retired.whenComplete((ignored, failure) -> platform.main(() -> {
            if (!current(owner, connection) || invitation != parsed) return;
            if (failure != null) { disconnectedAttempt(); return; }
            try { open(inputs(fresh, parsed.httpsOrigin, parsed.pcIdentityKey, parsed.authorization()), owner, connection); }
            catch (GeneralSecurityException invalidIdentity) { disconnectedAttempt(); }
        }));
        publish();
    }

    private void scheduleExpiry(Invitation parsed) {
        long owner = epoch;
        long remaining = parsed.expiresAt - platform.now();
        expiry = platform.later((int) Math.max(1, Math.min(Integer.MAX_VALUE, remaining)), () -> {
            if (!foreground || epoch != owner || invitation != parsed) return;
            if (platform.now() < parsed.expiresAt) { scheduleExpiry(parsed); return; }
            retireAttempt(); dropInvitation(); cleanupEnrollment(); enrolling = false;
            pairingLink = ""; feedback = Feedback.PAIRING_INVALID; publish();
        });
    }

    private void saveEnrollment(String grantId, long generation, String pcKey) {
        if (invitation == null || platform.now() >= invitation.expiresAt) { disconnectedAttempt(); return; }
        final Paired candidate;
        try {
            if (!pcKey.equals(invitation.pcIdentityKey)) throw new IllegalArgumentException("Pinned key mismatch");
            candidate = new Paired(new String[] { invitation.pcId, pcKey, invitation.httpsOrigin,
                enrollmentIdentity.alias, grantId }, generation);
        } catch (GeneralSecurityException | IllegalArgumentException invalidGrant) { disconnectedAttempt(); return; }
        paired = candidate;
        repairTarget = new Repair(candidate.pcId, candidate.alias);
        storageBlocked = true;
        // A commit may have changed preferences even when it reports failure. Never delete this alias afterward.
        enrollmentIdentity = null;
        dropInvitation();
        long owner = epoch, connection = attempt;
        transactStorage(() -> {
            List<Fence> uncertain = platform.fences();
            platform.repair(candidate.pcId, candidate.alias);
            platform.save(candidate);
            platform.clearRepair(candidate.pcId);
            return () -> {
                enrolling = pairingVisible = false; fingerprint = ""; pairingLink = "";
                repairTarget = null;
                conversations.restoreFences(uncertain);
                fence = selectedFence();
                draft = conversations.draft(candidate.pcId, selected);
                feedback = fence == null ? Feedback.NONE : Feedback.DELIVERY_UNKNOWN;
                if (current(owner, connection)) confirm(candidate.grantId, candidate.generation, candidate.pcKey);
            };
        }, Feedback.STORAGE_FAILED, StorageKind.PAIRING);
        publish();
    }

    public void cancelPairing() {
        if (!foreground) return;
        retireAttempt(); dropInvitation(); cleanupEnrollment();
        enrolling = pairingVisible = false; fingerprint = pairingLink = "";
        if (paired != null && !repairRequired && !storageBlocked) reconnect();
        publish();
    }

    private void dropInvitation() {
        if (expiry != null) expiry.cancel();
        expiry = null;
        if (invitation != null) invitation.close();
        invitation = null;
    }

    private void cleanupEnrollment() {
        if (enrollmentIdentity != null) cleanupIdentity(enrollmentIdentity.alias);
        enrollmentIdentity = null; fingerprint = ""; enrolling = false;
    }

    private void cleanupIdentity(String alias) { cleanupIdentity(alias, epoch, attempt); }

    private void cleanupIdentity(String alias, long owner, long connection) {
        try { platform.io(() -> {
            try { platform.deleteIdentity(alias); }
            catch (IOException | GeneralSecurityException failedCleanup) {
                platform.main(() -> { if (current(owner, connection)) failStorage(Feedback.REPAIR_REQUIRED); });
            }
        }); } catch (RejectedExecutionException unavailableOwner) { storageBlocked = true; }
    }

    @Override public void forgetPairing(String pcId) {
        if (!foreground || storagePending()) return;
        Repair forgotten = repairTarget != null ? repairTarget : paired == null ? null : new Repair(paired.pcId, paired.alias);
        if (forgotten == null || !forgotten.pcId.equals(pcId)) return;
        retireAttempt(); dropInvitation(); cleanupEnrollment();
        storageBlocked = true;
        repairTarget = forgotten;
        transactStorage(() -> {
            platform.repair(forgotten.pcId, forgotten.alias);
            platform.forget(forgotten.pcId);
            platform.deleteIdentity(forgotten.alias);
            platform.clearRepair(forgotten.pcId);
            return () -> {
                paired = null; repairTarget = null; selected = null; sessions.clear(); history.clear();
                draft = conversations.draft(null, null);
                fence = selectedFence();
                repairRequired = storageBlocked = false; feedback = Feedback.NONE; publish();
            };
        }, Feedback.FORGET_FAILED, StorageKind.PAIRING);
        publish();
    }

    @Override public void draftChanged(String text) {
        Fence targetFence = conversations.fence(paired == null ? null : paired.pcId, selected);
        if (targetFence != null && targetFence.kind == OperationKind.ARCHIVE_SESSION) {
            feedback = Feedback.MANAGEMENT_BUSY; publish(); return;
        }
        if (!conversations.setDraft(paired == null ? null : paired.pcId, selected, text)) {
            feedback = Feedback.DRAFT_LIMIT; publish(); return;
        }
        if (!draft.equals(text)) ++interactionVersion;
        draft = text;
    }

    public void refreshManagementWorkspaces() {
        if (!foreground || !confirmed || hasRead(ApplicationCodec.Type.MANAGEMENT_WORKSPACES)) return;
        managementWorkspaces.clear(); managementCursor = null;
        managementAccess = ManagementAccess.CHECKING;
        listManagementWorkspaces(null);
    }

    public void loadMoreManagementWorkspaces() {
        if (confirmed && managementAccess == ManagementAccess.ENABLED && managementCursor != null
            && !hasRead(ApplicationCodec.Type.MANAGEMENT_WORKSPACES)) listManagementWorkspaces(managementCursor);
    }

    private void listManagementWorkspaces(String cursor) {
        String request = Protocol.randomId(16);
        Read read = new Read(request, ApplicationCodec.Type.MANAGEMENT_WORKSPACES, null, cursor);
        if (!sendRead(read, ApplicationCodec.listManagementWorkspaces(request, limits.pageSize, cursor))) {
            managementWorkspaces.clear(); managementCursor = null;
            managementAccess = ManagementAccess.UNAVAILABLE; publish();
        }
    }

    private void acceptManagementWorkspaces(Read read, ApplicationCodec.Result message) {
        if (read.cursor == null) managementWorkspaces.clear();
        if (!message.enabled) {
            managementWorkspaces.clear(); managementCursor = null;
            managementAccess = ManagementAccess.DISABLED; return;
        }
        for (ApplicationCodec.WorkspaceInfo workspace : message.workspaces) {
            if (managementWorkspaces.containsKey(workspace.id)) {
                managementWorkspaces.clear(); managementCursor = null;
                managementAccess = ManagementAccess.UNAVAILABLE; return;
            }
            if (managementWorkspaces.size() < limits.sessionWindow) {
                managementWorkspaces.put(workspace.id, new WorkspaceInfo(workspace.id, workspace.title, workspace.order));
            }
        }
        managementAccess = ManagementAccess.ENABLED;
        managementCursor = managementWorkspaces.size() < limits.sessionWindow ? message.cursor : null;
    }

    @Override public void refresh() {
        if (confirmed && !hasRead(ApplicationCodec.Type.SESSIONS)) {
            cancelSelectionReads();
            listSessions(null);
        }
    }
    public void loadMoreSessions() {
        if (sessionsCursor != null && !hasRead(ApplicationCodec.Type.SESSIONS)) listSessions(sessionsCursor);
    }
    public void loadMoreHistory() {
        if (historyCursor != null && selected != null && !hasRead(ApplicationCodec.Type.HISTORY)) readHistory(historyCursor);
    }

    private void heartbeatRead() {
        String request = Protocol.randomId(16);
        Read pulse = new Read(request, ApplicationCodec.Type.SESSIONS, null, null);
        pulse.heartbeat = true;
        sendRead(pulse, ApplicationCodec.listSessions(request, 1, null));
    }

    private void listSessions(String cursor) {
        String request = Protocol.randomId(16);
        Read listing = new Read(request, ApplicationCodec.Type.SESSIONS, null, cursor);
        listing.baseline = activeWatch == null;
        listing.recoveryVersion = readFailureVersion;
        sendRead(listing, ApplicationCodec.listSessionNavigation(request, limits.pageSize, cursor));
    }

    private Fence selectedFence() {
        if (mutation != null) return mutation.fence;
        if (paired == null || selected == null) return conversations.firstFence(paired == null ? null : paired.pcId);
        return conversations.fence(paired.pcId, selected);
    }

    @Override public void selectSession(String sessionId) {
        if (!sessions.containsKey(sessionId) || Objects.equals(selected, sessionId)) return;
        ++interactionVersion;
        cancelSelectionReads(); selected = sessionId;
        draft = conversations.draft(paired == null ? null : paired.pcId, selected);
        fence = selectedFence();
        if (repairRequired || storageBlocked) feedback = Feedback.REPAIR_REQUIRED;
        else if (fence != null && mutation == null) feedback = Feedback.DELIVERY_UNKNOWN;
        else if (feedback != Feedback.REFRESH_FAILED) feedback = Feedback.NONE;
        models = ModelSelectionPane.empty();
        history.clear(); historyCursor = null; statusSession = null;
        if (confirmed) readSelection(readFailureVersion);
        publish();
    }

    private void cancelSelectionReads() {
        models = models.invalidated();
        if (watchRenewal != null) watchRenewal.cancel();
        watchRenewal = null;
        boolean unknownWatch = hasRead(ApplicationCodec.Type.WATCHING);
        for (Read read : new ArrayList<>(reads.values())) {
            if (read.session != null) { reads.remove(read.id); read.deadline.cancel(); }
        }
        ActiveWatch previous = activeWatch;
        activeWatch = null; statusSession = null;
        if (unknownWatch) { disconnectedAttempt(); return; }
        if (previous != null && previous.subscription != null && confirmed) cancelSubscription(previous.subscription);
    }

    private void cancelSubscription(String previous) {
        String request = Protocol.randomId(16);
        Read cancel = new Read(request, ApplicationCodec.Type.CANCELLED, null, null);
        cancel.subscription = previous;
        if (!sendRead(cancel, ApplicationCodec.cancelRead(request, previous))) disconnectedAttempt();
    }

    private void readHistory(String cursor) { readHistory(cursor, readFailureVersion); }

    private void readHistory(String cursor, long recoveryVersion) {
        String request = Protocol.randomId(16);
        Read read = new Read(request, ApplicationCodec.Type.HISTORY, selected, cursor);
        read.recoveryVersion = recoveryVersion;
        sendRead(read, ApplicationCodec.readHistory(request, selected, limits.pageSize, cursor));
    }

    /** Closed rows read history directly; active rows retire older reads and await a watch cut before a fresh baseline. */
    private void readSelection(long recoveryVersion) {
        if (selected == null || activeWatch != null || hasRead(ApplicationCodec.Type.WATCHING)) return;
        SessionRow session = sessions.get(selected);
        if (session != null && session.status == SessionStatus.CLOSED) {
            if (!hasRead(ApplicationCodec.Type.HISTORY)) readHistory(null, recoveryVersion);
            return;
        }
        cancelSelectionReads();
        historyCursor = null;
        String request = Protocol.randomId(16);
        Read read = new Read(request, ApplicationCodec.Type.WATCHING, selected, null);
        read.recoveryVersion = recoveryVersion;
        if (sendRead(read, ApplicationCodec.watchProgress(request, selected, null))) {
            activeWatch = new ActiveWatch(request, selected, epoch, attempt);
        }
    }

    private void renewWatch() {
        ActiveWatch watched = activeWatch;
        SessionRow session = sessions.get(watched.session);
        if (session != null && session.status == SessionStatus.CLOSED) return;
        watchRenewal = platform.later(limits.watchMs, () -> {
            if (!current(watched.owner, watched.attempt) || activeWatch != watched) return;
            cancelSelectionReads();
            if (confirmed && selected != null) readSelection(-1);
        });
    }

    /** Refreshes independent PC consent without activating any Session. */
    public void refreshActivationAccess() {
        if (!foreground || !confirmed || hasRead(ApplicationCodec.Type.SESSION_ACTIVATION)) return;
        activationAccess = ActivationAccess.CHECKING;
        String request = Protocol.randomId(16);
        Read read = new Read(request, ApplicationCodec.Type.SESSION_ACTIVATION, null, null);
        if (!sendRead(read, ApplicationCodec.getSessionActivation(request))) {
            activationAccess = ActivationAccess.UNAVAILABLE; publish();
        }
    }

    public void refreshModels() { readModels(null); }

    public void loadNextModels() {
        if (models.cursor != null) readModels(models.cursor);
    }

    private boolean canReadModels() {
        return foreground && confirmed && paired != null && metadataReadyEpoch == epoch && sessionListingReady
            && !storageBlocked && !repairRequired && !storagePending() && fence == null && mutation == null
            && selected != null && visibleSessions.contains(selected) && sendState() == SendState.READY;
    }

    private void readModels(String cursor) {
        if (!canReadModels() || hasRead(ApplicationCodec.Type.SESSION_MODELS)) return;
        String request = Protocol.randomId(16);
        Read read = new Read(request, ApplicationCodec.Type.SESSION_MODELS, selected, cursor);
        read.modelRevision = models.revision;
        models = models.loading();
        if (!sendRead(read, ApplicationCodec.listSessionModels(request, selected, limits.pageSize, cursor))) {
            models = models.failed(); publish();
        }
    }

    private boolean hasRead(ApplicationCodec.Type type) {
        for (Read read : reads.values()) if (read.type == type) return true;
        return false;
    }

    private boolean sendRead(Read read, byte[] bytes) {
        if (!foreground || !confirmed || reads.size() >= limits.pendingReads) return false;
        if (link.send(bytes) != PhoneTransport.Admission.ADMITTED_MAY_WRITE) {
            if (read.type == ApplicationCodec.Type.SESSION_MODELS) models = models.failed();
            else if (read.type == ApplicationCodec.Type.SESSION_ACTIVATION) activationAccess = ActivationAccess.UNAVAILABLE;
            else readFailed();
            publish(); return false;
        }
        long owner = epoch, connection = attempt;
        reads.put(read.id, read);
        read.deadline = platform.later(limits.readMs, () -> {
            if (!current(owner, connection) || reads.remove(read.id) == null) return;
            if (read.type == ApplicationCodec.Type.SESSION_MODELS) { models = models.failed(); publish(); return; }
            if (read.type == ApplicationCodec.Type.SESSION_ACTIVATION) {
                activationAccess = ActivationAccess.UNAVAILABLE; publish(); return;
            }
            // A watch may exist remotely even if its ACK was lost. Closing prevents accumulating subscriptions.
            disconnectedAttempt();
        });
        publish();
        return true;
    }

    private void receive(ApplicationCodec.Result message) {
        if (!confirmed) return;
        if (message.type == ApplicationCodec.Type.PROGRESS) { progress(message); return; }
        if (mutation != null && mutation.request.equals(message.requestId)) { mutationReply(message); return; }
        Read read = reads.get(message.requestId);
        if (read == null) {
            if (message.type == ApplicationCodec.Type.ERROR && activeWatch != null
                && current(activeWatch.owner, activeWatch.attempt) && activeWatch.request.equals(message.requestId)
                && activeWatch.session.equals(selected)) watchFailed(message.code);
            return;
        }
        if (message.type != ApplicationCodec.Type.ERROR && message.type != read.type) return;
        if (read.session != null && (!read.session.equals(selected)
            || (message.type != ApplicationCodec.Type.ERROR && !read.session.equals(message.sessionId)))) return;
        if (read.type == ApplicationCodec.Type.CANCELLED && message.type != ApplicationCodec.Type.ERROR
            && !Objects.equals(read.subscription, message.subscriptionId)) return;
        reads.remove(read.id); read.deadline.cancel();
        if (message.type == ApplicationCodec.Type.ERROR) {
            if (read.type == ApplicationCodec.Type.CANCELLED) disconnectedAttempt();
            else if (read.type == ApplicationCodec.Type.WATCHING) watchFailed(message.code);
            else if (read.type == ApplicationCodec.Type.MANAGEMENT_WORKSPACES) {
                managementWorkspaces.clear(); managementCursor = null;
                managementAccess = ManagementAccess.UNAVAILABLE; publish();
            } else if (read.type == ApplicationCodec.Type.SESSION_ACTIVATION) {
                activationAccess = ActivationAccess.UNAVAILABLE; publish();
            } else if (read.type == ApplicationCodec.Type.SESSION_MODELS) {
                models = models.failed(); publish();
            } else {
                if (read.session != null && "notFound".equals(message.code)) removeSelection();
                readFailed(); publish();
            }
            return;
        }
        switch (message.type) {
            case SESSION_ACTIVATION:
                activationAccess = message.enabled ? ActivationAccess.ENABLED : ActivationAccess.DISABLED;
                break;
            case SESSIONS:
                if (!read.heartbeat) {
                    acceptSessions(read, message);
                    if (selected == null) recoverRead(read);
                }
                break;
            case HISTORY:
                appendRows(message.rows); historyCursor = message.cursor; recoverRead(read); break;
            case WATCHING:
                ActiveWatch watched = activeWatch;
                watched.subscription = message.subscriptionId;
                if (watched.managementClosed) {
                    for (ApplicationCodec.Result early : watched.early) {
                        if (watched.subscription.equals(early.subscriptionId)) appendRows(early.rows);
                    }
                    watched.early.clear();
                    retireClosedWatch(watched);
                    SessionRow resumed = sessions.get(selected);
                    if (resumed != null && resumed.status != SessionStatus.CLOSED) {
                        readSelection(read.recoveryVersion); break;
                    }
                } else {
                    for (ApplicationCodec.Result early : watched.early) progress(early);
                    watched.early.clear();
                    if (activeWatch == watched) renewWatch();
                }
                // A cursorless watch establishes its cut before this independently paged history read.
                if (confirmed && !hasRead(ApplicationCodec.Type.HISTORY)) readHistory(null, read.recoveryVersion);
                break;
            case MANAGEMENT_WORKSPACES: acceptManagementWorkspaces(read, message); break;
            case SESSION_MODELS:
                if (read.cursor != null && "ready".equals(message.modelState) && !Objects.equals(read.modelRevision, message.modelRevision)) models = models.failed();
                else models = ModelSelectionPane.from(message);
                break;
            case CANCELLED: break;
            default: throw new AssertionError(message.type);
        }
        publish();
    }

    private void acceptSessions(Read read, ApplicationCodec.Result message) {
        Map<String, SessionRow> previousRows = new LinkedHashMap<>(sessions);
        if (read.cursor == null) {
            SessionRow retained = sessions.get(selected);
            sessions.clear();
            if (retained != null) sessions.put(retained.id, retained);
            sessionScan = new SessionScan(selected);
            visibleSessions.clear();
        }
        // Listing visibility cannot restore active send authority after a denied watch.
        for (ApplicationCodec.SessionSummary summary : message.sessions) {
            visibleSessions.add(summary.sessionId);
            SessionRow previous = previousRows.get(summary.sessionId);
            // Legacy omission cannot clear previously supplied metadata; explicit nullable fields can.
            SessionNavigation navigation = summary.navigation == null && previous != null
                ? previous.navigation : navigation(summary.navigation);
            sessions.put(summary.sessionId, new SessionRow(summary.sessionId, summary.title, status(summary.status), navigation));
            if (sessionScan != null && summary.sessionId.equals(sessionScan.selected)) sessionScan.found = true;
        }
        trimSessions(); visibleSessions.retainAll(sessions.keySet());
        sessionListingReady = true; sessionsCursor = message.cursor;
        if (message.cursor == null && sessionScan != null && !sessionScan.found
            && Objects.equals(selected, sessionScan.selected)) removeSelection();
        // A page requested under a live watch cannot revive it after later closure or denial.
        SessionRow previous = previousRows.get(selected), current = sessions.get(selected);
        if (read.baseline && selected != null && (read.cursor == null
            || previous != null && previous.status == SessionStatus.CLOSED
                && current != null && current.status != SessionStatus.CLOSED)) readSelection(read.recoveryVersion);
    }

    private void removeSelection() {
        cancelSelectionReads();
        sessions.remove(selected); selected = statusSession = null;
        draft = conversations.draft(paired == null ? null : paired.pcId, null);
        fence = selectedFence();
        models = ModelSelectionPane.empty();
        history.clear(); historyCursor = null;
    }

    private void watchFailed(String code) {
        activeWatch = null; statusSession = null;
        cancelSelectionReads();
        readFailed();
        if ("notFound".equals(code)) removeSelection();
        else if (selected != null) readHistory(null, -1);
        // Recovery requires a new explicit refresh; denied/limit cannot create a retry loop.
        publish();
    }

    private void readFailed() {
        ++readFailureVersion;
        if (feedback == Feedback.NONE || feedback == Feedback.INBOX_ADMITTED || feedback == Feedback.REFRESH_FAILED) {
            feedback = Feedback.REFRESH_FAILED;
        }
    }

    /** Only a recovery started after the current failure may clear it; other warnings have independent owners. */
    private void recoverRead(Read read) {
        if (read.recoveryVersion == readFailureVersion && feedback == Feedback.REFRESH_FAILED) feedback = Feedback.NONE;
    }

    private void trimSessions() {
        while (sessions.size() > limits.sessionWindow) {
            String first = sessions.keySet().iterator().next();
            if (first.equals(selected)) {
                SessionRow preserved = sessions.remove(first); sessions.put(first, preserved);
            } else sessions.remove(first);
        }
    }

    private void progress(ApplicationCodec.Result message) {
        ActiveWatch watched = activeWatch;
        if (watched == null || !current(watched.owner, watched.attempt)
            || !Objects.equals(selected, message.sessionId)) return;
        if (watched.subscription == null) { bufferProgress(watched, message); return; }
        if (!watched.subscription.equals(message.subscriptionId)) return;
        SessionRow previous = sessions.get(selected);
        if (previous == null) return;
        sessions.put(selected, new SessionRow(selected, previous.title, status(message.status), previous.navigation));
        statusSession = selected;
        if (mutation != null && mutation.result != null && mutation.fence.sessionId.equals(selected)) {
            mutation.laterProgressStatus = status(message.status);
        }
        appendRows(message.rows);
        if (sessions.get(selected).status == SessionStatus.CLOSED) retireClosedWatch(watched);
        // Progress cursors belong to watchProgress, never to readHistory paging.
        publish();
    }

    /** Retire only the acknowledged closed watch; independent history reads retain their deadlines and recovery metadata. */
    private void retireClosedWatch(ActiveWatch watched) {
        activeWatch = null; statusSession = null;
        if (watchRenewal != null) watchRenewal.cancel();
        watchRenewal = null;
        cancelSubscription(watched.subscription);
    }

    private void bufferProgress(ActiveWatch watched, ApplicationCodec.Result message) {
        watched.early.add(message);
        int rows = 0, bytes = 0;
        for (ApplicationCodec.Result early : watched.early) {
            rows += early.rows.size();
            for (ApplicationCodec.HistoryRow row : early.rows) bytes += StrictJson.utf8Length(row.text);
        }
        while (watched.early.size() > limits.textRows || rows > limits.textRows || bytes > limits.textBytes) {
            ApplicationCodec.Result discarded = watched.early.remove(0);
            rows -= discarded.rows.size();
            for (ApplicationCodec.HistoryRow row : discarded.rows) bytes -= StrictJson.utf8Length(row.text);
        }
    }

    private static SessionNavigation navigation(ApplicationCodec.SessionNavigation navigation) {
        if (navigation == null) return null;
        ApplicationCodec.WorkspaceInfo workspace = navigation.workspace;
        return new SessionNavigation(workspace == null ? null : new WorkspaceInfo(workspace.id, workspace.title, workspace.order),
            navigation.pinOrder, navigation.updatedAt);
    }

    private static SessionStatus status(String status) {
        switch (status) {
            case "idle": return SessionStatus.IDLE;
            case "queued": case "running": return SessionStatus.BUSY;
            case "closed": return SessionStatus.CLOSED;
            default: throw new IllegalArgumentException("Unknown session status");
        }
    }

    private void appendRows(List<ApplicationCodec.HistoryRow> incoming) {
        for (ApplicationCodec.HistoryRow row : incoming) {
            boolean duplicateSequence = false;
            for (ApplicationCodec.HistoryRow existing : history.values()) {
                if (existing.seq.equals(row.seq)) { duplicateSequence = true; break; }
            }
            if (!history.containsKey(row.id) && !duplicateSequence) history.put(row.id, row);
        }
        List<ApplicationCodec.HistoryRow> ordered = new ArrayList<>(history.values());
        ordered.sort((left, right) -> new BigInteger(1, Protocol.decodeBase64Url(left.seq, 8))
            .compareTo(new BigInteger(1, Protocol.decodeBase64Url(right.seq, 8))));
        history.clear(); int bytes = 0;
        for (ApplicationCodec.HistoryRow row : ordered) { history.put(row.id, row); bytes += StrictJson.utf8Length(row.text); }
        while (history.size() > limits.textRows || bytes > limits.textBytes) {
            String first = history.keySet().iterator().next();
            bytes -= StrictJson.utf8Length(history.remove(first).text);
        }
    }

    public void createSession(String workspaceId) {
        manageSession(OperationKind.CREATE_SESSION, null, workspaceId,
            (request, operation, session) -> ApplicationCodec.createSession(request, operation, session, workspaceId));
    }
    public void renameSession(String sessionId, String title) {
        manageSession(OperationKind.RENAME_SESSION, sessionId, null,
            (request, operation, session) -> ApplicationCodec.renameSession(request, operation, session, title));
    }
    public void archiveSession(String sessionId) {
        manageSession(OperationKind.ARCHIVE_SESSION, sessionId, null, ApplicationCodec::archiveSession);
    }
    public void setSessionPinned(String sessionId, boolean pinned) {
        manageSession(OperationKind.SET_SESSION_PINNED, sessionId, null,
            (request, operation, session) -> ApplicationCodec.setSessionPinned(request, operation, session, pinned));
    }

    /** An explicit, fenced lifecycle gesture; browsing a cold chat never calls this method. */
    public void openSession(String sessionId) {
        SessionRow target = sessions.get(selected);
        if (!foreground || !confirmed || paired == null || metadataReadyEpoch != epoch || !sessionListingReady
            || storageBlocked || repairRequired || storagePending() || fence != null || mutation != null
            || activationAccess != ActivationAccess.ENABLED || !Objects.equals(selected, sessionId)
            || !visibleSessions.contains(sessionId) || target == null || target.status != SessionStatus.CLOSED) {
            mutationFeedback(Feedback.OPEN_REJECTED); return;
        }
        String request = Protocol.randomId(16), operation = Protocol.randomId(16);
        byte[] application = ApplicationCodec.openSession(request, operation, sessionId);
        fence = new Fence(paired.pcId, sessionId, operation, OperationKind.OPEN_SESSION);
        mutation = new Mutation(request, fence, null);
        mutation.selection = selected; mutation.interactionVersion = interactionVersion;
        admitMutation(mutation, application, Feedback.OPEN_REJECTED);
    }

    /** The rendered revision and choice are channel-scoped; no model route or retry payload is saved. */
    public void selectModel(String sessionId, String revision, String choiceId) {
        SessionRow target = sessions.get(selected);
        boolean advertised = false;
        for (ModelOption choice : models.choices) if (choice.id.equals(choiceId)) advertised = true;
        if (!canReadModels() || hasRead(ApplicationCodec.Type.SESSION_MODELS) || !Objects.equals(selected, sessionId)
            || target == null || target.status != SessionStatus.IDLE || models.access != ModelAccess.READY
            || !Objects.equals(models.revision, revision) || revision == null || !advertised) {
            models = models.rejected(); mutationFeedback(Feedback.MODEL_REJECTED); return;
        }
        String request = Protocol.randomId(16), operation = Protocol.randomId(16);
        byte[] application = ApplicationCodec.selectSessionModel(request, operation, sessionId, revision, choiceId);
        fence = new Fence(paired.pcId, sessionId, operation, OperationKind.SELECT_SESSION_MODEL);
        mutation = new Mutation(request, fence, null);
        mutation.selection = selected; mutation.interactionVersion = interactionVersion; mutation.modelChoiceId = choiceId;
        models = models.loading();
        admitMutation(mutation, application, Feedback.MODEL_REJECTED);
    }

    private void mutationFeedback(Feedback notice) {
        if (fence == null && !storageBlocked && !repairRequired && feedback != Feedback.STORAGE_FAILED
            && feedback != Feedback.PAIRING_CORRUPT && feedback != Feedback.REPAIR_REQUIRED) feedback = notice;
        publish();
    }

    private interface ManagementEncoder { byte[] encode(String request, String operation, String session); }

    private void manageSession(OperationKind kind, String sessionId, String workspaceId, ManagementEncoder encoder) {
        if (!foreground || !confirmed || paired == null || metadataReadyEpoch != epoch || !sessionListingReady
            || storageBlocked || repairRequired || storagePending() || managementAccess != ManagementAccess.ENABLED) {
            mutationFeedback(Feedback.MANAGEMENT_DENIED); return;
        }
        boolean create = kind == OperationKind.CREATE_SESSION;
        if (mutation != null || (create ? fence != null : conversations.fence(paired.pcId, sessionId) != null)
            || hasRead(ApplicationCodec.Type.MANAGEMENT_WORKSPACES)) {
            mutationFeedback(Feedback.MANAGEMENT_BUSY); return;
        }
        SessionRow target = sessions.get(sessionId);
        if (create ? !managementWorkspaces.containsKey(workspaceId) : target == null || !visibleSessions.contains(sessionId)) {
            mutationFeedback(Feedback.MANAGEMENT_DENIED); return;
        }
        if (create && !draft.isEmpty() || kind == OperationKind.ARCHIVE_SESSION
            && !conversations.draft(paired.pcId, sessionId).isEmpty()) {
            mutationFeedback(Feedback.MANAGEMENT_DRAFT_REQUIRED); return;
        }
        if (kind == OperationKind.ARCHIVE_SESSION && target.status == SessionStatus.BUSY) {
            mutationFeedback(Feedback.MANAGEMENT_BUSY); return;
        }
        String request = Protocol.randomId(16), operation = Protocol.randomId(16);
        String targetId = create ? "mobile-" + operation : sessionId;
        final byte[] application;
        try { application = encoder.encode(request, operation, targetId); }
        catch (IllegalArgumentException invalidCommand) { mutationFeedback(Feedback.MANAGEMENT_REJECTED); return; }
        fence = new Fence(paired.pcId, targetId, operation, kind);
        mutation = new Mutation(request, fence, null);
        mutation.selection = selected; mutation.interactionVersion = interactionVersion;
        admitMutation(mutation, application, Feedback.MANAGEMENT_REJECTED);
    }

    @Override public void sendText(String text) {
        if (sendState() != SendState.READY) return;
        String request = Protocol.randomId(16), submission = Protocol.randomId(16);
        final byte[] application;
        try { application = ApplicationCodec.submitText(request, selected, text, submission); }
        catch (IllegalArgumentException invalidText) { feedback = Feedback.SEND_FAILED; publish(); return; }
        fence = new Fence(paired.pcId, selected, submission);
        mutation = new Mutation(request, fence, text);
        admitMutation(mutation, application, Feedback.SEND_FAILED);
    }

    private void admitMutation(Mutation pending, byte[] application, Feedback admissionFailure) {
        conversations.rememberFence(pending.fence);
        long owner = epoch, connection = attempt;
        work(owner, () -> {
            platform.putFence(pending.fence);
            return () -> {
                if (!current(owner, connection) || mutation != pending || !confirmed) return;
                if (pending.fence.kind == OperationKind.SELECT_SESSION_MODEL) {
                    SessionRow target = sessions.get(selected);
                    if (!Objects.equals(selected, pending.selection) || interactionVersion != pending.interactionVersion
                        || target == null || target.status != SessionStatus.IDLE || !Objects.equals(statusSession, selected)) {
                        finishFence(pending, Feedback.MODEL_REJECTED); return;
                    }
                }
                if (pending.fence.kind == OperationKind.ARCHIVE_SESSION
                    && !conversations.draft(pending.fence.pcId, pending.fence.sessionId).isEmpty()) {
                    finishFence(pending, Feedback.MANAGEMENT_DRAFT_REQUIRED); return;
                }
                if (pending.fence.kind == OperationKind.OPEN_SESSION) {
                    SessionRow target = sessions.get(selected);
                    if (!Objects.equals(selected, pending.selection) || interactionVersion != pending.interactionVersion
                        || activationAccess != ActivationAccess.ENABLED || target == null || target.status != SessionStatus.CLOSED) {
                        finishFence(pending, Feedback.OPEN_REJECTED); return;
                    }
                }
                if (link.send(application) != PhoneTransport.Admission.ADMITTED_MAY_WRITE) {
                    // No local admission; clearing still needs a confirmed preference commit.
                    finishFence(pending, admissionFailure); return;
                }
                pending.deadline = platform.later(limits.mutationMs, () -> {
                    if (current(owner, connection) && mutation == pending) { deliveryUnknown(); publish(); }
                });
                publish();
            };
        }, Feedback.STORAGE_FAILED);
        publish();
    }

    private void mutationReply(ApplicationCodec.Result message) {
        Mutation pending = mutation;
        if (pending.settling) return;
        if (pending.fence.kind == OperationKind.SELECT_SESSION_MODEL) { modelReply(pending, message); return; }
        if (pending.fence.kind == OperationKind.OPEN_SESSION) { openReply(pending, message); return; }
        if (pending.fence.kind != OperationKind.SUBMIT_TEXT) { managementReply(pending, message); return; }
        if (message.type != ApplicationCodec.Type.SUBMITTED || !pending.fence.sessionId.equals(message.sessionId)
            || !pending.fence.submissionId.equals(message.submissionId) || !"inMemoryInbox".equals(message.admission)) {
            if (message.type == ApplicationCodec.Type.ERROR) { deliveryUnknown(); publish(); }
            return;
        }
        if (pending.deadline != null) pending.deadline.cancel();
        finishFence(pending, Feedback.INBOX_ADMITTED);
    }

    private void openReply(Mutation pending, ApplicationCodec.Result message) {
        if (message.type != ApplicationCodec.Type.SESSION_OPENED || !pending.fence.operationId.equals(message.operationId)
            || !pending.fence.sessionId.equals(message.sessionId) || "unknown".equals(message.outcome)) {
            deliveryUnknown(); publish(); return;
        }
        if (pending.deadline != null) pending.deadline.cancel();
        pending.result = message;
        if ("rejected".equals(message.outcome) && "denied".equals(message.code)) activationAccess = ActivationAccess.DISABLED;
        finishFence(pending, "applied".equals(message.outcome) ? Feedback.NONE : Feedback.OPEN_REJECTED);
    }

    private void modelReply(Mutation pending, ApplicationCodec.Result message) {
        if (message.type != ApplicationCodec.Type.MODEL_SELECTED || !pending.fence.operationId.equals(message.operationId)
            || !pending.fence.sessionId.equals(message.sessionId) || "unknown".equals(message.outcome)
            || "applied".equals(message.outcome) && !pending.modelChoiceId.equals(message.selectedModel.id)) {
            deliveryUnknown(); publish(); return;
        }
        if (pending.deadline != null) pending.deadline.cancel();
        pending.result = message;
        finishFence(pending, "applied".equals(message.outcome) ? Feedback.NONE : Feedback.MODEL_REJECTED);
    }

    private void managementReply(Mutation pending, ApplicationCodec.Result message) {
        String action;
        switch (pending.fence.kind) {
            case CREATE_SESSION: action = "create"; break;
            case RENAME_SESSION: action = "rename"; break;
            case ARCHIVE_SESSION: action = "archive"; break;
            case SET_SESSION_PINNED: action = "pin"; break;
            default: throw new AssertionError(pending.fence.kind);
        }
        if (message.type != ApplicationCodec.Type.MANAGED || !pending.fence.submissionId.equals(message.operationId)
            || !pending.fence.sessionId.equals(message.sessionId) || !action.equals(message.action)
            || "unknown".equals(message.outcome)) { deliveryUnknown(); publish(); return; }
        if (pending.deadline != null) pending.deadline.cancel();
        pending.result = message;
        finishFence(pending, "applied".equals(message.outcome) ? Feedback.NONE : Feedback.MANAGEMENT_REJECTED);
    }

    private void applyMutationOutcome(Mutation pending) {
        ApplicationCodec.Result result = pending.result;
        if (pending.fence.kind == OperationKind.SELECT_SESSION_MODEL) {
            if (Objects.equals(selected, pending.fence.sessionId)) {
                models = result != null && "applied".equals(result.outcome) ? models.applied(result.selectedModel) : models.rejected();
            }
            return;
        }
        if (result == null || !"applied".equals(result.outcome)) return;
        // An older listing cannot replace metadata returned by this definitive mutation.
        Read interruptedBaseline = null;
        for (Read read : new ArrayList<>(reads.values())) {
            if (read.type == ApplicationCodec.Type.SESSIONS && !read.heartbeat) {
                if (read.baseline) interruptedBaseline = read;
                reads.remove(read.id); read.deadline.cancel();
            }
        }
        sessionsCursor = null; sessionScan = null;
        String sessionId = pending.fence.sessionId;
        if (pending.fence.kind == OperationKind.ARCHIVE_SESSION) {
            visibleSessions.remove(sessionId);
            if (Objects.equals(selected, sessionId)) removeSelection();
            else sessions.remove(sessionId);
            if (confirmed) listSessions(null);
            return;
        }
        ApplicationCodec.SessionSummary row = result.session;
        SessionStatus latestStatus = pending.laterProgressStatus == null ? status(row.status) : pending.laterProgressStatus;
        sessions.put(row.sessionId, new SessionRow(row.sessionId, row.title, latestStatus, navigation(row.navigation)));
        if (Objects.equals(selected, row.sessionId) && latestStatus == SessionStatus.CLOSED && activeWatch != null) {
            if (activeWatch.subscription == null) activeWatch.managementClosed = true;
            else retireClosedWatch(activeWatch);
        }
        visibleSessions.add(row.sessionId);
        trimSessions(); visibleSessions.retainAll(sessions.keySet());
        if (pending.fence.kind == OperationKind.CREATE_SESSION && interactionVersion == pending.interactionVersion
            && Objects.equals(selected, pending.selection) && draft.isEmpty()) selectSession(row.sessionId);
        SessionRow selectedRow = sessions.get(selected);
        if (confirmed && selectedRow != null && (interruptedBaseline != null
            || selectedRow.status != SessionStatus.CLOSED && activeWatch == null)) {
            readSelection(interruptedBaseline == null ? readFailureVersion : interruptedBaseline.recoveryVersion);
        }
        // Restart cancelled pages against the committed PC state, retaining selection and draft.
        if (confirmed) listSessions(null);
    }

    private void finishFence(Mutation pending, Feedback outcome) {
        if (storagePending()) return;
        pending.settling = true;
        long owner = epoch, connection = attempt;
        transactStorage(() -> {
            platform.clearFence(pending.fence);
            return () -> {
                conversations.clearFence(pending.fence);
                boolean selectedTarget = paired != null && paired.pcId.equals(pending.fence.pcId)
                    && Objects.equals(selected, pending.fence.sessionId);
                if (outcome == Feedback.INBOX_ADMITTED) {
                    conversations.clearSubmittedDraft(pending.fence.pcId, pending.fence.sessionId, pending.text);
                    if (selectedTarget && draft.equals(pending.text)) draft = "";
                }
                if (mutation == pending) mutation = null;
                fence = selectedFence();
                boolean retainReadFailure = pending.fence.kind != OperationKind.SUBMIT_TEXT
                    && outcome == Feedback.NONE && feedback == Feedback.REFRESH_FAILED;
                if (repairRequired || storageBlocked) feedback = Feedback.REPAIR_REQUIRED;
                else if (selectedTarget && !retainReadFailure) feedback = outcome;
                else if (fence != null && mutation == null) feedback = Feedback.DELIVERY_UNKNOWN;
                else if (feedback == Feedback.DELIVERY_UNKNOWN) feedback = Feedback.NONE;
                if (current(owner, connection) && !repairRequired && !storageBlocked) applyMutationOutcome(pending);
            };
        }, Feedback.STORAGE_FAILED, StorageKind.DELIVERY);
    }

    private void deliveryUnknown() {
        if (mutation != null && mutation.deadline != null) mutation.deadline.cancel();
        if (mutation != null && mutation.fence.kind == OperationKind.SELECT_SESSION_MODEL) models = models.invalidated();
        mutation = null;
        fence = selectedFence();
        feedback = fence == null ? Feedback.NONE : Feedback.DELIVERY_UNKNOWN;
    }

    /** User must first check the original Session; clearing never sends the previous task. */
    public void resolveUnknown() {
        if (!foreground || fence == null || mutation != null || storagePending()) return;
        Fence reviewed = fence;
        transactStorage(() -> {
            platform.clearFence(reviewed);
            return () -> {
                conversations.clearFence(reviewed);
                fence = selectedFence();
                feedback = repairRequired || storageBlocked ? Feedback.REPAIR_REQUIRED
                    : fence == null ? Feedback.NONE : Feedback.DELIVERY_UNKNOWN;
            };
        }, Feedback.STORAGE_FAILED, StorageKind.DELIVERY);
    }

    private SendState sendState() {
        if (fence != null) return mutation == null ? SendState.DELIVERY_UNKNOWN : SendState.BUSY;
        if (storageBlocked || repairRequired || !foreground || metadataReadyEpoch != epoch || !confirmed) return SendState.OFFLINE;
        SessionRow session = sessions.get(selected);
        if (session == null) return SendState.NO_SELECTION;
        if (session.status == SessionStatus.CLOSED) return SendState.CLOSED;
        return Objects.equals(statusSession, selected) ? SendState.READY : SendState.OFFLINE;
    }

    private void publish() {
        if (!foreground || output == null) return;
        if (pairingVisible) {
            output.pairing(new Pairing(pairingLink, enrolling ? PairingState.ENROLLING : PairingState.EDITING,
                feedback, fingerprint));
            return;
        }
        List<TextRow> text = new ArrayList<>();
        for (ApplicationCodec.HistoryRow row : history.values()) {
            text.add(new TextRow(row.id, Role.valueOf(row.role.toUpperCase(java.util.Locale.ROOT)), row.text));
        }
        String pcId = paired == null ? (repairTarget == null ? null : repairTarget.pcId) : paired.pcId;
        Pc pc = pcId == null ? null : new Pc(pcId, pcLabel,
            confirmed ? Connection.ONLINE : connecting ? Connection.CONNECTING : Connection.OFFLINE);
        output.companion(new Screen(pc, new SessionPane(new ArrayList<>(sessions.values()), selected,
            confirmed && sessionsCursor != null && !hasRead(ApplicationCodec.Type.SESSIONS),
            new ManagementPane(managementAccess, new ArrayList<>(managementWorkspaces.values()),
                confirmed && managementCursor != null && !hasRead(ApplicationCodec.Type.MANAGEMENT_WORKSPACES),
                fence != null || storagePending() || storageBlocked || repairRequired || !sessionListingReady
                    || hasRead(ApplicationCodec.Type.MANAGEMENT_WORKSPACES))),
            new Conversation(sessions.get(selected), text,
                confirmed && historyCursor != null && !hasRead(ApplicationCodec.Type.HISTORY)),
            new Composer(draft, sendState(), feedback,
                fence == null ? null : new DeliveryReview(fence.pcId, fence.sessionId, fence.submissionId, fence.kind)),
            metadataReadyEpoch != epoch && !storageBlocked && !repairRequired, models,
            new ActivationPane(activationAccess, mutation != null && mutation.fence.kind == OperationKind.OPEN_SESSION
                && Objects.equals(selected, mutation.fence.sessionId))));

    }

    private enum StorageOutcome { PENDING, CONFIRMED, FAILED }
    private enum StorageKind { PAIRING, DELIVERY }
    private static final class StorageTransaction {
        final long owner;
        final Feedback failure;
        final StorageKind kind;
        final boolean previouslyBlocked;
        volatile StorageOutcome outcome = StorageOutcome.PENDING;
        Runnable settlement;
        StorageTransaction(long owner, Feedback failure, StorageKind kind, boolean previouslyBlocked) {
            this.owner = owner; this.failure = failure; this.kind = kind; this.previouslyBlocked = previouslyBlocked;
        }
    }

    private boolean storagePending() {
        return metadataReadyEpoch != epoch || storageTransaction != null && storageTransaction.outcome != StorageOutcome.FAILED;
    }

    /** Normal store returns certify commit success; preference reads cannot certify failed writes. */
    private void transactStorage(IoOperation operation, Feedback failure, StorageKind kind) {
        StorageTransaction transaction = new StorageTransaction(epoch, failure, kind, storageBlocked);
        storageTransaction = transaction; storageBlocked = true;
        try { platform.io(() -> {
            try {
                transaction.settlement = operation.run();
                transaction.outcome = StorageOutcome.CONFIRMED;
            } catch (IOException | GeneralSecurityException | IllegalArgumentException failedCommit) {
                transaction.outcome = StorageOutcome.FAILED;
            }
            platform.main(() -> {
                if (foreground && epoch == transaction.owner && storageTransaction == transaction) {
                    settleStorage(); publish();
                }
            });
        }); } catch (RejectedExecutionException unavailableOwner) {
            transaction.outcome = StorageOutcome.FAILED; settleStorage();
        }
    }

    private void settleStorage() {
        StorageTransaction transaction = storageTransaction;
        if (transaction == null || transaction.outcome == StorageOutcome.PENDING) return;
        if (transaction.outcome == StorageOutcome.FAILED) {
            if (transaction.kind == StorageKind.DELIVERY) storageBlocked = transaction.previouslyBlocked;
            failStorage(transaction.failure);
            return;
        }
        storageTransaction = null;
        if (transaction.kind == StorageKind.PAIRING) storageBlocked = repairRequired = false;
        else storageBlocked = transaction.previouslyBlocked;
        transaction.settlement.run();
    }

    private interface IoOperation { Runnable run() throws IOException, GeneralSecurityException; }
    private void work(long owner, IoOperation operation, Feedback failureFeedback) {
        long connection = attempt;
        try { platform.io(() -> {
            try {
                if (epoch != owner) return;
                Runnable completion = operation.run();
                // Completions may own transient invitation/identity cleanup even after retirement.
                platform.main(() -> {
                    if (foreground && epoch == owner) completion.run();
                    else if (completion instanceof RetiredCleanup) ((RetiredCleanup) completion).close();
                });
            } catch (IOException | GeneralSecurityException | IllegalArgumentException failedOperation) {
                platform.main(() -> {
                    if (foreground && epoch == owner && (attempt == connection || failureFeedback == Feedback.PAIRING_CORRUPT)) {
                        failStorage(failureFeedback);
                    }
                });
            }
        }); } catch (RejectedExecutionException unavailableOwner) { failStorage(Feedback.STORAGE_FAILED); }
    }

    private interface RetiredCleanup extends Runnable { void close(); }

    private void failStorage(Feedback failure) {
        feedback = failure;
        if (failure == Feedback.STORAGE_FAILED && fence != null && !enrolling) {
            deliveryUnknown(); publish(); return;
        }
        if (failure == Feedback.PAIRING_INVALID || failure == Feedback.PAIRING_FAILED) {
            retireAttempt(); dropInvitation(); cleanupEnrollment(); enrolling = false; pairingLink = "";
        } else {
            storageBlocked = true; repairRequired = true; retireAttempt(); dropInvitation(); cleanupEnrollment();
            pairingVisible = false; pairingLink = "";
        }
        publish();
    }

    private static final class SessionScan {
        final String selected;
        boolean found;
        SessionScan(String selected) { this.selected = selected; }
    }
    private static final class ActiveWatch {
        final String request;
        final String session;
        final long owner;
        final long attempt;
        String subscription;
        boolean managementClosed;
        final List<ApplicationCodec.Result> early = new ArrayList<>();
        ActiveWatch(String request, String session, long owner, long attempt) {
            this.request = request; this.session = session; this.owner = owner; this.attempt = attempt;
        }
    }
    private static final class Read {
        final String id;
        final ApplicationCodec.Type type;
        final String session;
        final String cursor;
        String subscription;
        String modelRevision;
        boolean baseline;
        boolean heartbeat;
        long recoveryVersion = -1;
        Cancellable deadline;
        Read(String id, ApplicationCodec.Type type, String session, String cursor) {
            this.id = id; this.type = type; this.session = session; this.cursor = cursor;
        }
    }
    private static final class Mutation {
        final String request;
        final Fence fence;
        final String text;
        String selection;
        String modelChoiceId;
        long interactionVersion;
        ApplicationCodec.Result result;
        SessionStatus laterProgressStatus;
        boolean settling;
        Cancellable deadline;
        Mutation(String request, Fence fence, String text) { this.request = request; this.fence = fence; this.text = text; }
    }
}
