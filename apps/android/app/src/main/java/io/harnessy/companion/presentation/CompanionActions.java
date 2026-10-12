package io.harnessy.companion.presentation;

/** Main-thread gestures only. The controller owns admission, outcomes, and foreground lifecycle. */
public interface CompanionActions {
    /** The controller validates the frozen invitation format before enrollment or network admission. */
    void pairFromLink(String link);
    void selectSession(String sessionId);
    void refresh();
    /** The controller rechecks online/selection/busy state; a click is not delivery confirmation. */
    void sendText(String text);
    /** Local removal only. PC-side revocation is a separate action on that PC. */
    void forgetPairing(String pcId);
    void showPairing();
    /** Retain only in the current owner; never persist drafts or invitation text. */
    void draftChanged(String draft);
    void pairingLinkChanged(String link);
    void cancelPairing();
    void loadMoreSessions();
    void loadMoreHistory();
    /** Explicit user review/discard of the uncertainty warning, never a resend. */
    void resolveUnknown();
}
