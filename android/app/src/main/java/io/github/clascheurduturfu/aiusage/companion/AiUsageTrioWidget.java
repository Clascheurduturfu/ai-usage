package io.github.clascheurduturfu.aiusage.companion;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * "AI Usage · 3 limits" widget: shows the three weekly limits (ChatGPT,
 * Antigravity Gemini, Antigravity Claude+GPT) in one 3x2 widget with per-row
 * remaining bars, plus the shared refresh button. No configuration needed.
 */
public class AiUsageTrioWidget extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "io.github.clascheurduturfu.aiusage.companion.ACTION_TRIO_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            render(context, manager, appWidgetId);
        }
        SyncEngine.requestSync(context, null);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) {
            final PendingResult pending = goAsync();
            final Context app = context.getApplicationContext();
            SyncEngine.EXECUTOR.execute(() -> {
                try {
                    SyncEngine.trySync(app); // updates all widgets on success
                } finally {
                    try {
                        updateAllWidgets(app);
                    } catch (Exception ignored) {
                        // never leave the receiver dangling
                    } finally {
                        pending.finish();
                    }
                }
            });
            return;
        }
        super.onReceive(context, intent);
    }

    /** Re-renders every placed instance of this widget from the cache. */
    public static void updateAllWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, AiUsageTrioWidget.class));
        for (int id : ids) {
            render(context, manager, id);
        }
    }

    /** One row of the trio. */
    private static final class Row {
        final int labelId;
        final int pctId;
        final int barId;

        Row(int labelId, int pctId, int barId) {
            this.labelId = labelId;
            this.pctId = pctId;
            this.barId = barId;
        }
    }

    private static final Row[] ROWS = {
            new Row(R.id.wt_label_1, R.id.wt_pct_1, R.id.wt_bar_1),
            new Row(R.id.wt_label_2, R.id.wt_pct_2, R.id.wt_bar_2),
            new Row(R.id.wt_label_3, R.id.wt_pct_3, R.id.wt_bar_3)
    };

    private static final String[] ROW_LABELS = {
            "ChatGPT weekly",
            "Gemini weekly",
            "Claude+GPT weekly"
    };

    /** Model hooks for the three weekly windows, in row order. */
    private static Model.UsageWindow windowFor(Model.Snapshot snapshot, int row) {
        if (snapshot == null) return null;
        if (row == 0) {
            Model.Card card = snapshot.findCard("chatgpt");
            return card != null ? card.findWindow("weekly") : null;
        }
        Model.Card card = snapshot.findCard("antigravity");
        if (card == null) return null;
        boolean gemini = row == 1;
        for (Model.Group g : card.groups) {
            boolean isGemini = g.name != null && g.name.toLowerCase().contains("gemini");
            if (isGemini == gemini) return g.findWindow("weekly");
        }
        return null;
    }

    public static void render(Context context, AppWidgetManager manager, int appWidgetId) {
        Model.Snapshot snapshot = SnapshotCache.load(context);
        long fetchedAt = SnapshotCache.fetchedAt(context);
        String lastError = SnapshotCache.lastError(context);

        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_trio);
        for (int i = 0; i < ROWS.length; i++) {
            Row row = ROWS[i];
            rv.setTextViewText(row.labelId, ROW_LABELS[i]);
            Model.UsageWindow w = windowFor(snapshot, i);
            String pctText;
            int progress;
            if (w != null && !Double.isNaN(w.leftPct)) {
                pctText = Fmt.pct(w.leftPct);
                progress = (int) Math.round(Math.max(0, Math.min(100, w.leftPct)));
            } else {
                pctText = "—";
                progress = 0;
            }
            rv.setTextViewText(row.pctId, pctText);
            rv.setProgressBar(row.barId, 100, progress, false);
        }

        long now = System.currentTimeMillis();
        long dataTime = snapshot != null && snapshot.updatedAt > 0 ? snapshot.updatedAt : fetchedAt;
        boolean failed = lastError != null && !lastError.isEmpty();
        String updated = failed
                ? "refresh failed"
                : (dataTime > 0 ? "updated " + Fmt.relative(dataTime, now) : "waiting for data");
        rv.setTextViewText(R.id.wt_updated, updated);

        // Refresh button: one small HTTP call, then every widget re-renders.
        Intent refresh = new Intent(context, AiUsageTrioWidget.class).setAction(ACTION_REFRESH);
        rv.setOnClickPendingIntent(
                R.id.wt_btn_refresh,
                PendingIntent.getBroadcast(
                        context, appWidgetId, refresh,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        // Tapping the widget body opens the dashboard.
        Intent open = new Intent(context, MainActivity.class);
        rv.setOnClickPendingIntent(
                R.id.wt_root,
                PendingIntent.getActivity(
                        context, 0, open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        manager.updateAppWidget(appWidgetId, rv);
    }
}
