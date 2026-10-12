package io.harnessy.companion.transport;

/** Shared complete-wire-byte admission for the mailbox, executing operations and callback backlog. */
final class RetentionBudget {
    private final int maximumFrames;
    private final long maximumBytes;
    private int frames;
    private long bytes;

    RetentionBudget(TransportLimits.Frames limits) {
        maximumFrames = limits.maxRetainedFrames;
        maximumBytes = limits.maxRetainedBytes;
    }

    synchronized Lease reserve(long requestedBytes) {
        if (requestedBytes < 0 || frames >= maximumFrames || requestedBytes > maximumBytes - bytes) return null;
        frames++;
        bytes += requestedBytes;
        return new Lease(requestedBytes);
    }

    final class Lease implements AutoCloseable {
        private final long retainedBytes;
        private boolean released;

        private Lease(long retainedBytes) { this.retainedBytes = retainedBytes; }

        public void close() {
            synchronized (RetentionBudget.this) {
                if (released) return;
                released = true;
                frames--;
                bytes -= retainedBytes;
            }
        }
    }
}
