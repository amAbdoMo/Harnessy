package io.harnessy.companion.pairing;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;
import io.harnessy.companion.CompanionPlatform.Fence;
import io.harnessy.companion.CompanionPlatform.OperationKind;
import io.harnessy.companion.CompanionPlatform.Repair;
import io.harnessy.companion.protocol.Protocol;
import io.harnessy.companion.protocol.StrictJson;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.Test;

/** Exercises the real document parser and mutations with preference durability controlled at the IO boundary. */
public final class OperationStoreTest {
    private static final int MAX_BYTES = 32768;
    private static final String PC_A = id(32, 1);
    private static final String PC_B = id(32, 2);
    private static final String PC_C = id(32, 3);
    private static final String OP_A = id(16, 1);
    private static final String OP_B = id(16, 2);
    private static final String ALIAS_A = "harnessy.companion.pairing.00000000-0000-0000-0000-000000000001";
    private static final String ALIAS_B = "harnessy.companion.pairing.00000000-0000-0000-0000-000000000002";
    private static final Fence LEGACY_A = new Fence(PC_A, "s1", OP_A);
    private static final Fence LEGACY_B = new Fence(PC_B, "s2", OP_B);

    @Test public void legacyReadsKeepOriginalDocumentAndDecodeSubmitTextOnlyInMemory() throws Exception {
        Preferences preferences = new Preferences(legacyDocument());
        OperationStore store = new OperationStore(preferences);
        assertFences(Arrays.asList(LEGACY_A, LEGACY_B), store.fences());
        assertRepairs(store, true, true);
        assertEquals(OperationKind.SUBMIT_TEXT, store.fences().get(0).kind);
        assertEquals(OP_A, store.fences().get(0).operationId);
        assertEquals(OP_A, store.fences().get(0).submissionId);
        assertEquals(Collections.singletonMap("document", legacyDocument()), preferences.getAll());
        assertEquals(preferences.disk, preferences.getAll());
        assertEquals(0, preferences.commits);
    }

    @Test public void typedV2ReadsPreserveTheDocumentUntilAnExplicitChange() throws Exception {
        String original = document(2, Collections.singletonList(typedRow(OperationKind.SELECT_SESSION_MODEL, "s1")));
        Preferences preferences = new Preferences(original);
        OperationStore store = new OperationStore(preferences);
        assertEquals(OperationKind.SELECT_SESSION_MODEL, store.fences().get(0).kind);
        assertRepairs(store, true, true);
        assertEquals(original, preferences.getAll().get("document"));
        assertEquals(0, preferences.commits);
    }

    @Test public void independentChatsOnTheSamePcRetainTheirOwnFencesAcrossRestartAndExactClear() throws Exception {
        Preferences preferences = new Preferences(legacyDocument());
        OperationStore store = new OperationStore(preferences);
        Fence otherChat = new Fence(PC_A, "another-chat", OP_B, OperationKind.OPEN_SESSION);
        store.putFence(otherChat);
        assertV3(preferences);
        store = new OperationStore(preferences.restart());
        assertFences(Arrays.asList(LEGACY_A, LEGACY_B, otherChat), store.fences());
        store.clearFence(LEGACY_A);
        assertFences(Arrays.asList(LEGACY_B, otherChat), store.fences());
        assertRepairs(store, true, true);
        store.clearFence(otherChat);
        assertFences(Collections.singletonList(LEGACY_B), store.fences());
    }

    private enum Mutation { PUT_FENCE, CLEAR_FENCE, REPAIR, CLEAR_REPAIR }

