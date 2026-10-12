package io.harnessy.companion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import io.harnessy.companion.identity.PhoneIdentity;
import io.harnessy.companion.pairing.OperationStore;
import io.harnessy.companion.pairing.PairingMetadata;
import io.harnessy.companion.pairing.PairingStore;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.transport.PhoneTransport;
import io.harnessy.companion.transport.TransportLimits;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Application-context platform adapter; all keystore/preferences operations share one bounded serial executor. */
public final class AndroidCompanionPlatform implements CompanionPlatform {
    private final Context context;
    private final TransportLimits transportLimits;
    private final String pcLabel;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor io;
    private final PhoneIdentity identity = new PhoneIdentity();
    private PairingStore pairings;
    private OperationStore operations;
    private java.util.concurrent.CompletionStage<Void> previousLink = java.util.concurrent.CompletableFuture.completedFuture(null);

    public AndroidCompanionPlatform(Context context, TransportLimits transportLimits, int ioQueue) {
        if (ioQueue < 1 || ioQueue > 128) throw new IllegalArgumentException("Invalid IO queue budget");
        this.context = context.getApplicationContext();
        this.transportLimits = transportLimits;
        pcLabel = context.getString(R.string.linked_pc);
        io = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(ioQueue),
            runnable -> new Thread(runnable, "companion-storage"), new ThreadPoolExecutor.AbortPolicy());
    }

    public void main(Runnable callback) { main.post(callback); }
    public void io(Runnable operation) { io.execute(operation); }
    public long now() { return System.currentTimeMillis(); }
    public long elapsed() { return android.os.SystemClock.elapsedRealtime(); }
    public Cancellable later(int milliseconds, Runnable callback) {
        main.postDelayed(callback, milliseconds);
        return () -> main.removeCallbacks(callback);
    }

    private PairingStore pairingStore() {
        if (pairings == null) pairings = new PairingStore(context);
        return pairings;
    }
    private OperationStore operationStore() {
        if (operations == null) operations = new OperationStore(context);
        return operations;
    }

    public List<Paired> pairings() throws IOException, GeneralSecurityException {
        List<Paired> saved = new ArrayList<>();
        for (PairingMetadata metadata : pairingStore().list()) {
            PhoneIdentity.requireAlias(metadata.phoneKeyAlias);
            if (!metadata.grant.generation.matches("[1-9][0-9]{0,9}")) throw new IOException("Invalid saved generation");
            long generation = Long.parseLong(metadata.grant.generation);
            saved.add(new Paired(new String[] { metadata.pc.id, metadata.pc.publicKeySpkiBase64Url,
                metadata.origin, metadata.phoneKeyAlias, metadata.grant.id }, generation));
        }
        return saved;
    }

    public Identity identity(String alias) throws IOException, GeneralSecurityException {
        return publicIdentity(identity.publicKey(alias));
    }
    public Identity createIdentity() throws IOException, GeneralSecurityException {
        return publicIdentity(identity.createForPairing());
    }
    public void deleteIdentity(String alias) throws IOException, GeneralSecurityException { identity.removeKey(alias); }

    private static Identity publicIdentity(PhoneIdentity.PublicIdentity publicKey) throws GeneralSecurityException {
        Protocol.parsePublicKey(publicKey.spkiBase64Url());
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(publicKey.spkiDer());
        StringBuilder fingerprint = new StringBuilder(64);
        for (byte octet : digest) {
            fingerprint.append(Character.forDigit((octet & 255) >>> 4, 16));
            fingerprint.append(Character.forDigit(octet & 15, 16));
        }
        return new Identity(publicKey.keyAlias, publicKey.spkiBase64Url(), fingerprint.toString());
    }

    /** Called by the transport protocol worker, never from this adapter's IO owner. */
    public byte[] sign(String alias, byte[] transcript) throws IOException, GeneralSecurityException {
        final Future<byte[]> signature;
        try { signature = io.submit(() -> identity.signTranscript(alias, transcript)); }
        catch (java.util.concurrent.RejectedExecutionException unavailableOwner) {
            throw new IOException("Identity owner unavailable", unavailableOwner);
        }
        try { return signature.get(); }
        catch (InterruptedException cancelled) {
            signature.cancel(true); Thread.currentThread().interrupt(); throw new IOException("Signing cancelled", cancelled);
        } catch (ExecutionException failedSigning) {
            Throwable failure = failedSigning.getCause();
            if (failure instanceof GeneralSecurityException) throw (GeneralSecurityException) failure;
            if (failure instanceof IOException) throw (IOException) failure;
            throw new IOException("Identity provider failed", failure);
        }
    }

    public void save(Paired paired) throws IOException {
        PairingMetadata metadata = new PairingMetadata(
            new PairingMetadata.PcIdentity(paired.pcId, paired.pcKey, pcLabel),
            new PairingMetadata.Grant(paired.grantId, Long.toString(paired.generation)), paired.origin, paired.alias);
        pairingStore().save(metadata);
    }
    public void forget(String pcId) throws IOException { pairingStore().remove(pcId); }
    public List<Fence> fences() throws IOException { return operationStore().fences(); }
    public void putFence(Fence fence) throws IOException { operationStore().putFence(fence); }
    public void clearFence(String pcId) throws IOException { operationStore().clearFence(pcId); }
    public void repair(String pcId, String alias) throws IOException { operationStore().repair(pcId, alias); }
    public void clearRepair(String pcId) throws IOException { operationStore().clearRepair(pcId); }
    public List<Repair> repairs() throws IOException { return operationStore().repairs(); }

    public Link connect(Protocol.Inputs inputs, Events events) throws GeneralSecurityException {
        // Also serialize attempts belonging to different Activity instances; never join on the main thread.
        try { previousLink.toCompletableFuture().get(); }
        catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt(); throw new GeneralSecurityException("Transport retirement interrupted", cancelled);
        } catch (ExecutionException failedRetirement) {
            throw new GeneralSecurityException("Transport retirement failed", failedRetirement.getCause());
        }
        PhoneTransport transport = new PhoneTransport(inputs, transportLimits, this::main, new PhoneTransport.Listener() {
            public void onConfirmed(PhoneTransport.Grant grant) {
                events.confirmed(grant.grantId, grant.generation, grant.pcIdentityKey);
            }
            public void onApplication(byte[] bytes) { events.application(bytes); }
            public void onDisconnected(PhoneTransport.Reason reason, boolean mayHaveWritten) { events.disconnected(); }
        });
        previousLink = transport.quiescence();
        return new Link() {
            public boolean start() { return transport.start(); }
            public PhoneTransport.Admission send(byte[] bytes) { return transport.sendApplication(bytes); }
            public void close() { transport.close(); }
            public java.util.concurrent.CompletionStage<Void> quiescence() { return transport.quiescence(); }
        };
    }
}
