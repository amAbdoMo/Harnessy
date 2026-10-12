package io.harnessy.companion;

/** Explicit phone-local budgets. Reconnects are rate-bounded, not limited to a finite total count. */
public final class ControllerLimits {
    public final int reconnectMs;
    public final int readMs;
    public final int heartbeatMs;
    public final int mutationMs;
    public final int pendingReads;
    public final int pageSize;
    public final int sessionWindow;
    public final int textRows;
    public final int textBytes;
    public final int watchMs;

    public ControllerLimits(int[] budgets) {
        if (budgets.length != 10) throw new IllegalArgumentException("Expected ten controller budgets");
        for (int budget : budgets) if (budget < 1) throw new IllegalArgumentException("Nonpositive controller budget");
        reconnectMs = budgets[0]; readMs = budgets[1]; heartbeatMs = budgets[2]; mutationMs = budgets[3];
        pendingReads = budgets[4]; pageSize = budgets[5]; sessionWindow = budgets[6];
        textRows = budgets[7]; textBytes = budgets[8]; watchMs = budgets[9];
        if (pendingReads > 32 || pageSize > 128 || sessionWindow > 512 || textRows > 512
            || textBytes > 1048576 || heartbeatMs < readMs || reconnectMs < 1000 || watchMs < readMs) {
            throw new IllegalArgumentException("Invalid controller budgets");
        }
    }
}
