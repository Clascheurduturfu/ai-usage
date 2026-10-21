package io.github.clascheurduturfu.aiusage.companion;

import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;

/**
 * Settings: ntfy server URL, topic, optional token, refresh interval,
 * plus a "Refresh now" button. Persisted in SharedPreferences.
 */
public class SettingsActivity extends AppCompatActivity {

    private static final int[] INTERVAL_MINUTES = {30, 60, 120, 360, 0};
    private static final int[] INTERVAL_LABELS = {
            R.string.interval_30min, R.string.interval_1h, R.string.interval_2h,
            R.string.interval_6h, R.string.interval_off
    };

    private EditText etServer;
    private EditText etTopic;
    private EditText etToken;
    private Spinner spInterval;
    private TextView tvSyncStatus;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle(R.string.settings_title);
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }
        toolbar.setNavigationOnClickListener(v -> finish());

        etServer = findViewById(R.id.etServer);
        etTopic = findViewById(R.id.etTopic);
        etToken = findViewById(R.id.etToken);
        spInterval = findViewById(R.id.spInterval);
        tvSyncStatus = findViewById(R.id.tvSyncStatus);

        etServer.setText(SettingsPrefs.server(this));
        etTopic.setText(SettingsPrefs.topic(this));
        etToken.setText(SettingsPrefs.token(this));

        String[] labels = new String[INTERVAL_LABELS.length];
        for (int i = 0; i < labels.length; i++) {
            labels[i] = getString(INTERVAL_LABELS[i]);
        }
        ArrayAdapter<String> adapter =
                new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spInterval.setAdapter(adapter);
        spInterval.setSelection(indexForMinutes(SettingsPrefs.intervalMinutes(this)));

        Button btnSave = findViewById(R.id.btnSave);
        Button btnRefreshNow = findViewById(R.id.btnRefreshNow);
        btnSave.setOnClickListener(v -> save(false));
        btnRefreshNow.setOnClickListener(v -> refreshNow());
    }

    private int indexForMinutes(int minutes) {
        for (int i = 0; i < INTERVAL_MINUTES.length; i++) {
            if (INTERVAL_MINUTES[i] == minutes) return i;
        }
        return 2; // default: every 2 hours
    }

    private void save(boolean quiet) {
        int minutes = INTERVAL_MINUTES[Math.max(0, spInterval.getSelectedItemPosition())];
        SettingsPrefs.save(this,
                etServer.getText().toString(),
                etTopic.getText().toString(),
                etToken.getText().toString(),
                minutes);
        SyncScheduler.schedule(this);
        if (!quiet) {
            Toast.makeText(this, R.string.saved_settings, Toast.LENGTH_SHORT).show();
            tvSyncStatus.setText(R.string.saved_settings);
        }
    }

    private void refreshNow() {
        save(true); // sync with what is on screen
        if (SettingsPrefs.topic(this).trim().isEmpty()) {
            tvSyncStatus.setText(R.string.error_topic_missing);
            return;
        }
        tvSyncStatus.setText(R.string.refreshing);
        SyncEngine.requestSync(this, (snapshot, error) -> {
            if (isFinishing() || isDestroyed()) return;
            tvSyncStatus.setText(error != null
                    ? getString(R.string.refresh_failed_fmt, error)
                    : getString(R.string.updated_just_now));
        });
    }
}
