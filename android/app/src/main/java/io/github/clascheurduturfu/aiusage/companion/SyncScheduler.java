package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Battery-friendly periodic sync via WorkManager: one small HTTP call per
 * interval (default every 2 hours, configurable in Settings; 0 = off).
 */
public final class SyncScheduler {

    private static final String WORK_NAME = "ai-usage-periodic-sync";

    private SyncScheduler() {
    }

    public static void schedule(Context c) {
        Context app = c.getApplicationContext();
        int minutes = SettingsPrefs.intervalMinutes(app);
        WorkManager wm = WorkManager.getInstance(app);
        if (minutes <= 0) {
            wm.cancelUniqueWork(WORK_NAME);
            return;
        }
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                SnapshotSyncWorker.class, minutes, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build())
                .build();
        wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request);
    }
}
