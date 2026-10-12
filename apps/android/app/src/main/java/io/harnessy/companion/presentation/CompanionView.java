package io.harnessy.companion.presentation;

import android.content.Context;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;

import java.util.Objects;

import io.harnessy.companion.R;

import static io.harnessy.companion.presentation.DisplayModels.*;

/** Native view composition. Construct, render, and close on the UI thread; close is terminal. */
public final class CompanionView implements AutoCloseable {
    private final View root;
    private final EditText draft;
    private final Button send;
    private final ListView sessions;
    private final ListView transcript;
    private final RowsAdapters.Sessions sessionRows = new RowsAdapters.Sessions();
    private final RowsAdapters.Transcript textRows = new RowsAdapters.Transcript();
    private final ViewInsets insets;
    private final TextWatcher draftWatcher;
    private CompanionActions actions;
    private boolean binding;
    private boolean sendAllowed;

    /** Context must belong to the foreground Activity; no application-wide state or subscription. */
    public CompanionView(Context context, CompanionActions actions) {
        this.actions = Objects.requireNonNull(actions);
        root = LayoutInflater.from(context).inflate(R.layout.companion_screen, null, false);
        root.setSaveFromParentEnabled(false);
        draft = root.findViewById(R.id.draft);
        send = root.findViewById(R.id.send);
        sessions = root.findViewById(R.id.sessions);
        transcript = root.findViewById(R.id.transcript);
        sessions.setAdapter(sessionRows);
        transcript.setAdapter(textRows);
        draftWatcher = watchDraft();
        draft.addTextChangedListener(draftWatcher);
        insets = new ViewInsets(root, root.findViewById(R.id.session_pane));
    }

    /** Attach to a foreground Activity; the owner must request insets after attachment. */
    public View view() { return root; }

    /** Replaces display snapshots only; no fetch, delivery acknowledgement, or automatic draft reset. */
    public void render(Screen screen) {
        requireOpen();
        bindPc(screen.pc);
        bindSessions(screen.sessions);
        bindConversation(screen.conversation);
        bindComposer(screen);
    }

    private void bindPc(Pc pc) {
        TextView name = root.findViewById(R.id.pc_name);
        TextView status = root.findViewById(R.id.pc_status);
        name.setText(pc == null ? root.getContext().getString(R.string.no_linked_pc) : pc.displayName);
        status.setText(pc == null ? R.string.offline : UiText.connection(pc.connection));
        Button forget = root.findViewById(R.id.forget_pc);
        forget.setEnabled(pc != null);
        forget.setOnClickListener(pc == null ? null : clicked -> actions.forgetPairing(pc.id));
        root.findViewById(R.id.pair_pc).setOnClickListener(clicked -> actions.showPairing());
        Button refresh = root.findViewById(R.id.refresh);
        refresh.setEnabled(pc != null);
        refresh.setOnClickListener(clicked -> actions.refresh());
    }

    private void bindSessions(SessionPane pane) {
        sessionRows.bind(pane);
        Button more = root.findViewById(R.id.load_sessions);
        more.setVisibility(pane.canLoadMore ? View.VISIBLE : View.GONE);
        more.setOnClickListener(clicked -> actions.loadMoreSessions());
        root.findViewById(R.id.sessions_empty).setVisibility(pane.rows.isEmpty() ? View.VISIBLE : View.GONE);
        sessions.setOnItemClickListener((parent, row, position, id) ->
            actions.selectSession(sessionRows.getItem(position).id));
    }

    private void bindConversation(Conversation conversation) {
        TextView title = root.findViewById(R.id.session_title);
        String nextId = conversation.session == null ? null : conversation.session.id;
        boolean changedSession = !Objects.equals(title.getTag(), nextId);
        title.setTag(nextId);
        title.setText(conversation.session == null
            ? root.getContext().getString(R.string.select_session) : conversation.session.title);
        textRows.bind(conversation.rows);
        Button more = root.findViewById(R.id.load_history);
        more.setVisibility(conversation.canLoadMore ? View.VISIBLE : View.GONE);
        more.setOnClickListener(clicked -> actions.loadMoreHistory());
        root.findViewById(R.id.transcript_empty).setVisibility(conversation.rows.isEmpty() ? View.VISIBLE : View.GONE);
        if (changedSession) transcript.setSelection(0);
    }