    @Test public void everyMutationMigratesAllRemainingLegacyFencesAndRepairsUnderTheSameKey() throws Exception {
        for (Mutation mutation : Mutation.values()) {
            Preferences preferences = new Preferences(legacyDocument());
            OperationStore store = new OperationStore(preferences);
            Fence added = new Fence(PC_C, "s3", OP_A, OperationKind.RENAME_SESSION);
            List<Fence> expected = new ArrayList<>(Arrays.asList(LEGACY_A, LEGACY_B));
            switch (mutation) {
                case PUT_FENCE: store.putFence(added); expected.add(added); break;
                case CLEAR_FENCE: store.clearFence(new Fence(PC_A, "s1", OP_A)); expected.remove(0); break;
                case REPAIR: store.repair(PC_C, ALIAS_A); break;
                case CLEAR_REPAIR: store.clearRepair(PC_A); break;
                default: throw new AssertionError(mutation);
            }
            assertV3(preferences);
            OperationStore restarted = new OperationStore(preferences.restart());
            assertFences(expected, restarted.fences());
            assertRepairs(restarted, mutation != Mutation.CLEAR_REPAIR, true);
            assertEquals(mutation == Mutation.REPAIR ? 3 : mutation == Mutation.CLEAR_REPAIR ? 1 : 2,
                restarted.repairs().size());
            assertEquals(1, preferences.commits);
        }
    }

    @Test public void typedKindsRoundTripWithoutPersistingLegacyIdsOrPayloads() throws Exception {
        Preferences preferences = new Preferences(null);
        OperationStore store = new OperationStore(preferences);
        List<Fence> expected = new ArrayList<>();
        int pc = 1;
        for (OperationKind kind : OperationKind.values()) {
            String sessionId = kind == OperationKind.CREATE_SESSION ? "mobile-" + OP_A : "s" + pc;
            Fence fence = new Fence(id(32, pc++), sessionId, OP_A, kind);
            expected.add(fence); store.putFence(fence);
        }
        store.repair(PC_A, ALIAS_A);
        assertV3(preferences);
        assertFences(expected, new OperationStore(preferences.restart()).fences());
        List<String> names = new ArrayList<>();
        for (Object entry : (List<?>) parsedDocument(preferences).get("fences")) {
            names.add(Protocol.string(Protocol.record(entry).get("kind")));
        }
        assertEquals(Arrays.asList("submitText", "createSession", "renameSession", "archiveSession", "setSessionPinned", "selectSessionModel", "openSession"), names);
        assertEquals(ALIAS_A, new OperationStore(preferences.restart()).repairs().get(0).alias);
    }

    @Test public void exactClearPreservesOtherSlotsAndRefusesDifferentOperationsInTheSameChat() throws Exception {
        Preferences preferences = new Preferences(legacyDocument());
        OperationStore store = new OperationStore(preferences);
        assertThrows(IOException.class, () -> store.clearFence(new Fence(PC_A, "s1", OP_B)));
        assertEquals(Collections.singletonMap("document", legacyDocument()), preferences.getAll());
        assertEquals(0, preferences.commits);
        Fence current = new Fence(PC_A, "s1", OP_A, OperationKind.SUBMIT_TEXT);
        store.putFence(current);
        Map<String, ?> before = preferences.getAll();
        int commits = preferences.commits;
        List<Fence> stale = Arrays.asList(
            new Fence(PC_A, "s1", OP_B, current.kind),
            new Fence(PC_A, "s1", OP_A, OperationKind.ARCHIVE_SESSION));
        for (Fence expected : stale) {
            assertThrows(IOException.class, () -> store.clearFence(expected));
            assertEquals(before, preferences.getAll());
            assertEquals(commits, preferences.commits);
            assertFences(Arrays.asList(current, LEGACY_B), store.fences());
            assertRepairs(store, true, true);
        }
        for (Fence absentTarget : Arrays.asList(new Fence(PC_B, "s1", OP_A, current.kind),
            new Fence(PC_A, "different", OP_A, current.kind))) {
            store.clearFence(absentTarget);
            assertFences(Arrays.asList(current, LEGACY_B), store.fences());
            assertRepairs(store, true, true);
        }
        store.clearFence(new Fence(PC_A, "s1", OP_A, current.kind));
        assertFences(Collections.singletonList(LEGACY_B), store.fences());
        assertRepairs(store, true, true);
        Map<String, ?> cleared = preferences.getAll();
        store.clearFence(current);
        assertEquals(cleared, preferences.getAll());
        assertEquals(commits + 4, preferences.commits);
    }

