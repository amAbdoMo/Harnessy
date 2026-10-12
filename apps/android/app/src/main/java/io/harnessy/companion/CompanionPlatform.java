package io.harnessy.companion;

import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.transport.PhoneTransport;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.List;
import java.util.concurrent.CompletionStage;

/** External platform operations only; the controller and its DTO/correlation state remain real in regressions. */
public interface CompanionPlatform {
    void main(Runnable callback);
    void io(Runnable operation);
    Cancellable later(int milliseconds, Runnable callback);
    long now();
    long elapsed();
    List<Paired> pairings() throws IOException, GeneralSecurityException;
    Identity identity(String alias) throws IOException, GeneralSecurityException;
    Identity createIdentity() throws IOException, GeneralSecurityException;
    void deleteIdentity(String alias) throws IOException, GeneralSecurityException;
    byte[] sign(String alias, byte[] transcript) throws IOException, GeneralSecurityException;
    void save(Paired paired) throws IOException;
    void forget(String pcId) throws IOException;
    List<Fence> fences() throws IOException;
    void putFence(Fence fence) throws IOException;
    void clearFence(String pcId) throws IOException;
    void repair(String pcId, String alias) throws IOException;
    void clearRepair(String pcId) throws IOException;
    List<Repair> repairs() throws IOException;
    Link connect(Protocol.Inputs inputs, Events events) throws GeneralSecurityException;

    interface Cancellable { void cancel(); }
    interface Link {
        boolean start();
        PhoneTransport.Admission send(byte[] application);
        void close();
        CompletionStage<Void> quiescence();
    }
    interface Events {
        void confirmed(String grantId, long generation, String pcKey);
        void application(byte[] bytes);
        void disconnected();
    }
    final class Identity {
        public final String alias;
        public final String spki;
        public final String fingerprint;
        public Identity(String alias, String spki, String fingerprint) {
            this.alias = alias; this.spki = spki; this.fingerprint = fingerprint;
        }
    }
    final class Paired {
        public final String pcId;
        public final String pcKey;
        public final String origin;
        public final String alias;
        public final String grantId;
        public final long generation;
        public Paired(String[] publicFields, long generation) throws GeneralSecurityException {
            if (publicFields.length != 5) throw new IllegalArgumentException("Expected public pairing fields");
            pcId = Protocol.parsePcId(publicFields[0]); pcKey = Protocol.parsePublicKey(publicFields[1]);
            origin = Protocol.parseHttpsOrigin(publicFields[2]); alias = publicFields[3];
            grantId = Protocol.parseId(publicFields[4]);
            this.generation = Protocol.integer(generation, 1, 0xffffffffL);
            if (!pcId.equals(Protocol.derivePcId(pcKey))) throw new IllegalArgumentException("Saved PC key mismatch");
        }
    }
    /** Public alias retained independently while enrollment/removal durability is uncertain. */
    final class Repair {
        public final String pcId;
        public final String alias;
        public Repair(String pcId, String alias) { this.pcId = Protocol.parsePcId(pcId); this.alias = alias; }
    }
    /** No task text, invitation, secret, or retry payload. */
    final class Fence {
        public final String pcId;
        public final String sessionId;
        public final String submissionId;
        public Fence(String pcId, String sessionId, String submissionId) {
            this.pcId = Protocol.parsePcId(pcId);
            this.sessionId = io.harnessy.companion.protocol.ApplicationCodec.sessionId(sessionId);
            this.submissionId = Protocol.parseId16(submissionId);
        }
    }
}
