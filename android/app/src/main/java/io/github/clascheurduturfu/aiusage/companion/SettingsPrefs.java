package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * User settings, persisted in SharedPreferences.
 * Defaults: server https://ntfy.sh, empty topic/token, 2h refresh interval.
 */
public final class SettingsPrefs {

    private static final String PREFS = "settings";
    private static final String KEY_SERVER = "server";
    private static final String KEY_TOPIC = "topic";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_INTERVAL_MINUTES = "interval_minutes";

    public static final int DEFAULT_INTERVAL_MINUTES = 120;

    private SettingsPrefs() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String server(Context c) {
        return prefs(c).getString(KEY_SERVER, "https://ntfy.sh");
    }

    public static String topic(Context c) {
        return prefs(c).getString(KEY_TOPIC, "");
    }

    public static String token(Context c) {
        return prefs(c).getString(KEY_TOKEN, "");
    }

    public static int intervalMinutes(Context c) {
        return prefs(c).getInt(KEY_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES);
    }

    public static void save(Context c, String server, String topic, String token, int intervalMinutes) {
        prefs(c).edit()
                .putString(KEY_SERVER, normalizeServer(server))
                .putString(KEY_TOPIC, topic == null ? "" : topic.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .putInt(KEY_INTERVAL_MINUTES, intervalMinutes)
                .apply();
    }

    /** Prepends https:// when the scheme is missing and strips trailing slashes. */
    private static String normalizeServer(String server) {
        String s = server == null ? "" : server.trim();
        if (s.isEmpty()) return s;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }
}