    @Test public void anotherOperationCannotReplaceAnUnresolvedFence() throws Exception {
        Preferences preferences = new Preferences(legacyDocument());
        OperationStore store = new OperationStore(preferences);
        for (Fence replacement : Arrays.asList(new Fence(PC_A, "s1", OP_B),
            new Fence(PC_A, "s1", OP_A, OperationKind.RENAME_SESSION))) {
            assertThrows(IOException.class, () -> store.putFence(replacement));
            assertEquals(legacyDocument(), preferences.getAll().get("document"));
            assertEquals(0, preferences.commits);
            assertFences(Arrays.asList(LEGACY_A, LEGACY_B), store.fences());
        }
    }

    private enum CommitOutcome { SUCCESS, FAIL_BEFORE_MEMORY, FAIL_AFTER_MEMORY, FAIL_AFTER_DISK }

    @Test public void interruptedMigrationReportsUncertaintyAndRetainsEveryUnrelatedMarker() throws Exception {
        for (CommitOutcome outcome : CommitOutcome.values()) {
            if (outcome == CommitOutcome.SUCCESS) continue;
            Preferences preferences = new Preferences(legacyDocument());
            OperationStore store = new OperationStore(preferences);
            Fence added = new Fence(PC_C, "s3", OP_A, OperationKind.SET_SESSION_PINNED);
            preferences.nextOutcome = outcome;
            assertThrows(IOException.class, () -> store.putFence(added));
            assertFences(outcome == CommitOutcome.FAIL_BEFORE_MEMORY ? Arrays.asList(LEGACY_A, LEGACY_B)
                : Arrays.asList(LEGACY_A, LEGACY_B, added), store.fences());
            assertRepairs(store, true, true);
            Preferences disk = preferences.restart();
            OperationStore restarted = new OperationStore(disk);
            assertFences(outcome == CommitOutcome.FAIL_AFTER_DISK ? Arrays.asList(LEGACY_A, LEGACY_B, added)
                : Arrays.asList(LEGACY_A, LEGACY_B), restarted.fences());
            assertRepairs(restarted, true, true);
            assertEquals(Collections.singleton("document"), disk.getAll().keySet());
            if (outcome != CommitOutcome.FAIL_AFTER_DISK) assertEquals(legacyDocument(), disk.getAll().get("document"));
            restarted.repair(PC_C, ALIAS_A);
            assertV3(disk);
            assertFences(outcome == CommitOutcome.FAIL_AFTER_DISK ? Arrays.asList(LEGACY_A, LEGACY_B, added)
                : Arrays.asList(LEGACY_A, LEGACY_B), restarted.fences());
            assertRepairs(restarted, true, true);
        }
    }

    @Test public void uncertainClearNeverClaimsRollbackAndPreservesOtherFencesAndRepairs() throws Exception {
        for (CommitOutcome outcome : CommitOutcome.values()) {
            if (outcome == CommitOutcome.SUCCESS) continue;
            Preferences preferences = new Preferences(legacyDocument());
            OperationStore store = new OperationStore(preferences);
            preferences.nextOutcome = outcome;
            assertThrows(IOException.class, () -> store.clearFence(LEGACY_A));
            assertFences(outcome == CommitOutcome.FAIL_BEFORE_MEMORY ? Arrays.asList(LEGACY_A, LEGACY_B)
                : Collections.singletonList(LEGACY_B), store.fences());
            assertRepairs(store, true, true);
            OperationStore restarted = new OperationStore(preferences.restart());
            assertFences(outcome == CommitOutcome.FAIL_AFTER_DISK ? Collections.singletonList(LEGACY_B)
                : Arrays.asList(LEGACY_A, LEGACY_B), restarted.fences());
            assertRepairs(restarted, true, true);
            assertEquals(1, preferences.commits);
            store.clearFence(LEGACY_A);
            assertFences(Collections.singletonList(LEGACY_B), new OperationStore(preferences.restart()).fences());
            assertRepairs(store, true, true);
            assertEquals(2, preferences.commits);
        }
    }

