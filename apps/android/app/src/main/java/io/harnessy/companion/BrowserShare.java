package io.harnessy.companion;

/**
 * Main-thread projection of one phone browser-share viewer. JPEG data is retained only while the
 * viewer is visible; leaving the screen clears it before the encrypted link is retired.
 */
public final class BrowserShare {
    /** Viewer status projected from one correlated browser-share response. */
    public enum Status { IDLE, BUSY, FRAME, ENDED, STOPPING, ERROR }

    /** Current viewer status. */
    public final Status status;
    /** Exact PC-minted share UUID, when one is known. */
    public final String shareId;
    /** Canonical standard-Base64 JPEG, retained only while a visible frame is current. */
    public final String jpeg;
    /** True only when an admitted stop did not receive an ended acknowledgement. */
    public final boolean stopFailed;

    public BrowserShare(Status status, String shareId, String jpeg) {
        this(status, shareId, jpeg, false);
    }

    public BrowserShare(Status status, String shareId, String jpeg, boolean stopFailed) {
        this.status = java.util.Objects.requireNonNull(status);
        this.shareId = shareId;
        this.jpeg = jpeg;
        this.stopFailed = stopFailed;
        if (status == Status.FRAME) {
            if (shareId == null || jpeg == null) throw new IllegalArgumentException("Frame requires share identity and JPEG");
        } else if (jpeg != null && (status != Status.BUSY && status != Status.STOPPING || shareId == null)) {
            throw new IllegalArgumentException("Non-frame browser share cannot retain JPEG data");
        }
        if (stopFailed && status != Status.ERROR) throw new IllegalArgumentException("Only an error can mark stop failure");
    }

    public static BrowserShare idle() { return new BrowserShare(Status.IDLE, null, null); }
}
