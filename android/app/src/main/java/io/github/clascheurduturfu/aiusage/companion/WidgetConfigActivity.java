package io.github.clascheurduturfu.aiusage.companion;

import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.Spinner;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;

/**
 * Launched by the launcher when a widget is placed: the user picks which
 * metric this widget instance shows. The choice is keyed by appWidgetId,
 * so multiple widgets can each show a different metric.
 */
public class WidgetConfigActivity extends AppCompatActivity {

    private Spinner spMetric;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_widget_config);
        // Default: cancel placement if the user backs out of this screen.
        setResult(RESULT_CANCELED);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle(R.string.widget_config_title);
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }
        toolbar.setNavigationOnClickListener(v -> finish());

        int appWidgetId = getIntent() != null
                ? getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                        AppWidgetManager.INVALID_APPWIDGET_ID)
                : AppWidgetManager.INVALID_APPWIDGET_ID;
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        spMetric = findViewById(R.id.spMetric);
        ArrayAdapter<String> adapter =
                new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, Metrics.LABELS);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spMetric.setAdapter(adapter);
        int selected = Metrics.indexOfKey(WidgetPrefs.getMetric(this, appWidgetId));
        spMetric.setSelection(selected >= 0 ? selected : 0);

        Button btnAdd = findViewById(R.id.btnAdd);
        Button btnCancel = findViewById(R.id.btnCancel);
        btnAdd.setOnClickListener(v -> confirm(appWidgetId));
        btnCancel.setOnClickListener(v -> finish());
    }

    private void confirm(int appWidgetId) {
        int pos = Math.max(0, spMetric.getSelectedItemPosition());
        String key = pos < Metrics.KEYS.length ? Metrics.KEYS[pos] : Metrics.DEFAULT_KEY;
        WidgetPrefs.setMetric(this, appWidgetId, key);

        // Render immediately from the cache...
        AiUsageWidget.render(this, AppWidgetManager.getInstance(this), appWidgetId);
        // ...and pull fresh data in the background so the widget fills in.
        SyncEngine.requestSync(this, null);

        Intent result = new Intent();
        result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        setResult(RESULT_OK, result);
        finish();
    }
}
