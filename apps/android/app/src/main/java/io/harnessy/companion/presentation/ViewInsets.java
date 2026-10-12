package io.harnessy.companion.presentation;

import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;

/** Presentation-owned inset listener. Activity still owns resize, window appearance, and lifecycle. */
final class ViewInsets implements AutoCloseable {
    private final View root;
    private final View sessions;
    private final View.OnLayoutChangeListener compactLayout;

    ViewInsets(View root, View sessions) {
        this.root = root;
        this.sessions = sessions;
        root.setOnApplyWindowInsetsListener((view, insets) -> apply(insets));
        compactLayout = (view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (Build.VERSION.SDK_INT < 30 && sessions != null && phoneWidth()) {
                float density = root.getResources().getDisplayMetrics().density;
                sessions.setVisibility((bottom - top) / density < 440 ? View.GONE : View.VISIBLE);
            }
        };
        root.addOnLayoutChangeListener(compactLayout);
    }

    private WindowInsets apply(WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= 30) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
            root.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            if (sessions != null && phoneWidth()) {
                sessions.setVisibility(insets.isVisible(WindowInsets.Type.ime()) ? View.GONE : View.VISIBLE);
            }
        } else {
            root.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
        }
        return insets;
    }

    private boolean phoneWidth() {
        return root.getResources().getConfiguration().screenWidthDp < 600;
    }

    @Override public void close() {
        root.setOnApplyWindowInsetsListener(null);
        root.removeOnLayoutChangeListener(compactLayout);
    }
}