    @Test public void malformedOrUnknownDocumentsFailClosedWithoutRepairOrRewrite() throws Exception {
        Map<String, Object> valid = typedRow(OperationKind.RENAME_SESSION, "s1");
        Map<String, Object> unknownKind = new LinkedHashMap<>(valid); unknownKind.put("kind", "deleteSession");
        Map<String, Object> payload = new LinkedHashMap<>(valid); payload.put("text", "must not persist");
        Map<String, Object> missingKind = new LinkedHashMap<>(valid); missingKind.remove("kind");
        List<String> invalid = Arrays.asList(
            document(4, Collections.singletonList(valid)),
            document(2, Arrays.asList(valid, typedRow(OperationKind.RENAME_SESSION, "other-chat"))),
            document(2, Collections.singletonList(typedRow(OperationKind.OPEN_SESSION, "s1"))),
            document(3, Arrays.asList(valid, valid)),
            document(2, Collections.singletonList(unknownKind)),
            document(2, Collections.singletonList(payload)),
            document(2, Collections.singletonList(missingKind)),
            document(2, Collections.singletonList(legacyRow(LEGACY_A))),
            document(1, Collections.singletonList(valid)),
            document(2, Collections.singletonList(typedRow(OperationKind.CREATE_SESSION, "not-mobile"))),
            document(2, Arrays.asList(valid, valid)));
        for (String original : invalid) {
            Preferences preferences = new Preferences(original);
            OperationStore store = new OperationStore(preferences);
            assertThrows(IOException.class, store::fences);
            assertThrows(IOException.class, store::repairs);
            assertThrows(IOException.class, () -> store.putFence(LEGACY_B));
            assertThrows(IOException.class, () -> store.clearFence(LEGACY_A));
            assertThrows(IOException.class, () -> store.repair(PC_C, ALIAS_A));
            assertThrows(IOException.class, () -> store.clearRepair(PC_A));
            assertEquals(Collections.singletonMap("document", original), preferences.getAll());
            assertEquals(preferences.disk, preferences.getAll());
            assertEquals(0, preferences.commits);
        }
        assertThrows(IllegalArgumentException.class,
            () -> new Fence(PC_A, "mobile-" + OP_B, OP_A, OperationKind.CREATE_SESSION));
    }

    private static String id(int bytes, int marker) {
        byte[] encoded = new byte[bytes]; encoded[bytes - 1] = (byte) marker;
        return Protocol.encodeBase64Url(encoded);
    }

    private static Map<String, Object> legacyRow(Fence fence) {
        return Protocol.object("pcId", fence.pcId, "sessionId", fence.sessionId, "submissionId", fence.submissionId);
    }

    private static Map<String, Object> typedRow(OperationKind kind, String sessionId) {
        return Protocol.object("kind", kind.wireName, "pcId", PC_A, "sessionId", sessionId, "operationId", OP_A);
    }

    private static String legacyDocument() {
        return document(1, Arrays.asList(legacyRow(LEGACY_A), legacyRow(LEGACY_B)));
    }

    private static String document(int version, List<?> fences) {
        return StrictJson.stringify(Protocol.object("v", version, "fences", fences, "repairs", Arrays.asList(
            Protocol.object("pcId", PC_A, "alias", ALIAS_A), Protocol.object("pcId", PC_B, "alias", ALIAS_B))), MAX_BYTES);
    }

    private static Map<String, Object> parsedDocument(Preferences preferences) {
        return Protocol.exactRecord(StrictJson.parse((String) preferences.getAll().get("document"), MAX_BYTES),
            "v", "fences", "repairs");
    }

    private static void assertV3(Preferences preferences) {
        assertEquals(Collections.singleton("document"), preferences.getAll().keySet());
        Map<String, Object> document = parsedDocument(preferences);
        assertEquals(3, Protocol.integer(document.get("v"), 3, 3));
        for (Object entry : (List<?>) document.get("fences")) {
            Protocol.exactRecord(entry, "kind", "pcId", "sessionId", "operationId");
        }
        assertEquals(preferences.disk, preferences.getAll());
    }

