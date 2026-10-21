package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;

/**
 * Cache of the last good snapshot (raw JSON) in SharedPreferences,
 * so the app and all widgets render instantly and refresh in the background.
 */
public final class SnapshotCache {

    private static final String PREFS = "snapshot_cache";
    private static final String KEY_JSON = "snapshot_json";
    private static final String KEY_FETCHED_AT = "fetched_at";
    private static final String KEY_LAST_ERROR = "last_error";

    private SnapshotCache() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void save(Context c, Model.Snapshot snapshot) {
        if (snapshot == null || snapshot.raw == null) return;
        prefs(c).edit()
                .putString(KEY_JSON, snapshot.raw)
                .putLong(KEY_FETCHED_AT, System.currentTimeMillis())
                .remove(KEY_LAST_ERROR)
                .apply();
    }

    /** @return the cached snapshot, or null if there is no valid cache. */
    public static Model.Snapshot load(Context c) {
        String raw = prefs(c).getString(KEY_JSON, null);
        if (raw == null) return null;
        try {
            return SnapshotParser.parse(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Local wall-clock time of the last successful fetch (0 = never). */
    public static long fetchedAt(Context c) {
        return prefs(c).getLong(KEY_FETCHED_AT, 0L);
    }

    public static void setLastError(Context c, String message) {
        prefs(c).edit().putString(KEY_LAST_ERROR, message == null ? "" : message).apply();
    }

    /** "" when the last sync succeeded. */
    public static String lastError(Context c) {
        return prefs(c).getString(KEY_LAST_ERROR, "");
    }
}
