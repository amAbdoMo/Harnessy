package io.harnessy.companion.pairing;

import android.util.Base64;

import io.harnessy.companion.identity.PhoneIdentity;

/** Public enrollment result only; local representation is not an invitation or protocol schema. */
public final class PairingMetadata {
    public final PcIdentity pc;
    public final Grant grant;
    public final String origin;
    public final String phoneKeyAlias;

    /** The protocol owner must authenticate the PC key and ensure the grant fields are public IDs. */
    public PairingMetadata(PcIdentity pc, Grant grant, String origin, String phoneKeyAlias) {
        this.pc = java.util.Objects.requireNonNull(pc);
        this.grant = java.util.Objects.requireNonNull(grant);
        this.origin = HttpsOrigin.canonical(origin);
        PhoneIdentity.requireAlias(phoneKeyAlias);
        this.phoneKeyAlias = phoneKeyAlias;
    }

    public static final class PcIdentity {
        public final String id;
        public final String publicKeySpkiBase64Url;
        public final String displayName;

        /** Parent validates key algorithm/SPKI and wire IDs before constructing this public snapshot. */
        public PcIdentity(String id, String publicKeySpkiBase64Url, String displayName) {
            this.id = checkedText(id, 1024);
            this.publicKeySpkiBase64Url = checkedPublicKey(publicKeySpkiBase64Url);
            this.displayName = checkedText(displayName, 256);
        }
    }

    public static final class Grant {
        public final String id;
        public final String generation;

        /** Both strings are public identifiers, never invitation secrets or bearer credentials. */
        public Grant(String id, String generation) {
            this.id = checkedText(id, 1024);
            this.generation = checkedText(generation, 1024);
        }
    }

    private static String checkedText(String text, int maximum) {
        if (text == null || text.trim().isEmpty() || text.length() > maximum) {
            throw new IllegalArgumentException("Invalid public pairing metadata length");
        }
        for (int index = 0; index < text.length(); index++) {
            if (Character.isISOControl(text.charAt(index))) {
                throw new IllegalArgumentException("Control character in public pairing metadata");
            }
        }
        return text;
    }

    private static String checkedPublicKey(String encoded) {
        checkedText(encoded, 8192);
        if (!encoded.matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("Invalid public key base64url");
        }
        byte[] publicBytes = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        String canonical = Base64.encodeToString(publicBytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        if (publicBytes.length == 0 || publicBytes.length > 4096 || !canonical.equals(encoded)) {
            throw new IllegalArgumentException("Noncanonical public key base64url");
        }
        return encoded;
    }
}
