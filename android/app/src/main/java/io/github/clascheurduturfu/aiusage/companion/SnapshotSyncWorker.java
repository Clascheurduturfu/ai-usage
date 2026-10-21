package io.github.clascheurduturfu.aiusage.companion;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Periodic background sync. On failure the last good snapshot stays cached;
 * the worker retries a few times before giving up until the next period.
 */
public class SnapshotSyncWorker extends Worker {

    public SnapshotSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String error = SyncEngine.trySync(getApplicationContext());
        if (error == null) return Result.success();
        return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
    }
}
