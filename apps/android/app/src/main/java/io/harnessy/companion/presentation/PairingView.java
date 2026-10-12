package io.harnessy.companion.presentation;

import android.content.Context;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.util.Objects;

import io.harnessy.companion.R;
import io.harnessy.companion.pairing.PairingInput;

import static io.harnessy.companion.presentation.DisplayModels.*;

/** Transient import UI only; no invitation schema, enrollment, or persistent secret storage. */
public final class PairingView implements AutoCloseable {
    private final View root;
    private final EditText link;
    private final Button importLink;
    private final TextView feedback;
    private final ViewInsets insets;
    private final TextWatcher linkWatcher;
    private CompanionActions actions;
    private boolean binding;
    private boolean editing;

    /** All calls and callbacks are UI-thread only; close before leaving or replacing the screen. */
    public PairingView(Context context, CompanionActions actions) {
        this.actions = Objects.requireNonNull(actions);
        root = LayoutInflater.from(context).inflate(R.layout.pairing_screen, null, false);
        root.setSaveFromParentEnabled(false);
        link = root.findViewById(R.id.pairing_link);
        importLink = root.findViewById(R.id.import_pairing);
        feedback = root.findViewById(R.id.pairing_feedback);
        linkWatcher = watchLink();
        link.addTextChangedListener(linkWatcher);
        importLink.setOnClickListener(clicked -> importLink());
        root.findViewById(R.id.cancel_pairing).setOnClickListener(clicked -> actions.cancelPairing());
        insets = new ViewInsets(root, null);
    }

    public View view() { return root; }

    /** The owner retains the input on failure and discards it after successful enrollment. */
    public void render(Pairing pairing) {
        if (actions == null) throw new IllegalStateException("View is closed");
        TextView fingerprint = root.findViewById(R.id.phone_fingerprint);
        fingerprint.setText(pairing.fingerprint);
        fingerprint.setVisibility(pairing.fingerprint.isEmpty() ? View.GONE : View.VISIBLE);
        root.findViewById(R.id.fingerprint_hint).setVisibility(pairing.fingerprint.isEmpty() ? View.GONE : View.VISIBLE);
        editing = pairing.state == PairingState.EDITING;
        link.setEnabled(editing);
        setLink(pairing.link);
        updateImportEnabled();
        int message = editing ? UiText.feedback(pairing.feedback) : R.string.pairing_in_progress;
        feedback.setVisibility(message == 0 ? View.GONE : View.VISIBLE);
        if (message != 0) feedback.setText(message);
    }

    private void importLink() {
        if (!importLink.isEnabled() || actions == null) return;
        final String checked;
        try {
            checked = PairingInput.checkedText(link.getText().toString());
        } catch (IllegalArgumentException invalidInput) {
            feedback.setVisibility(View.VISIBLE);
            feedback.setText(R.string.pairing_invalid);
            return;
        }
        actions.pairFromLink(checked);
    }

    private TextWatcher watchLink() {
        return new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable text) {
                updateImportEnabled();
                if (!binding && actions != null) actions.pairingLinkChanged(text.toString());
            }
        };
    }

    private void setLink(String text) {
        if (link.getText().toString().equals(text)) return;
        binding = true;
        try {
            link.setText(text);
            link.setSelection(text.length());
        } finally {
            binding = false;
        }
    }

    private void updateImportEnabled() {
        importLink.setEnabled(editing && !link.getText().toString().trim().isEmpty());
    }

    /** Drops the invitation and callback references; close is idempotent and terminal. */
    @Override public void close() {
        if (actions == null) return;
        actions = null;
        link.removeTextChangedListener(linkWatcher);
        link.setText("");
        importLink.setEnabled(false);
        importLink.setOnClickListener(null);
        root.findViewById(R.id.cancel_pairing).setOnClickListener(null);
        ((TextView) root.findViewById(R.id.phone_fingerprint)).setText("");
        insets.close();
    }
}
