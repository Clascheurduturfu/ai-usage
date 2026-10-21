package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Per-widget-instance configuration, keyed by appWidgetId so multiple
 * widgets on the home screen can each show a different metric.
 */
public final class WidgetPrefs {

    private static final String PREFS = "widget_configs";

    private WidgetPrefs() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String key(int appWidgetId) {
        return "w_" + appWidgetId + "_metric";
    }

    public static String getMetric(Context c, int appWidgetId) {
        return prefs(c).getString(key(appWidgetId), Metrics.DEFAULT_KEY);
    }

    public static void setMetric(Context c, int appWidgetId, String metricKey) {
        prefs(c).edit().putString(key(appWidgetId), metricKey).apply();
    }

    /** Called when a widget instance is deleted so its config entry does not leak. */
    public static void remove(Context c, int appWidgetId) {
        prefs(c).edit().remove(key(appWidgetId)).apply();
    }
}
