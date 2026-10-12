package io.harnessy.companion.transport;

import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * One foreground attempt; start once and construct a new instance for every reconnect. No offline queue or retries.
 * Inputs transfer their Authorization lifetime; the supplied channelId is replaced by a fresh phone-generated ID.
 * The Signer must wrap the caller-owned PhoneIdentity; transport never exports or deletes its keystore identity.
 * callbackExecutor must serialize delivery with controller start/close calls (normally Android's main executor).
 * Callbacks run without protocol locks; already-running callbacks must finish before controller teardown completes.
 * close invalidates immediately and never waits for crypto or threads. Await quiescence before discarding an owner.
 * Erasure is best effort: Java Strings, JCA/provider internals and OkHttp buffers cannot be synchronously erased.
 *
 * OkHttp assembles and allocates onMessage(String) before this listener can enforce maxFrameBytes. These limits
 * bound transport retention, not pre-listener library memory; a preassembly cap needs an upstream runtime/library
 * facility. Binary messages are rejected. Native ping is disabled: the current broker closes on ping or pong and
 * only application frames count as activity. OkHttp's automatic response to an unsolicited ping is not configurable
 * through its public WebSocket API; such traffic is outside this broker's supported policy.
 */
public final class PhoneTransport implements AutoCloseable {
    public enum Reason { CONNECT, HANDSHAKE, WRITE, IDLE, LIFETIME, NETWORK, BINARY, PROTOCOL, LIMIT, CALLBACK }
    public enum Admission { ADMITTED_MAY_WRITE, NOT_CONFIRMED, LIMIT, CLOSED }

    /** Public authenticated metadata only; persist it only when onConfirmed is delivered. */
    public static final class Grant {
        public final String grantId;
        public final long generation;
        public final String pcIdentityKey;

        private Grant(Protocol.Channel channel, String pcIdentityKey) {
            grantId = channel.grantId();
            generation = channel.generation();
            this.pcIdentityKey = pcIdentityKey;
        }
    }

    public interface Listener {
        /** Both encrypted confirmations completed; local acceptance alone never emits this event. */
        void onConfirmed(Grant grant);
        /** Fresh authenticated bytes; ownership transfers to the listener, which must parse application messages. */
        void onApplication(byte[] application);
        /** Terminal category, no remote text or exceptions. mayHaveWritten means a local application send was accepted. */
        void onDisconnected(Reason reason, boolean mayHaveWritten);
    }

    private enum Phase { OPEN, CHALLENGE, READY, WELCOME, CONFIRMATION, APPLICATION }
    private enum Kind { OPEN, TEXT, APPLICATION }
    private final Object gate = new Object();
    private final TransportLimits limits;
    private final RetentionBudget budget;
    private final ArrayDeque<Frame> mailbox = new ArrayDeque<>();
    private final ArrayDeque<Notice> notices = new ArrayDeque<>();
    private final CompletableFuture<Void> quiescence = new CompletableFuture<>();
    private final Executor callbackExecutor;
    private Listener listener;
    private final ThreadPoolExecutor worker;
    private final ThreadPoolExecutor network;
    private final ScheduledThreadPoolExecutor timer;
    private final OkHttpClient client;
    private final String endpoint;
    private final String origin;
    private final String pcKey;
    private Protocol.Inputs inputs;
    private final RelayBinding binding;
    private Protocol.Handshake handshake;
    private RetentionBudget.Lease handshakeLease;
    private Protocol.Channel channel;
    private Phase phase = Phase.OPEN;
    private WebSocket socket;
    private Thread workerThread;
    private boolean started;
    private boolean active = true;
    private boolean notificationsEnabled = true;
    private boolean callbackScheduled;
    private boolean confirmed;
    private boolean mayHaveWritten;
    private int socketFrames;
    private long operationGeneration;
    private long born;
    private long lastActivity;
    private long pendingWriteSince;
    private final AtomicInteger terminatedExecutors = new AtomicInteger();
    private volatile boolean resourcesReleased;
    private boolean opened;
    private int encryptedEnvelopeBytes;

    public PhoneTransport(Protocol.Inputs inputs, TransportLimits limits, Executor callbackExecutor, Listener listener)
        throws GeneralSecurityException {
        this.limits = Objects.requireNonNull(limits);
        this.callbackExecutor = Objects.requireNonNull(callbackExecutor);
        this.listener = Objects.requireNonNull(listener);
        this.inputs = new Protocol.Inputs(inputs.publicPhoneSpki, inputs.signer, inputs.origin,
            inputs.pinnedPcSpki, Protocol.randomId(16), inputs.authorization);
        origin = this.inputs.origin;
        pcKey = this.inputs.pinnedPcSpki;
        endpoint = origin + "/companion/phone";
        binding = new RelayBinding(this.inputs);
        budget = new RetentionBudget(limits.frames);
        worker = ownedExecutor("companion-protocol");
        network = ownedExecutor("companion-network");
        timer = new ScheduledThreadPoolExecutor(1, runnable -> new Thread(runnable, "companion-deadlines")) {
            @Override protected void terminated() { executorTerminated(); }
        };
        timer.setRemoveOnCancelPolicy(true);
        client = createClient();
    }

    private ThreadPoolExecutor ownedExecutor(String name) {
        return new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1),
            runnable -> new Thread(runnable, name), new ThreadPoolExecutor.AbortPolicy()) {
            @Override protected void terminated() { executorTerminated(); }
        };
    }

    private OkHttpClient createClient() {
        Dispatcher dispatcher = new Dispatcher(network);
        dispatcher.setMaxRequests(1);
        dispatcher.setMaxRequestsPerHost(1);
        return new OkHttpClient.Builder().dispatcher(dispatcher).connectionPool(new ConnectionPool())
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(limits.deadlines.connectMs, TimeUnit.MILLISECONDS)
            .readTimeout(limits.deadlines.connectMs, TimeUnit.MILLISECONDS)
            .callTimeout(limits.deadlines.connectMs, TimeUnit.MILLISECONDS)
            .writeTimeout(limits.deadlines.writeMs, TimeUnit.MILLISECONDS).pingInterval(0, TimeUnit.MILLISECONDS)
            .minWebSocketMessageToCompress(Long.MAX_VALUE)
            // 4.12.0 offers permessage-deflate internally; remove that offer before the HTTP request is sent.
            .addInterceptor(chain -> chain.proceed(chain.request().newBuilder()
                .removeHeader("Sec-WebSocket-Extensions").build())).build();
    }

    /** Returns false after a prior start or teardown. Does not perform network or keystore work on the caller. */
    public boolean start() {
        synchronized (gate) {
            if (started || !active) return false;
            started = true;
            born = lastActivity = System.nanoTime();
            worker.execute(this::runAttempt);
            timer.scheduleAtFixedRate(this::checkDeadlines, limits.deadlines.activity.tickMs,
                limits.deadlines.activity.tickMs, TimeUnit.MILLISECONDS);
            return true;
        }
    }

    /**
     * Admit an immutable copy only after mutual confirmation. ADMITTED_MAY_WRITE is not delivery or an ACK;
     * the controller must treat a mutation as uncertain until its application ACK and must not auto-retry it.
     * Admission reserves the complete encrypted UTF-8 envelope bytes before copying, including the relay wrapper.
     */
    public Admission sendApplication(byte[] application) {
        Objects.requireNonNull(application);
        synchronized (gate) {
            if (!active) return Admission.CLOSED;
            if (!confirmed) return Admission.NOT_CONFIRMED;
            if (application.length > Protocol.MAX_APPLICATION_BYTES) return Admission.LIMIT;
            int frameBytes = encryptedEnvelopeBytes + ((application.length + 1) * 4 + 2) / 3;
            if (frameBytes > limits.frames.maxFrameBytes) return Admission.LIMIT;
            RetentionBudget.Lease lease = budget.reserve(frameBytes);
            if (lease == null) return Admission.LIMIT;
            try {
                mailbox.addLast(new Frame(application.clone(), lease));
                gate.notifyAll();
                return Admission.ADMITTED_MAY_WRITE;
            } catch (RuntimeException | Error failedCopy) {
                lease.close();
                throw failedCopy;
            }
        }
    }

    /** Idempotent immediate invalidation; suppresses all pending callbacks, including disconnect. Never joins threads. */
    @Override public void close() {
        synchronized (gate) {
            notificationsEnabled = false;
            listener = null;
            operationGeneration++;
            clearNotices();
        }
        terminate(null);
    }

    /** Completion means protocol/key references and admitted queues were released and all three owned executors ended. */
    public CompletionStage<Void> quiescence() { return quiescence; }

    private void runAttempt() {
        synchronized (gate) { workerThread = Thread.currentThread(); }
        try {
            if (!isActive()) return;
            openSocket();
            while (isActive()) {
                Frame frame = nextFrame();
                if (frame == null) break;
                try { consume(frame); }
                finally { frame.close(); }
            }
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            terminate(Reason.NETWORK);
        } catch (GeneralSecurityException | IOException | IllegalArgumentException invalidProtocol) {
            terminate(Reason.PROTOCOL);
        } catch (RuntimeException failedOperation) {
            terminate(Reason.NETWORK);
        } finally {
            terminate(null);
            releaseProtocol();
        }
    }

    private void openSocket() {
        Request request = new Request.Builder().url("wss" + endpoint.substring(5)).header("Origin", origin).build();
        WebSocket opened = client.newWebSocket(request, new SocketListener());
        synchronized (gate) {
            if (active) socket = opened;
            else opened.cancel();
        }
    }

    private Frame nextFrame() throws InterruptedException {
        synchronized (gate) {
            while (active && mailbox.isEmpty()) gate.wait();
            return active ? mailbox.removeFirst() : null;
        }
    }

    private void consume(Frame frame) throws GeneralSecurityException, IOException {
        if (!isActive()) return;
        if (frame.kind == Kind.OPEN) {
            if (phase != Phase.OPEN) throw new IllegalArgumentException("Repeated socket open");
            phase = Phase.CHALLENGE;
            sendControl(Protocol.relayRegistration(inputs.publicPhoneSpki, binding.pcId()));
        } else if (frame.kind == Kind.APPLICATION) {
            channel.sendApplication(frame.application, this::sendEncrypted);
        } else consumeText(StrictJson.parse(frame.text, limits.frames.maxFrameBytes));
    }

    private void consumeText(Object wire) throws GeneralSecurityException, IOException {
        switch (phase) {
            case CHALLENGE:
                Map<String, Object> challenge = binding.challenge(wire);
                sendControl(Protocol.relayProof(challenge, inputs.publicPhoneSpki, inputs.signer,
                    origin, binding.pcId(), binding.phoneGeneration()));
                phase = Phase.READY;
                break;
            case READY:
                binding.ready(wire);
                createHandshake();
                phase = Phase.WELCOME;
                sendControl(Protocol.relayData(handshake.hello().get("channelId").toString(),
                    binding.phoneGeneration(), handshake.hello()));
                break;
            case WELCOME:
                completeHandshake(binding.inbound(wire));
                break;
            case CONFIRMATION:
            case APPLICATION:
                receiveEncrypted(binding.inbound(wire));
                break;
            default: throw new IllegalArgumentException("Unexpected frame phase");
        }
    }

    private void createHandshake() throws GeneralSecurityException, IOException {
        handshakeLease = budget.reserve(limits.frames.maxFrameBytes);
        if (handshakeLease == null) { terminate(Reason.LIMIT); throw new IOException("Handshake admission rejected"); }
        Protocol.Inputs captured = inputs;
        try { handshake = new Protocol.Handshake(captured); }
        finally {
            captured.authorization.close();
            inputs = null;
        }
    }

    private void completeHandshake(Map<String, Object> welcome) throws GeneralSecurityException, IOException {
        channel = handshake.complete(welcome);
        handshake.close();
        handshake = null;
        handshakeLease.close();
        handshakeLease = null;
        phase = Phase.CONFIRMATION;
        channel.sendConfirmation(this::sendEncrypted);
    }

    private void receiveEncrypted(Map<String, Object> encrypted) throws GeneralSecurityException {
        byte[] application = channel.receive(encrypted);
        if (application == null) {
            if (!channel.confirmed() || phase != Phase.CONFIRMATION) throw new IllegalArgumentException("Confirmation mismatch");
            phase = Phase.APPLICATION;
            int envelopeBytes = encryptedEnvelopeBytes();
            synchronized (gate) {
                if (!active) return;
                encryptedEnvelopeBytes = envelopeBytes;
                confirmed = true;
            }
            enqueueNotice(new Grant(channel, pcKey));
        } else enqueueApplication(application);
    }

    /** Counts fixed fields using the actual authenticated grant and socket IDs; base64 ciphertext is added at admission. */
    private int encryptedEnvelopeBytes() throws GeneralSecurityException {
        Map<String, Object> frame = Protocol.object(
            "v", 1, "type", "encrypted", "direction", "phone-to-pc", "channelId", channel.channelId(),
            "grantId", channel.grantId(), "generation", channel.generation(), "counter", Protocol.encodeCounter(0),
            "ciphertext", "", "tag", Protocol.encodeBase64Url(new byte[16]));
        String envelope = StrictJson.stringify(Protocol.relayData(channel.channelId(), binding.phoneGeneration(), frame));
        return StrictJson.utf8Length(envelope);
    }

    private boolean sendEncrypted(String encrypted) throws IOException {
        try {
            return writeText(StrictJson.stringify(Protocol.relayData(channel.channelId(),
                binding.phoneGeneration(), StrictJson.parse(encrypted)), limits.frames.maxFrameBytes), phase == Phase.APPLICATION);
        } catch (GeneralSecurityException invalidEnvelope) { throw new IOException("Invalid outbound envelope", invalidEnvelope); }
    }

    private void sendControl(Object control) throws IOException {
        if (!writeText(StrictJson.stringify(control, limits.frames.maxFrameBytes), false)) {
            throw new IOException("Local control queue rejected");
        }
    }

    private boolean writeText(String text, boolean application) {
        int bytes = StrictJson.utf8Length(text);
        synchronized (gate) {
            if (!active || socket == null || bytes > limits.frames.maxFrameBytes) return false;
            long queued = socket.queueSize();
            if (queued == 0) { socketFrames = 0; pendingWriteSince = 0; }
            if (socketFrames >= limits.frames.maxRetainedFrames || bytes > limits.frames.maxSocketQueueBytes - queued) {
                terminate(Reason.LIMIT);
                return false;
            }
            if (!socket.send(text)) { terminate(Reason.WRITE); return false; }
            socketFrames++;
            if (pendingWriteSince == 0) pendingWriteSince = System.nanoTime();
            lastActivity = System.nanoTime();
            if (application) mayHaveWritten = true;
            return true;
        }
    }

    private boolean isActive() { synchronized (gate) { return active; } }

    private void checkDeadlines() {
        synchronized (gate) {
            if (!active) return;
            long now = System.nanoTime();
            if (elapsed(now, born, limits.deadlines.activity.lifetimeMs)) terminate(Reason.LIFETIME);
            else if (phase == Phase.OPEN && elapsed(now, born, limits.deadlines.connectMs)) terminate(Reason.CONNECT);
            else if (!confirmed && elapsed(now, born, limits.deadlines.handshakeMs)) terminate(Reason.HANDSHAKE);
            else if (elapsed(now, lastActivity, limits.deadlines.activity.idleMs)) terminate(Reason.IDLE);
            else checkWriteDeadline(now);
        }
    }

    private void checkWriteDeadline(long now) {
        if (socket == null) return;
        if (socket.queueSize() == 0) { socketFrames = 0; pendingWriteSince = 0; }
        else if (pendingWriteSince != 0 && elapsed(now, pendingWriteSince, limits.deadlines.writeMs)) terminate(Reason.WRITE);
    }

    private static boolean elapsed(long now, long since, int milliseconds) {
        return now - since >= TimeUnit.MILLISECONDS.toNanos(milliseconds);
    }

    private void terminate(Reason reason) {
        synchronized (gate) {
            if (!active) return;
            active = false;
            confirmed = false;
            operationGeneration++;
            while (!mailbox.isEmpty()) mailbox.removeFirst().close();
            clearNotices();
            if (socket != null) { socket.cancel(); socket = null; }
            timer.shutdownNow();
            worker.shutdown();
            client.dispatcher().cancelAll();
            network.shutdown();
            if (workerThread != null && workerThread != Thread.currentThread()) workerThread.interrupt();
            gate.notifyAll();
            if (!started) releaseProtocol();
            if (reason != null && notificationsEnabled) {
                notices.addLast(new Notice(reason, mayHaveWritten, operationGeneration));
                scheduleCallbacks();
            }
        }
    }

    private void releaseProtocol() {
        if (handshake != null) { handshake.close(); handshake = null; }
        if (channel != null) { channel.close(); channel = null; }
        if (inputs != null) { inputs.authorization.close(); inputs = null; }
        binding.clear();
        client.connectionPool().evictAll();
        synchronized (gate) {
            workerThread = null;
            resourcesReleased = true;
            completeQuiescence();
        }
    }

    private void executorTerminated() {
        synchronized (gate) { terminatedExecutors.incrementAndGet(); completeQuiescence(); }
    }

    private void completeQuiescence() {
        if (resourcesReleased && terminatedExecutors.get() == 3) quiescence.complete(null);
    }

    private void enqueueNotice(Grant grant) {
        synchronized (gate) {
            if (!active) return;
            RetentionBudget.Lease lease = budget.reserve(0);
            if (lease == null) { terminate(Reason.LIMIT); return; }
            notices.addLast(new Notice(grant, lease, operationGeneration));
            scheduleCallbacks();
        }
    }

    private void enqueueApplication(byte[] application) {
        synchronized (gate) {
            RetentionBudget.Lease lease = active ? budget.reserve(application.length) : null;
            if (lease == null) {
                Arrays.fill(application, (byte) 0);
                if (active) terminate(Reason.LIMIT);
                return;
            }
            notices.addLast(new Notice(application, lease, operationGeneration));
            scheduleCallbacks();
        }
    }

    private void scheduleCallbacks() {
        if (callbackScheduled) return;
        callbackScheduled = true;
        try { callbackExecutor.execute(this::deliverNotices); }
        catch (RejectedExecutionException rejectedDelivery) {
            callbackScheduled = false;
            notificationsEnabled = false;
            listener = null;
            clearNotices();
            terminate(Reason.CALLBACK);
        }
    }

    private void deliverNotices() {
        while (true) {
            Notice notice;
            Listener target;
            synchronized (gate) {
                if (notices.isEmpty()) { callbackScheduled = false; return; }
                notice = notices.removeFirst();
                target = notificationsEnabled && notice.generation == operationGeneration ? listener : null;
            }
            try {
                if (target != null) notice.deliver(target);
            } catch (RuntimeException failedListener) {
                // Application callbacks cannot leave a live transport with a broken controller.
                close();
            } finally { notice.close(); }
        }
    }

    private void clearNotices() { while (!notices.isEmpty()) notices.removeFirst().close(); }

    private void enqueueFrame(Frame frame) {
        synchronized (gate) {
            if (!active) { frame.close(); return; }
            mailbox.addLast(frame);
            lastActivity = System.nanoTime();
            gate.notifyAll();
        }
    }

    private final class SocketListener extends WebSocketListener {
        @Override public void onOpen(WebSocket webSocket, Response response) {
            if (!endpoint.equals(response.request().url().toString()) || response.header("Sec-WebSocket-Extensions") != null) {
                terminate(Reason.PROTOCOL);
                webSocket.cancel();
                return;
            }
            // Publication can race newWebSocket's return; both references refer to this single owned socket.
            synchronized (gate) {
                if (!active) { webSocket.cancel(); return; }
                socket = webSocket;
                RetentionBudget.Lease lease = budget.reserve(0);
                if (lease == null) { terminate(Reason.LIMIT); return; }
                enqueueFrame(new Frame(Kind.OPEN, null, lease));
            }
        }

        @Override public void onMessage(WebSocket webSocket, String text) {
            synchronized (gate) {
                if (!active) return;
                int bytes;
                try {
                    StrictJson.requireText(text, limits.frames.maxFrameBytes);
                    bytes = StrictJson.utf8Length(text);
                } catch (IllegalArgumentException invalidText) { terminate(Reason.LIMIT); return; }
                RetentionBudget.Lease lease = budget.reserve(bytes);
                if (lease == null) { terminate(Reason.LIMIT); return; }
                enqueueFrame(new Frame(Kind.TEXT, text, lease));
            }
        }

        @Override public void onMessage(WebSocket webSocket, ByteString binary) { terminate(Reason.BINARY); }
        @Override public void onClosing(WebSocket webSocket, int code, String reason) { terminate(Reason.NETWORK); }
        @Override public void onClosed(WebSocket webSocket, int code, String reason) { terminate(Reason.NETWORK); }
        @Override public void onFailure(WebSocket webSocket, Throwable failure, Response response) { terminate(Reason.NETWORK); }
    }

    private static final class Frame implements AutoCloseable {
        final Kind kind;
        final String text;
        final byte[] application;
        final RetentionBudget.Lease lease;

        Frame(Kind kind, String text, RetentionBudget.Lease lease) {
            this.kind = kind; this.text = text; this.lease = lease; application = null;
        }

        Frame(byte[] application, RetentionBudget.Lease lease) {
            kind = Kind.APPLICATION; text = null; this.application = application; this.lease = lease;
        }

        public void close() {
            if (application != null) Arrays.fill(application, (byte) 0);
            lease.close();
        }
    }

    private static final class Notice implements AutoCloseable {
        final Grant grant;
        byte[] application;
        final Reason reason;
        final boolean mayHaveWritten;
        final long generation;
        final RetentionBudget.Lease lease;

        Notice(Grant grant, RetentionBudget.Lease lease, long generation) {
            this.grant = grant; this.lease = lease; this.generation = generation;
            application = null; reason = null; mayHaveWritten = false;
        }

        Notice(byte[] application, RetentionBudget.Lease lease, long generation) {
            this.application = application; this.lease = lease; this.generation = generation;
            grant = null; reason = null; mayHaveWritten = false;
        }

        Notice(Reason reason, boolean mayHaveWritten, long generation) {
            this.reason = reason; this.mayHaveWritten = mayHaveWritten; this.generation = generation;
            grant = null; application = null; lease = null;
        }

        void deliver(Listener listener) {
            if (grant != null) listener.onConfirmed(grant);
            else if (application != null) {
                byte[] transferred = application;
                application = null;
                listener.onApplication(transferred);
            } else listener.onDisconnected(reason, mayHaveWritten);
        }

        public void close() {
            if (application != null) { Arrays.fill(application, (byte) 0); application = null; }
            if (lease != null) lease.close();
        }
    }
}
