package io.harnessy.companion;

import io.harnessy.companion.protocol.ApplicationCodec;
import io.harnessy.companion.protocol.Invitation;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import io.harnessy.companion.presentation.CompanionActions;
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
    private final Map<String, SessionRow> sessions = new LinkedHashMap<>();
    private final Map<String, ApplicationCodec.HistoryRow> history = new LinkedHashMap<>();
    private final Map<String, Read> reads = new LinkedHashMap<>();

    public CompanionController(CompanionPlatform platform, ControllerLimits limits, String pcLabel) {
        this.platform = Objects.requireNonNull(platform);
        this.limits = Objects.requireNonNull(limits);
        this.pcLabel = Objects.requireNonNull(pcLabel);
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
                Fence retainedFence = fence;
                fence = retainedFence != null && (paired == null || retainedFence.pcId.equals(paired.pcId))
                    ? retainedFence : paired == null && !uncertain.isEmpty() ? uncertain.get(0) : null;
                if (paired != null) for (Fence previous : uncertain) {
                    if (previous.pcId.equals(paired.pcId)) fence = previous;
                }
                if (fence != null) { selected = fence.sessionId; feedback = Feedback.DELIVERY_UNKNOWN; }
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
        sessionsCursor = historyCursor = null; sessionScan = null;
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
                fence = null;
                for (Fence previous : uncertain) if (previous.pcId.equals(candidate.pcId)) fence = previous;
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
                repairRequired = storageBlocked = false; feedback = Feedback.NONE; publish();
            };
        }, Feedback.FORGET_FAILED, StorageKind.PAIRING);
        publish();
    }

    @Override public void draftChanged(String text) { draft = text; }

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
        listing.baseline = cursor == null && activeWatch == null;
        sendRead(listing, ApplicationCodec.listSessions(request, limits.pageSize, cursor));
    }

    @Override public void selectSession(String sessionId) {
        if (!sessions.containsKey(sessionId) || Objects.equals(selected, sessionId)) return;
        cancelSelectionReads(); selected = sessionId;
        history.clear(); historyCursor = null; statusSession = null;
        if (confirmed) watch();
        publish();
    }

    private void cancelSelectionReads() {
        if (watchRenewal != null) watchRenewal.cancel();
        watchRenewal = null;
        boolean unknownWatch = hasRead(ApplicationCodec.Type.WATCHING);
        for (Read read : new ArrayList<>(reads.values())) {
            if (read.session != null) { reads.remove(read.id); read.deadline.cancel(); }
        }
        ActiveWatch previous = activeWatch;
        activeWatch = null;
        if (unknownWatch) { disconnectedAttempt(); return; }
        if (previous != null && previous.subscription != null && confirmed) cancelSubscription(previous.subscription);
    }

    private void cancelSubscription(String previous) {
        String request = Protocol.randomId(16);
        Read cancel = new Read(request, ApplicationCodec.Type.CANCELLED, null, null);
        cancel.subscription = previous;
        if (!sendRead(cancel, ApplicationCodec.cancelRead(request, previous))) disconnectedAttempt();
    }

    private void readHistory(String cursor) {
        String request = Protocol.randomId(16);
        sendRead(new Read(request, ApplicationCodec.Type.HISTORY, selected, cursor),
            ApplicationCodec.readHistory(request, selected, limits.pageSize, cursor));
    }

    private void watch() {
        if (selected == null || activeWatch != null || hasRead(ApplicationCodec.Type.WATCHING)) return;
        String request = Protocol.randomId(16);
        if (sendRead(new Read(request, ApplicationCodec.Type.WATCHING, selected, null),
            ApplicationCodec.watchProgress(request, selected, null))) {
            activeWatch = new ActiveWatch(request, selected, epoch, attempt);
        }
    }

    private void renewWatch() {
        ActiveWatch watched = activeWatch;
        watchRenewal = platform.later(limits.watchMs, () -> {
            if (!current(watched.owner, watched.attempt) || activeWatch != watched) return;
            cancelSelectionReads();
            if (confirmed && selected != null) watch();
        });
    }

    private boolean hasRead(ApplicationCodec.Type type) {
        for (Read read : reads.values()) if (read.type == type) return true;
        return false;
    }

    private boolean sendRead(Read read, byte[] bytes) {
        if (!foreground || !confirmed || reads.size() >= limits.pendingReads) return false;
        if (link.send(bytes) != PhoneTransport.Admission.ADMITTED_MAY_WRITE) {
            feedback = Feedback.REFRESH_FAILED; publish(); return false;
        }
        long owner = epoch, connection = attempt;
        reads.put(read.id, read);
        read.deadline = platform.later(limits.readMs, () -> {
            if (!current(owner, connection) || reads.remove(read.id) == null) return;
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
            else {
                if (read.session != null && "notFound".equals(message.code)) removeSelection();
                feedback = Feedback.REFRESH_FAILED; publish();
            }
            return;
        }
        switch (message.type) {
            case SESSIONS: if (!read.heartbeat) acceptSessions(read, message); break;
            case HISTORY:
                appendRows(message.rows); historyCursor = message.cursor; break;
            case WATCHING:
                activeWatch.subscription = message.subscriptionId;
                for (ApplicationCodec.Result early : activeWatch.early) progress(early);
                activeWatch.early.clear();
                renewWatch();
                // A cursorless watch establishes its cut before this independently paged history read.
                if (!hasRead(ApplicationCodec.Type.HISTORY)) readHistory(null);
                break;
            case CANCELLED: break;
            default: throw new AssertionError(message.type);
        }
        publish();
    }

    private void acceptSessions(Read read, ApplicationCodec.Result message) {
        if (read.cursor == null) {
            SessionRow retained = sessions.get(selected);
            sessions.clear();
            if (retained != null) sessions.put(retained.id, retained);
            sessionScan = new SessionScan(selected);
        }
        for (ApplicationCodec.SessionSummary summary : message.sessions) {
            sessions.put(summary.sessionId, new SessionRow(summary.sessionId, summary.title, status(summary.status)));
            if (summary.sessionId.equals(selected)) statusSession = selected;
            if (sessionScan != null && summary.sessionId.equals(sessionScan.selected)) sessionScan.found = true;
        }
        trimSessions(); sessionsCursor = message.cursor;
        if (message.cursor == null && sessionScan != null && !sessionScan.found
            && Objects.equals(selected, sessionScan.selected)) removeSelection();
        if (read.baseline && selected != null) watch();
    }

    private void removeSelection() {
        cancelSelectionReads();
        sessions.remove(selected); selected = statusSession = null;
        history.clear(); historyCursor = null;
    }

    private void watchFailed(String code) {
        activeWatch = null; statusSession = null;
        cancelSelectionReads();
        if ("notFound".equals(code)) removeSelection();
        else if (selected != null) readHistory(null);
        // Recovery requires a new explicit refresh; denied/limit cannot create a retry loop.
        feedback = Feedback.REFRESH_FAILED; publish();
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
        sessions.put(selected, new SessionRow(selected, previous.title, status(message.status)));
        statusSession = selected;
        appendRows(message.rows);
        // Progress cursors belong to watchProgress, never to readHistory paging.
        publish();
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

    @Override public void sendText(String text) {
        if (sendState() != SendState.READY) return;
        String request = Protocol.randomId(16), submission = Protocol.randomId(16);
        final byte[] application;
        try { application = ApplicationCodec.submitText(request, selected, text, submission); }
        catch (IllegalArgumentException invalidText) { feedback = Feedback.SEND_FAILED; publish(); return; }
        fence = new Fence(paired.pcId, selected, submission);
        mutation = new Mutation(request, fence, text);
        Mutation pending = mutation;
        long owner = epoch, connection = attempt;
        work(owner, () -> {
            platform.putFence(pending.fence);
            return () -> {
                if (!current(owner, connection) || mutation != pending || !confirmed) return;
                if (link.send(application) != PhoneTransport.Admission.ADMITTED_MAY_WRITE) {
                    // No local admission; clearing still needs a confirmed preference commit.
                    finishFence(pending, Feedback.SEND_FAILED); return;
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
        if (message.type != ApplicationCodec.Type.SUBMITTED || !pending.fence.sessionId.equals(message.sessionId)
            || !pending.fence.submissionId.equals(message.submissionId) || !"inMemoryInbox".equals(message.admission)) {
            if (message.type == ApplicationCodec.Type.ERROR) { deliveryUnknown(); publish(); }
            return;
        }
        if (pending.deadline != null) pending.deadline.cancel();
        finishFence(pending, Feedback.INBOX_ADMITTED);
    }

    private void finishFence(Mutation pending, Feedback outcome) {
        if (storagePending()) return;
        transactStorage(() -> {
            platform.clearFence(pending.fence.pcId);
            return () -> {
                if (fence != pending.fence) return;
                if (outcome == Feedback.INBOX_ADMITTED && draft.equals(pending.text)) draft = "";
                mutation = null; fence = null;
                feedback = repairRequired || storageBlocked ? Feedback.REPAIR_REQUIRED : outcome;
            };
        }, Feedback.STORAGE_FAILED, StorageKind.DELIVERY);
    }

    private void deliveryUnknown() {
        if (mutation != null && mutation.deadline != null) mutation.deadline.cancel();
        mutation = null; feedback = Feedback.DELIVERY_UNKNOWN;
    }

    /** User must first check the original Session; clearing never sends the previous task. */
    public void resolveUnknown() {
        if (!foreground || fence == null || mutation != null || storagePending()) return;
        Fence reviewed = fence;
        transactStorage(() -> {
            platform.clearFence(reviewed.pcId);
            return () -> {
                if (fence == reviewed) {
                    fence = null;
                    feedback = repairRequired || storageBlocked ? Feedback.REPAIR_REQUIRED : Feedback.NONE;
                }
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
            confirmed && sessionsCursor != null && !hasRead(ApplicationCodec.Type.SESSIONS)),
            new Conversation(sessions.get(selected), text,
                confirmed && historyCursor != null && !hasRead(ApplicationCodec.Type.HISTORY)),
            new Composer(draft, sendState(), feedback,
                fence == null ? null : new DeliveryReview(fence.pcId, fence.sessionId, fence.submissionId))));

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
        boolean baseline;
        boolean heartbeat;
        Cancellable deadline;
        Read(String id, ApplicationCodec.Type type, String session, String cursor) {
            this.id = id; this.type = type; this.session = session; this.cursor = cursor;
        }
    }
    private static final class Mutation {
        final String request;
        final Fence fence;
        final String text;
        Cancellable deadline;
        Mutation(String request, Fence fence, String text) { this.request = request; this.fence = fence; this.text = text; }
    }
}
