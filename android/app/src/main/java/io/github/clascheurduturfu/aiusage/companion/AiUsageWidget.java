package io.github.clascheurduturfu.aiusage.companion;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * Classic RemoteViews home-screen widget (dark, green progress bar).
 * Each widget instance has its own metric config (keyed by appWidgetId).
 * The refresh button triggers a one-shot fetch and an update of all instances.
 */
public class AiUsageWidget extends AppWidgetProvider {

    public static final String ACTION_REFRESH = "io.github.clascheurduturfu.aiusage.companion.ACTION_WIDGET_REFRESH";
    public static final String EXTRA_APPWIDGET_ID = "appWidgetId";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            render(context, manager, appWidgetId);
        }
        // Fresh-ish data soon after placement/resize, without blocking onUpdate.
        SyncEngine.requestSync(context, null);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            WidgetPrefs.remove(context, appWidgetId);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) {
            // Network is not allowed on the main thread; keep the receiver
            // alive while a background thread does one small HTTP call.
            final PendingResult pending = goAsync();
            final Context app = context.getApplicationContext();
            SyncEngine.EXECUTOR.execute(() -> {
                try {
                    SyncEngine.trySync(app); // updates widgets on success
                } finally {
                    try {
                        updateAllWidgets(app); // also shows the error state on failure
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
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, AiUsageWidget.class));
        for (int id : ids) {
            render(context, manager, id);
        }
    }

    /** Builds the RemoteViews for one instance and pushes them to the launcher. */
    public static void render(Context context, AppWidgetManager manager, int appWidgetId) {
        String metricKey = WidgetPrefs.getMetric(context, appWidgetId);
        Model.Snapshot snapshot = SnapshotCache.load(context);
        Metrics.MetricValue mv = Metrics.resolve(
                metricKey, snapshot, SnapshotCache.fetchedAt(context), SnapshotCache.lastError(context));

        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_ai_usage);
        rv.setTextViewText(R.id.w_title, mv.title);
        rv.setTextViewText(R.id.w_value, mv.big);
        rv.setTextViewText(R.id.w_sub, mv.sub);
        rv.setTextViewText(R.id.w_updated, mv.updated);
        int progress = mv.pct >= 0 ? (int) Math.round(mv.pct) : 0;
        rv.setProgressBar(R.id.w_progress, 100, progress, false);

        // Refresh button: explicit-component broadcast to this provider.
        Intent refresh = new Intent(context, AiUsageWidget.class)
                .setAction(ACTION_REFRESH)
                .putExtra(EXTRA_APPWIDGET_ID, appWidgetId);
        rv.setOnClickPendingIntent(R.id.w_btn_refresh,
                PendingIntent.getBroadcast(context, appWidgetId, refresh,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        // Tapping the widget body opens the dashboard.
        Intent open = new Intent(context, MainActivity.class);
        rv.setOnClickPendingIntent(R.id.w_root,
                PendingIntent.getActivity(context, 0, open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        manager.updateAppWidget(appWidgetId, rv);
    }
}
