package io.harnessy.companion;

import io.harnessy.companion.CompanionPlatform.Fence;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Controller-owned RAM only: chat-local drafts and retained public uncertainty identities, never retry payloads. */
final class ConversationMemory {
    private final int maxDrafts;
    private final Map<String, String> drafts = new LinkedHashMap<>();
    private final Map<String, Fence> fences = new LinkedHashMap<>();

    ConversationMemory(int maxDrafts) { this.maxDrafts = maxDrafts; }

    private static String key(String pcId, String sessionId) {
        return (pcId == null ? "" : pcId) + '\0' + (sessionId == null ? "" : sessionId);
    }

    String draft(String pcId, String sessionId) { return drafts.getOrDefault(key(pcId, sessionId), ""); }

    boolean setDraft(String pcId, String sessionId, String text) {
        String target = key(pcId, sessionId);
        if (text.isEmpty()) { drafts.remove(target); return true; }
        if (!drafts.containsKey(target) && drafts.size() >= maxDrafts) return false;
        drafts.put(target, text);
        return true;
    }

    void clearSubmittedDraft(String pcId, String sessionId, String expected) {
        String target = key(pcId, sessionId);
        if (expected.equals(drafts.get(target))) drafts.remove(target);
    }

    void restoreFences(List<Fence> stored) {
        // A failed durable write may have left a stricter uncertainty in RAM; reads cannot clear it.
        for (Fence fence : stored) fences.putIfAbsent(fence.targetKey(), fence);
    }

    void rememberFence(Fence fence) { fences.putIfAbsent(fence.targetKey(), fence); }
    Fence fence(String pcId, String sessionId) { return fences.get(key(pcId, sessionId)); }

    Fence firstFence(String pcId) {
        for (Fence fence : fences.values()) if (pcId == null || pcId.equals(fence.pcId)) return fence;
        return null;
    }

    void clearFence(Fence expected) {
        Fence current = fences.get(expected.targetKey());
        if (current != null && expected.sameIdentity(current)) fences.remove(expected.targetKey());
    }
}