    private static void assertFences(List<Fence> expected, List<Fence> actual) {
        assertEquals(expected.size(), actual.size());
        for (int index = 0; index < expected.size(); index++) {
            assertTrue(expected.get(index).sameIdentity(actual.get(index)));
            assertEquals(actual.get(index).operationId, actual.get(index).submissionId);
        }
    }

    private static void assertRepairs(OperationStore store, boolean hasA, boolean hasB) throws IOException {
        Map<String, String> aliases = new LinkedHashMap<>();
        for (Repair repair : store.repairs()) aliases.put(repair.pcId, repair.alias);
        if (hasA) assertEquals(ALIAS_A, aliases.get(PC_A)); else assertFalse(aliases.containsKey(PC_A));
        if (hasB) assertEquals(ALIAS_B, aliases.get(PC_B)); else assertFalse(aliases.containsKey(PC_B));
    }

    /** A failed Android commit can leave changed memory, with either old or new disk contents. */
    private static final class Preferences implements SharedPreferences {
        private final Map<String, Object> memory = new LinkedHashMap<>();
        private final Map<String, Object> disk = new LinkedHashMap<>();
        private CommitOutcome nextOutcome = CommitOutcome.SUCCESS;
        private int commits;

        Preferences(String document) {
            if (document != null) { memory.put("document", document); disk.put("document", document); }
        }
        Preferences restart() { return new Preferences((String) disk.get("document")); }
        @Override public Map<String, ?> getAll() { return new LinkedHashMap<>(memory); }
        @Override public boolean contains(String key) { return memory.containsKey(key); }
        @Override public String getString(String key, String fallback) { return (String) memory.getOrDefault(key, fallback); }
        @Override public Set<String> getStringSet(String key, Set<String> fallback) { throw new AssertionError("Unexpected set read"); }
        @Override public int getInt(String key, int fallback) { throw new AssertionError("Unexpected int read"); }
        @Override public long getLong(String key, long fallback) { throw new AssertionError("Unexpected long read"); }
        @Override public float getFloat(String key, float fallback) { throw new AssertionError("Unexpected float read"); }
        @Override public boolean getBoolean(String key, boolean fallback) { throw new AssertionError("Unexpected boolean read"); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {
            throw new AssertionError("Unexpected listener");
        }
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {
            throw new AssertionError("Unexpected listener");
        }
        @Override public Editor edit() {
            return new Editor() {
                private final Map<String, Object> pending = new LinkedHashMap<>();
                @Override public Editor putString(String key, String text) { pending.put(key, text); return this; }
                @Override public Editor putStringSet(String key, Set<String> entries) { throw new AssertionError("Unexpected set write"); }
                @Override public Editor putInt(String key, int number) { throw new AssertionError("Unexpected int write"); }
                @Override public Editor putLong(String key, long number) { throw new AssertionError("Unexpected long write"); }
                @Override public Editor putFloat(String key, float number) { throw new AssertionError("Unexpected float write"); }
                @Override public Editor putBoolean(String key, boolean flag) { throw new AssertionError("Unexpected boolean write"); }
                @Override public Editor remove(String key) { throw new AssertionError("Unexpected preference removal"); }
                @Override public Editor clear() { throw new AssertionError("Unexpected preference reset"); }
                @Override public void apply() { throw new AssertionError("Durability requires commit"); }
                @Override public boolean commit() {
                    commits++;
                    CommitOutcome outcome = nextOutcome; nextOutcome = CommitOutcome.SUCCESS;
                    if (outcome == CommitOutcome.FAIL_BEFORE_MEMORY) return false;
                    memory.putAll(pending);
                    if (outcome == CommitOutcome.FAIL_AFTER_MEMORY) return false;
                    disk.putAll(pending);
                    return outcome == CommitOutcome.SUCCESS;
                }
            };
        }
    }
}
