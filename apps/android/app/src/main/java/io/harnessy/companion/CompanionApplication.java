package io.harnessy.companion;

import android.app.Application;
import io.harnessy.companion.transport.TransportLimits;

/** Shares only the serialized platform IO owner, not Activities, drafts, views, controllers or network links. */
public final class CompanionApplication extends Application {
    private AndroidCompanionPlatform platform;

    public AndroidCompanionPlatform platform() {
        if (platform == null) {
            TransportLimits.Frames frames = new TransportLimits.Frames(integer(R.integer.frame_bytes),
                integer(R.integer.retained_frames), integer(R.integer.retained_bytes), integer(R.integer.socket_queue_bytes));
            TransportLimits.Activity activity = new TransportLimits.Activity(integer(R.integer.idle_ms),
                integer(R.integer.lifetime_ms), integer(R.integer.tick_ms));
            TransportLimits limits = new TransportLimits(frames, new TransportLimits.Deadlines(
                integer(R.integer.connect_ms), integer(R.integer.handshake_ms), integer(R.integer.write_ms), activity));
            platform = new AndroidCompanionPlatform(this, limits, integer(R.integer.io_queue));
        }
        return platform;
    }

    private int integer(int resource) { return getResources().getInteger(resource); }
}