    private void bindComposer(Screen screen) {
        Composer composer = screen.composer;
        SendState state = visibleSendState(screen);
        sendAllowed = state == SendState.READY;
        setDraft(composer.draft);
        updateSendEnabled();
        send.setOnClickListener(clicked -> {
            if (send.isEnabled()) actions.sendText(draft.getText().toString());
        });
        ((TextView) root.findViewById(R.id.send_status)).setText(UiText.sendStatus(state));
        bindFeedback(state == SendState.DELIVERY_UNKNOWN ? Feedback.DELIVERY_UNKNOWN : composer.feedback);
        Button resolve = root.findViewById(R.id.resolve_unknown);
        resolve.setVisibility(state == SendState.DELIVERY_UNKNOWN ? View.VISIBLE : View.GONE);
        resolve.setOnClickListener(clicked -> actions.resolveUnknown());
        TextView target = root.findViewById(R.id.unknown_target);
        target.setVisibility(composer.review == null ? View.GONE : View.VISIBLE);
        if (composer.review != null) target.setText(root.getContext().getString(
            R.string.unknown_target, composer.review.pcId, composer.review.sessionId, composer.review.submissionId));
    }

    private SendState visibleSendState(Screen screen) {
        if (screen.composer.feedback == Feedback.DELIVERY_UNKNOWN) return SendState.DELIVERY_UNKNOWN;
        if (screen.composer.state != SendState.READY) return screen.composer.state;
        if (screen.conversation.session == null) return SendState.NO_SELECTION;
        if (screen.pc == null || screen.pc.connection != Connection.ONLINE) return SendState.OFFLINE;
        switch (screen.conversation.session.status) {
            case IDLE: case BUSY: return SendState.READY;
            case CLOSED: return SendState.CLOSED;
        }
        throw new AssertionError(screen.conversation.session.status);
    }

    private void bindFeedback(Feedback feedback) {
        TextView notice = root.findViewById(R.id.feedback);
        int message = UiText.feedback(feedback);
        notice.setVisibility(message == 0 ? View.GONE : View.VISIBLE);
        if (message != 0) notice.setText(message);
    }

    private TextWatcher watchDraft() {
        return new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable text) {
                updateSendEnabled();
                if (!binding && actions != null) actions.draftChanged(text.toString());
            }
        };
    }

    private void setDraft(String text) {
        if (draft.getText().toString().equals(text)) return;
        binding = true;
        try {
            draft.setText(text);
            draft.setSelection(text.length());
        } finally {
            binding = false;
        }
    }

    private void updateSendEnabled() {
        send.setEnabled(sendAllowed && !draft.getText().toString().trim().isEmpty());
    }

    private void requireOpen() {
        if (actions == null) throw new IllegalStateException("View is closed");
    }

    /** Releases callbacks and row snapshots. Call before Activity teardown or replacing this view. */
    @Override public void close() {
        if (actions == null) return;
        actions = null;
        sendAllowed = false;
        draft.removeTextChangedListener(draftWatcher);
        draft.setText("");
        send.setEnabled(false);
        send.setOnClickListener(null);
        root.findViewById(R.id.pair_pc).setOnClickListener(null);
        root.findViewById(R.id.forget_pc).setOnClickListener(null);
        root.findViewById(R.id.refresh).setOnClickListener(null);
        root.findViewById(R.id.resolve_unknown).setOnClickListener(null);
        root.findViewById(R.id.load_sessions).setOnClickListener(null);
        root.findViewById(R.id.load_history).setOnClickListener(null);
        sessions.setOnItemClickListener(null);
        sessions.setAdapter(null);
        transcript.setAdapter(null);
        sessionRows.clear();
        textRows.clear();
        insets.close();
    }
}
