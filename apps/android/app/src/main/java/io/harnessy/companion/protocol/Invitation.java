package io.harnessy.companion.protocol;

import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Map;

/** Transient exact harnessy://pair# invitation. No secret is persisted, logged or included in toString. */
public final class Invitation implements AutoCloseable {
    private static final String PREFIX = "harnessy://pair#";
    /** Complete UTF-8 invitation text limit, including text awaiting metadata reconciliation. */
    public static final int MAX_LINK_BYTES = 4096;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    public final String httpsOrigin;
    public final String pcId;
    public final String pcIdentityKey;
    public final String invitationId;
    public final long expiresAt;
    private byte[] secret;

    private Invitation(String origin, String pcId, String spki, String invitationId, long expiry, byte[] secret) {
        this.httpsOrigin = origin;
        this.pcId = pcId;
        this.pcIdentityKey = spki;
        this.invitationId = invitationId;
        this.expiresAt = expiry;
        this.secret = secret.clone();
    }

    /** Parses without navigation or DNS; the PC independently enforces approval, expiry and single use. */
    public static Invitation parse(String link, long now) throws GeneralSecurityException {
        StrictJson.requireText(link, MAX_LINK_BYTES);
        if (!link.startsWith(PREFIX)) throw new IllegalArgumentException("Unsupported invitation URL");
        Protocol.integer(now, 0, MAX_SAFE_INTEGER);
        byte[] encoded = Protocol.decodeBase64Url(link.substring(PREFIX.length()), -1, MAX_LINK_BYTES);
        byte[] secret = null;
        try {
            Map<String, Object> row = Protocol.exactRecord(StrictJson.parse(encoded, MAX_LINK_BYTES),
                "v", "httpsOrigin", "pcId", "pcIdentityKey", "invitationId", "expiresAt", "secret");
            Protocol.version(row);
            String origin = Protocol.parseHttpsOrigin(row.get("httpsOrigin"));
            String spki = Protocol.parsePublicKey(row.get("pcIdentityKey"));
            String pcId = Protocol.parsePcId(row.get("pcId"));
            if (!pcId.equals(Protocol.derivePcId(spki))) throw new IllegalArgumentException("Invitation PC identity mismatch");
            String invitationId = Protocol.parseId(row.get("invitationId"));
            long expiry = Protocol.integer(row.get("expiresAt"), 1, MAX_SAFE_INTEGER);
            if (expiry <= now) throw new IllegalArgumentException("Invitation expired");
            secret = Protocol.decodeBase64Url(row.get("secret"), 32);
            return new Invitation(origin, pcId, spki, invitationId, expiry, secret);
        } finally {
            Arrays.fill(encoded, (byte) 0);
            if (secret != null) Arrays.fill(secret, (byte) 0);
        }
    }

    /** Caller owns the returned copy and must clear it after creating transient authorization. */
    public synchronized byte[] secret() {
        if (secret == null) throw new IllegalStateException("Invitation closed");
        return secret.clone();
    }

    public synchronized Protocol.Authorization authorization() {
        if (secret == null) throw new IllegalStateException("Invitation closed");
        return Protocol.Authorization.invitation(invitationId, secret);
    }

    public synchronized void close() {
        if (secret != null) Arrays.fill(secret, (byte) 0);
        secret = null;
    }
}
