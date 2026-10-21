package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Central place for one-shot snapshot syncs. All HTTP work runs on a single
 * shared background thread; UI callers get the callback on the main thread.
 */
public final class SyncEngine {

    /** Single shared background thread for all manual/one-shot syncs. */
    public static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "ai-usage-sync");
        t.setDaemon(true);
        return t;
    });

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    public interface Callback {
        /**
         * @param snapshot the current cached snapshot after the attempt (null if none).
         * @param error    null on success, otherwise a user-readable message.
         */
        void onResult(Model.Snapshot snapshot, String error);
    }

    private SyncEngine() {
    }

    /** Blocking sync: fetch, cache, refresh all widgets. Background thread only. */
    public static Model.Snapshot syncBlocking(Context c) throws IOException {
        Context app = c.getApplicationContext();
        Model.Snapshot s = NtfyFetcher.fetch(app);
        SnapshotCache.save(app, s);
        AiUsageWidget.updateAllWidgets(app);
        AiUsageTrioWidget.updateAllWidgets(app);
        return s;
    }

    /** @return null on success, otherwise a user-readable error message. */
    public static String trySync(Context c) {
        try {
            syncBlocking(c);
            return null;
        } catch (Exception e) {
            String msg = e.getMessage();
            if (msg == null || msg.isEmpty()) msg = e.getClass().getSimpleName();
            SnapshotCache.setLastError(c.getApplicationContext(), msg);
            return msg;
        }
    }

    /** Async sync for UI callers; the callback always runs on the main thread. */
    public static void requestSync(Context c, Callback cb) {
        Context app = c.getApplicationContext();
        EXECUTOR.execute(() -> {
            String error = trySync(app);
            Model.Snapshot snapshot = SnapshotCache.load(app);
            if (cb != null) {
                final Model.Snapshot s = snapshot;
                final String e = error;
                MAIN.post(() -> cb.onResult(s, e));
            }
        });
    }
}
