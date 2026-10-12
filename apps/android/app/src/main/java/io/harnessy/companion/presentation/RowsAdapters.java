package io.harnessy.companion.presentation;

import android.content.Context;
import android.graphics.Typeface;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.TextView;

import java.util.Collections;
import java.util.List;

import io.harnessy.companion.R;

import static io.harnessy.companion.presentation.DisplayModels.*;

final class RowsAdapters {
    private RowsAdapters() {}

    static final class Sessions extends BaseAdapter {
        private List<SessionRow> rows = Collections.emptyList();
        private String selectedId;

        void bind(SessionPane pane) {
            rows = pane.rows;
            selectedId = pane.selectedId;
            notifyDataSetChanged();
        }

        void clear() {
            rows = Collections.emptyList();
            selectedId = null;
            notifyDataSetChanged();
        }

        @Override public int getCount() { return rows.size(); }
        @Override public SessionRow getItem(int position) { return rows.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override public View getView(int position, View recycled, ViewGroup parent) {
            View row = recycled == null
                ? LayoutInflater.from(parent.getContext()).inflate(R.layout.session_row, parent, false)
                : recycled;
            bindRow(row, getItem(position), parent.getContext());
            return row;
        }

        private void bindRow(View row, SessionRow session, Context context) {
            String status = context.getString(UiText.sessionStatus(session.status));
            ((TextView) row.findViewById(R.id.row_title)).setText(session.title);
            ((TextView) row.findViewById(R.id.row_status)).setText(status);
            boolean selected = session.id.equals(selectedId);
            row.setSelected(selected);
            row.setBackgroundColor(context.getColor(selected ? R.color.harnessy_selected : R.color.harnessy_layer));
            row.setContentDescription(context.getString(selected
                ? R.string.selected_session_row : R.string.session_row, session.title, status));
        }
    }

    static final class Transcript extends BaseAdapter {
        private List<TextRow> rows = Collections.emptyList();

        void bind(List<TextRow> approvedRows) {
            rows = approvedRows;
            notifyDataSetChanged();
        }

        void clear() {
            rows = Collections.emptyList();
            notifyDataSetChanged();
        }

        @Override public int getCount() { return rows.size(); }
        @Override public TextRow getItem(int position) { return rows.get(position); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean isEnabled(int position) { return false; }
        @Override public boolean areAllItemsEnabled() { return false; }

        @Override public View getView(int position, View recycled, ViewGroup parent) {
            View row = recycled == null
                ? LayoutInflater.from(parent.getContext()).inflate(R.layout.transcript_row, parent, false)
                : recycled;
            TextRow approved = getItem(position);
            Context context = parent.getContext();
            ((TextView) row.findViewById(R.id.row_role)).setText(UiText.role(approved.role));
            TextView body = row.findViewById(R.id.row_text);
            body.setText(approved.text);
            body.setTypeface(approved.role == Role.TOOL ? Typeface.MONOSPACE : Typeface.DEFAULT);
            row.setBackgroundColor(context.getColor(approved.role == Role.USER
                ? R.color.harnessy_selected : R.color.harnessy_surface));
            return row;
        }
    }
}
