package io.harnessy.companion.pairing;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** App-private public metadata only. Use one serialized operation owner off the UI thread; no cache. */
public final class PairingStore {
    private static final String PREFERENCES = "harnessy_companion_public_pairings";
    private static final String DOCUMENT = "document";
    private static final int VERSION = 1;
    private static final int MAX_PAIRINGS = 32;
    private static final int MAX_DOCUMENT_CHARACTERS = 524288;
    private final SharedPreferences preferences;

    public PairingStore(Context context) {
        this(context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE));
    }

    PairingStore(SharedPreferences preferences) { this.preferences = preferences; }

    /** Primary PC first; empty means no stored document. Invalid/unsupported documents are never reset. */
    public List<PairingMetadata> list() throws StorageException {
        Map<String, ?> stored = preferences.getAll();
        if (stored.isEmpty()) return Collections.emptyList();
        if (stored.size() != 1 || !(stored.get(DOCUMENT) instanceof String)) {
            throw new InvalidMetadataException("Unexpected pairing preferences");
        }
        try {
            return decode((String) stored.get(DOCUMENT));
        } catch (JSONException | IllegalArgumentException invalidDocument) {
            throw new InvalidMetadataException("Invalid pairing document; explicit re-pair required", invalidDocument);
        }
    }

    /** Saves the explicitly enrolled PC as primary, retaining other PCs; no invitation text or session content. */
    public void save(PairingMetadata pairing) throws StorageException {
        List<PairingMetadata> next = new ArrayList<>(list());
        next.removeIf(previous -> previous.pc.id.equals(pairing.pc.id));
        next.add(0, pairing);
        write(next);
    }

    /** Metadata removal only; the owner must also fence this PC and remove its exact phone key alias. */
    public void remove(String pcId) throws StorageException {
        List<PairingMetadata> next = new ArrayList<>(list());
        next.removeIf(pairing -> pairing.pc.id.equals(pcId));
        write(next);
    }

    private List<PairingMetadata> decode(String raw) throws JSONException {
        JSONObject document = metadataDocument(raw);
        JSONArray records = requiredArray(document, "pcs");
        if (records.length() > MAX_PAIRINGS) throw new JSONException("Too many pairings");
        List<PairingMetadata> pairings = new ArrayList<>(records.length());
        for (int index = 0; index < records.length(); index++) pairings.add(decodeRecord(records.get(index)));
        requireUnique(pairings);
        return Collections.unmodifiableList(pairings);
    }

    private JSONObject metadataDocument(String raw) throws JSONException {
        if (raw.length() > MAX_DOCUMENT_CHARACTERS) throw new JSONException("Pairing document too large");
        JSONTokener parser = new JSONTokener(raw);
        Object parsed = parser.nextValue();
        if (!(parsed instanceof JSONObject) || parser.nextClean() != 0) {
            throw new JSONException("Expected one pairing JSON object");
        }
        JSONObject document = (JSONObject) parsed;
        requireKeys(document, "version", "pcs");
        Object version = document.get("version");
        if (!(version instanceof Integer) || ((Integer) version) != VERSION) {
            throw new JSONException("Unsupported pairing metadata version");
        }
        return document;
    }

    private PairingMetadata decodeRecord(Object parsed) throws JSONException {
        if (!(parsed instanceof JSONObject)) throw new JSONException("Expected public pairing object");
        JSONObject record = (JSONObject) parsed;
        requireKeys(record, "pcId", "publicKeySpki", "displayName", "grantId", "grantGeneration", "origin", "keyAlias");
        PairingMetadata.PcIdentity pc = new PairingMetadata.PcIdentity(
            requiredString(record, "pcId"), requiredString(record, "publicKeySpki"), requiredString(record, "displayName"));
        PairingMetadata.Grant grant = new PairingMetadata.Grant(
            requiredString(record, "grantId"), requiredString(record, "grantGeneration"));
        String origin = requiredString(record, "origin");
        if (!HttpsOrigin.canonical(origin).equals(origin)) throw new JSONException("Noncanonical saved origin");
        return new PairingMetadata(pc, grant, origin, requiredString(record, "keyAlias"));
    }

    private void write(List<PairingMetadata> pairings) throws StorageException {
        if (pairings.size() > MAX_PAIRINGS) throw new StorageException("Too many pairings");
        final String encoded;
        try {
            requireUnique(pairings);
            JSONArray records = new JSONArray();
            for (PairingMetadata pairing : pairings) records.put(encodeRecord(pairing));
            encoded = new JSONObject().put("version", VERSION).put("pcs", records).toString();
        } catch (JSONException invalidMetadata) {
            throw new StorageException("Cannot encode public pairing metadata", invalidMetadata);
        }
        if (encoded.length() > MAX_DOCUMENT_CHARACTERS) throw new StorageException("Pairing document too large");
        if (!preferences.edit().putString(DOCUMENT, encoded).commit()) {
            throw new StorageException("Pairing write durability unknown; keep mutation fenced");
        }
    }

    private JSONObject encodeRecord(PairingMetadata pairing) throws JSONException {
        return new JSONObject()
            .put("pcId", pairing.pc.id)
            .put("publicKeySpki", pairing.pc.publicKeySpkiBase64Url)
            .put("displayName", pairing.pc.displayName)
            .put("grantId", pairing.grant.id)
            .put("grantGeneration", pairing.grant.generation)
            .put("origin", pairing.origin)
            .put("keyAlias", pairing.phoneKeyAlias);
    }

    private void requireUnique(List<PairingMetadata> pairings) throws JSONException {
        Set<String> pcIds = new HashSet<>();
        Set<String> aliases = new HashSet<>();
        for (PairingMetadata pairing : pairings) {
            if (!pcIds.add(pairing.pc.id) || !aliases.add(pairing.phoneKeyAlias)) {
                throw new JSONException("Duplicate PC or phone identity alias");
            }
        }
    }

    private static String requiredString(JSONObject record, String key) throws JSONException {
        Object text = record.get(key);
        if (!(text instanceof String)) throw new JSONException("Expected string in " + key);
        return (String) text;
    }

    private static JSONArray requiredArray(JSONObject document, String key) throws JSONException {
        Object records = document.get(key);
        if (!(records instanceof JSONArray)) throw new JSONException("Expected array in " + key);
        return (JSONArray) records;
    }

    private static void requireKeys(JSONObject record, String... keys) throws JSONException {
        if (record.length() != keys.length) throw new JSONException("Unexpected public metadata fields");
        for (String key : keys) {
            if (!record.has(key)) throw new JSONException("Missing public metadata field " + key);
        }
    }

    /** Failure is not a successful enrollment/removal, including uncertain SharedPreferences durability. */
    public static class StorageException extends IOException {
        public StorageException(String message) { super(message); }
        public StorageException(String message, Throwable cause) { super(message, cause); }
    }

    public static final class InvalidMetadataException extends StorageException {
        public InvalidMetadataException(String message) { super(message); }
        public InvalidMetadataException(String message, Throwable cause) { super(message, cause); }
    }
}
