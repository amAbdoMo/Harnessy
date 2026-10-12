package io.harnessy.companion.transport;

import io.harnessy.companion.protocol.StrictJson;

/** Immutable caller-selected wire retention and finite deadline budgets; no implicit deployment defaults. */
public final class TransportLimits {
    public final Frames frames;
    public final Deadlines deadlines;

    public TransportLimits(Frames frames, Deadlines deadlines) {
        this.frames = java.util.Objects.requireNonNull(frames);
        this.deadlines = java.util.Objects.requireNonNull(deadlines);
    }

    /** Counts include processing frames and pending callbacks, not just waiting mailbox entries. */
    public static final class Frames {
        public final int maxFrameBytes;
        public final int maxRetainedFrames;
        public final long maxRetainedBytes;
        public final long maxSocketQueueBytes;

        public Frames(int maxFrameBytes, int maxRetainedFrames, long maxRetainedBytes, long maxSocketQueueBytes) {
            if (maxFrameBytes < 1 || maxFrameBytes > StrictJson.MAX_BYTES || maxRetainedFrames < 1
                || maxRetainedBytes < maxFrameBytes || maxSocketQueueBytes < maxFrameBytes
                || maxSocketQueueBytes > 16L * 1024 * 1024) throw new IllegalArgumentException("Invalid frame limits");
            this.maxFrameBytes = maxFrameBytes;
            this.maxRetainedFrames = maxRetainedFrames;
            this.maxRetainedBytes = maxRetainedBytes;
            this.maxSocketQueueBytes = maxSocketQueueBytes;
        }
    }

    public static final class Deadlines {
        public final int connectMs;
        public final int handshakeMs;
        public final int writeMs;
        public final Activity activity;

        public Deadlines(int connectMs, int handshakeMs, int writeMs, Activity activity) {
            this.activity = java.util.Objects.requireNonNull(activity);
            if (connectMs < 1 || handshakeMs < connectMs || writeMs < 1
                || handshakeMs > activity.lifetimeMs || activity.tickMs > Math.min(connectMs, writeMs)) {
                throw new IllegalArgumentException("Invalid phase deadlines");
            }
            this.connectMs = connectMs;
            this.handshakeMs = handshakeMs;
            this.writeMs = writeMs;
        }
    }

    /** Deadline observation can lag by at most tickMs while a timer thread is schedulable. */
    public static final class Activity {
        public final int idleMs;
        public final int lifetimeMs;
        public final int tickMs;

        public Activity(int idleMs, int lifetimeMs, int tickMs) {
            if (idleMs < 1 || lifetimeMs < idleMs || tickMs < 1 || tickMs > idleMs) {
                throw new IllegalArgumentException("Invalid activity deadlines");
            }
            this.idleMs = idleMs;
            this.lifetimeMs = lifetimeMs;
            this.tickMs = tickMs;
        }
    }
}
