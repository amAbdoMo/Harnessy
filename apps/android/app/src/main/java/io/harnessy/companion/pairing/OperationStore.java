package io.harnessy.companion.pairing;

import android.content.Context;
import android.content.SharedPreferences;
import io.harnessy.companion.CompanionPlatform.Fence;
import io.harnessy.companion.CompanionPlatform.Repair;
import io.harnessy.companion.identity.PhoneIdentity;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Serialized IO-only minimal uncertainty and repair markers. No content, keys, invitation or retry payload. */
public final class OperationStore {
    private static final int MAX_PCS = 32;
    private static final int MAX_BYTES = 32768;
    private final SharedPreferences preferences;

    public OperationStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences("harnessy_companion_operation_fences", Context.MODE_PRIVATE);
    }

    public List<Fence> fences() throws IOException { return new ArrayList<>(read().fences.values()); }
    public List<Repair> repairs() throws IOException { return new ArrayList<>(read().repairs.values()); }
    public void putFence(Fence fence) throws IOException {
        Document next = read(); next.fences.put(fence.pcId, fence); commit(next);
    }
    public void clearFence(String pcId) throws IOException {
        Document next = read(); next.fences.remove(pcId); commit(next);
    }
    public void repair(String pcId, String alias) throws IOException {
        PhoneIdentity.requireAlias(alias);
        Document next = read(); next.repairs.put(Protocol.parsePcId(pcId), new Repair(pcId, alias)); commit(next);
    }
    public void clearRepair(String pcId) throws IOException {
        Document next = read(); next.repairs.remove(pcId); commit(next);
    }

    private Document read() throws IOException {
        Map<String, ?> stored = preferences.getAll();
        Document decoded = new Document();
        if (stored.isEmpty()) return decoded;
        try {
            if (stored.size() != 1 || !(stored.get("document") instanceof String)) throw new IllegalArgumentException("Invalid fence preferences");
            Map<String, Object> wire = Protocol.exactRecord(StrictJson.parse((String) stored.get("document"), MAX_BYTES),
                "v", "fences", "repairs");
            Protocol.version(wire);
            for (Object entry : list(wire.get("fences"))) {
                Map<String, Object> row = Protocol.exactRecord(entry, "pcId", "sessionId", "submissionId");
                Fence fence = new Fence(Protocol.string(row.get("pcId")), Protocol.string(row.get("sessionId")),
                    Protocol.string(row.get("submissionId")));
                if (decoded.fences.put(fence.pcId, fence) != null) throw new IllegalArgumentException("Duplicate PC fence");
            }
            for (Object entry : list(wire.get("repairs"))) {
                Map<String, Object> row = Protocol.exactRecord(entry, "pcId", "alias");
                String alias = Protocol.string(row.get("alias"));
                PhoneIdentity.requireAlias(alias);
                Repair repair = new Repair(Protocol.string(row.get("pcId")), alias);
                if (decoded.repairs.put(repair.pcId, repair) != null) throw new IllegalArgumentException("Duplicate PC repair");
            }
            return decoded;
        } catch (IllegalArgumentException invalidPreferences) {
            throw new IOException("Uncertainty storage invalid; explicit repair required", invalidPreferences);
        }
    }

    private static List<?> list(Object entries) {
        if (!(entries instanceof List) || ((List<?>) entries).size() > MAX_PCS) throw new IllegalArgumentException("Invalid fence list");
        return (List<?>) entries;
    }

    private void commit(Document next) throws IOException {
        if (next.fences.size() > MAX_PCS || next.repairs.size() > MAX_PCS) throw new IOException("Too many operation fences");
        List<Object> fences = new ArrayList<>();
        for (Fence fence : next.fences.values()) fences.add(Protocol.object("pcId", fence.pcId,
            "sessionId", fence.sessionId, "submissionId", fence.submissionId));
        List<Object> repairs = new ArrayList<>();
        for (Repair repair : next.repairs.values()) repairs.add(Protocol.object("pcId", repair.pcId, "alias", repair.alias));
        String document = StrictJson.stringify(Protocol.object("v", 1, "fences", fences, "repairs", repairs), MAX_BYTES);
        if (!preferences.edit().putString("document", document).commit()) {
            throw new IOException("Operation fence durability unknown; do not send or delete identity");
        }
    }

    private static final class Document {
        final Map<String, Fence> fences = new LinkedHashMap<>();
        final Map<String, Repair> repairs = new LinkedHashMap<>();
    }
}
