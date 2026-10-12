package io.harnessy.companion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import io.harnessy.companion.presentation.CompanionActions;
import io.harnessy.companion.presentation.CompanionView;
import io.harnessy.companion.presentation.DisplayModels;
import io.harnessy.companion.presentation.PairingView;

/** Native foreground launcher. Intents import invitations only; no URI is navigated or enrolled automatically. */
public final class MainActivity extends Activity implements CompanionActions, CompanionController.Output {
    private CompanionController controller;
    private CompanionView companion;
    private PairingView pairing;
    private DisplayModels.Screen displayed;
    private AlertDialog confirmation;
    private boolean started;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        Object retained = getLastNonConfigurationInstance();
        controller = retained instanceof CompanionController ? (CompanionController) retained
            : new CompanionController(((CompanionApplication) getApplication()).platform(),
                new ControllerLimits(getResources().getIntArray(R.array.controller_budgets)), getString(R.string.linked_pc));
    }

    @Override protected void onStart() {
        super.onStart();
        started = true;
        controller.attach(this);
        controller.start();
        consumeInvitation(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        consumeInvitation(intent);
    }

    private void consumeInvitation(Intent intent) {
        Uri uri = intent == null ? null : intent.getData();
        String link = uri == null ? null : uri.toString();
        String action = intent == null ? null : intent.getAction();
        // Drop the incoming Intent rather than preserving its URI, extras or ClipData across recreation.
        if (intent != null) { intent.setData(null); intent.setClipData(null); intent.replaceExtras((Bundle) null); }
        setIntent(new Intent(this, MainActivity.class));
        if (!started || uri == null) return;
        if (!Intent.ACTION_VIEW.equals(action) || !"harnessy".equals(uri.getScheme())
            || !"pair".equals(uri.getHost()) || !link.startsWith("harnessy://pair#") || link.length() > 4096) {
            controller.importLink(""); return;
        }
        controller.importLink(link);
    }

    @Override protected void onStop() {
        started = false;
        controller.stop();
        controller.detach();
        closeViews(); dismissConfirmation(); displayed = null;
        setIntent(new Intent(this, MainActivity.class));
        super.onStop();
    }

    @Override public Object onRetainNonConfigurationInstance() { return controller; }

    @Override public void onBackPressed() {
        if (pairing != null) controller.cancelPairing(); else super.onBackPressed();
    }

    public void companion(DisplayModels.Screen screen) {
        if (!started) return;
        displayed = screen;
        if (companion == null) {
            closeViews(); companion = new CompanionView(this, this);
            setContentView(companion.view()); companion.view().requestApplyInsets();
        }
        companion.render(screen);
    }

    public void pairing(DisplayModels.Pairing model) {
        if (!started) return;
        if (pairing == null) {
            closeViews(); pairing = new PairingView(this, this);
            setContentView(pairing.view()); pairing.view().requestApplyInsets();
        }
        pairing.render(model);
    }

    private void closeViews() {
        if (companion != null) companion.close();
        if (pairing != null) pairing.close();
        companion = null; pairing = null;
    }

    public void forgetPairing(String pcId) {
        if (!started || displayed == null || displayed.pc == null || !pcId.equals(displayed.pc.id)) return;
        dismissConfirmation();
        confirmation = new AlertDialog.Builder(this).setTitle(R.string.forget_title)
            .setMessage(getString(R.string.forget_explanation, displayed.pc.displayName))
            .setNegativeButton(R.string.cancel, (dialog, which) -> dialog.dismiss())
            .setPositiveButton(R.string.forget_pairing, (dialog, which) -> {
                if (started) controller.forgetPairing(pcId);
            }).create();
        confirmation.show();
    }

    public void resolveUnknown() {
        if (!started || displayed == null || displayed.composer.review == null) return;
        dismissConfirmation();
        confirmation = new AlertDialog.Builder(this).setTitle(R.string.resolve_title)
            .setMessage(R.string.resolve_explanation)
            .setNegativeButton(R.string.cancel, (dialog, which) -> dialog.dismiss())
            .setPositiveButton(R.string.resolve_confirm, (dialog, which) -> {
                if (started) controller.resolveUnknown();
            }).create();
        confirmation.show();
    }

    private void dismissConfirmation() {
        if (confirmation != null) confirmation.dismiss();
        confirmation = null;
    }

    public void pairFromLink(String link) { controller.pairFromLink(link); }
    public void selectSession(String sessionId) { controller.selectSession(sessionId); }
    public void refresh() { controller.refresh(); }
    public void sendText(String text) { controller.sendText(text); }
    public void showPairing() { controller.showPairing(); }
    public void draftChanged(String draft) { controller.draftChanged(draft); }
    public void pairingLinkChanged(String link) { controller.pairingLinkChanged(link); }
    public void cancelPairing() { controller.cancelPairing(); }
    public void loadMoreSessions() { controller.loadMoreSessions(); }
    public void loadMoreHistory() { controller.loadMoreHistory(); }
}
