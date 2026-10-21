package io.github.clascheurduturfu.aiusage.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-arms the periodic sync and refreshes widget views after a reboot or an
 * app update. WorkManager normally persists on its own; this is belt and
 * braces, and it also re-renders widgets from the cache right after boot.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            SyncScheduler.schedule(context);
            AiUsageWidget.updateAllWidgets(context);
        }
    }
}
