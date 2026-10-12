package io.harnessy.companion.identity;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.IOException;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.ProviderException;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.util.UUID;
import java.util.regex.Pattern;

/** Per-operation AndroidKeyStore access; never exports a private key or caches identity state. */
public final class PhoneIdentity {
    private static final String PROVIDER = "AndroidKeyStore";
    private static final String ALIAS_PREFIX = "harnessy.companion.pairing.";
    private static final Pattern ALIAS = Pattern.compile(
        "harnessy\\.companion\\.pairing\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    /** Creation is enrollment-only. Never call this to recover an existing missing/corrupt key. */
    public PublicIdentity createForPairing() throws GeneralSecurityException, IOException {
        String alias = ALIAS_PREFIX + UUID.randomUUID();
        KeyStore store = openStore();
        if (store.containsAlias(alias)) throw new GeneralSecurityException("Identity alias collision");
        try {
            generateKey(alias);
            return publicKey(alias);
        } catch (GeneralSecurityException | IOException | ProviderException failedCreation) {
            CreationException enrollmentFailure = new CreationException(alias, failedCreation);
            try {
                store.deleteEntry(alias);
            } catch (GeneralSecurityException failedCleanup) {
                enrollmentFailure.addSuppressed(failedCleanup);
            }
            throw enrollmentFailure;
        }
    }

    /** Returns canonical provider SPKI DER and unpadded base64url; missing keys require explicit re-pair. */
    public PublicIdentity publicKey(String alias) throws GeneralSecurityException, IOException {
        KeyStore.PrivateKeyEntry entry = identityEntry(alias);
        ECPublicKey publicKey = checkedPublicKey(entry);
        return new PublicIdentity(alias, publicKey.getEncoded());
    }

    /** Signs exact controller-supplied transcript bytes with SHA256withECDSA; signature is DER, not P1363. */
    public byte[] signTranscript(String alias, byte[] transcript) throws GeneralSecurityException, IOException {
        KeyStore.PrivateKeyEntry entry = identityEntry(alias);
        checkedPublicKey(entry);
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(entry.getPrivateKey());
        signature.update(transcript);
        return signature.sign();
    }

    /** Removes only this pairing's alias; already-absent aliases are harmless during explicit forget. */
    public void removeKey(String alias) throws GeneralSecurityException, IOException {
        requireAlias(alias);
        openStore().deleteEntry(alias);
    }

    /** Restricts persisted references so corrupt metadata cannot delete unrelated application keys. */
    public static void requireAlias(String alias) {
        if (alias == null || !ALIAS.matcher(alias).matches()) {
            throw new IllegalArgumentException("Invalid pairing key alias");
        }
    }

    private KeyStore.PrivateKeyEntry identityEntry(String alias) throws GeneralSecurityException, IOException {
        requireAlias(alias);
        KeyStore.Entry entry = openStore().getEntry(alias, null);
        if (!(entry instanceof KeyStore.PrivateKeyEntry)) {
            throw new IdentityUnavailableException("Pairing identity is missing or invalid; re-pair required");
        }
        return (KeyStore.PrivateKeyEntry) entry;
    }

    private ECPublicKey checkedPublicKey(KeyStore.PrivateKeyEntry entry) throws GeneralSecurityException {
        if (!(entry.getCertificate().getPublicKey() instanceof ECPublicKey)) {
            throw new IdentityUnavailableException("Pairing identity is not EC; re-pair required");
        }
        ECPublicKey publicKey = (ECPublicKey) entry.getCertificate().getPublicKey();
        if (!isP256(publicKey.getParams()) || !"X.509".equals(publicKey.getFormat())) {
            throw new IdentityUnavailableException("Pairing public key is invalid; re-pair required");
        }
        return publicKey;
    }

    private void generateKey(String alias) throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER);
        generator.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .build());
        generator.generateKeyPair();
    }

    private boolean isP256(ECParameterSpec actual) throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec expected = parameters.getParameterSpec(ECParameterSpec.class);
        return actual.getCurve().equals(expected.getCurve())
            && actual.getGenerator().equals(expected.getGenerator())
            && actual.getOrder().equals(expected.getOrder())
            && actual.getCofactor() == expected.getCofactor();
    }

    private KeyStore openStore() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance(PROVIDER);
        store.load(null);
        return store;
    }

    /** Immutable public identity only. DER bytes are copied on construction and access. */
    public static final class PublicIdentity {
        public final String keyAlias;
        private final byte[] spkiDer;

        private PublicIdentity(String keyAlias, byte[] spkiDer) {
            this.keyAlias = keyAlias;
            this.spkiDer = spkiDer.clone();
        }

        public byte[] spkiDer() { return spkiDer.clone(); }

        public String spkiBase64Url() {
            return Base64.encodeToString(spkiDer, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        }
    }

    /** Retains the public alias so the enrollment owner can retry a failed cleanup explicitly. */
    public static final class CreationException extends GeneralSecurityException {
        public final String keyAlias;

        private CreationException(String keyAlias, Throwable cause) {
            super("Phone identity creation failed", cause);
            this.keyAlias = keyAlias;
        }
    }

    public static final class IdentityUnavailableException extends GeneralSecurityException {
        public IdentityUnavailableException(String message) { super(message); }
    }
}
