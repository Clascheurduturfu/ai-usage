package io.github.clascheurduturfu.aiusage.companion;

import android.content.Intent;
import android.content.res.ColorStateList;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.content.ContextCompat;

/**
 * Dashboard: renders the cards of the latest snapshot from the cache
 * instantly, then refreshes from ntfy in the background. Keeps showing the
 * last good data when a fetch fails.
 */
public class MainActivity extends AppCompatActivity {

    private LinearLayout cardContainer;
    private ScrollView scrollContent;
    private TextView tvLastUpdated;
    private TextView tvError;
    private TextView tvEmptyTitle;
    private TextView tvEmptyMsg;
    private Button btnEmptyAction;
    private View emptyState;
    private boolean refreshing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setTitle(R.string.app_name);
        }

        scrollContent = findViewById(R.id.scrollContent);
        cardContainer = findViewById(R.id.cardContainer);
        tvLastUpdated = findViewById(R.id.tvLastUpdated);
        tvError = findViewById(R.id.tvError);
        emptyState = findViewById(R.id.emptyState);
        tvEmptyTitle = findViewById(R.id.tvEmptyTitle);
        tvEmptyMsg = findViewById(R.id.tvEmptyMsg);
        btnEmptyAction = findViewById(R.id.btnEmptyAction);
        btnEmptyAction.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));

        render(SnapshotCache.load(this));
        SyncScheduler.schedule(this);
        refresh();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.menu_main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_refresh) {
            refresh();
            return true;
        }
        if (id == R.id.action_settings) {
            startActivity(new Intent(this, SettingsActivity.class));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void refresh() {
        if (refreshing) return;
        if (SettingsPrefs.topic(this).trim().isEmpty()) {
            if (SnapshotCache.load(this) == null) {
                render(null);
            }
            return;
        }
        refreshing = true;
        tvLastUpdated.setText(R.string.refreshing);
        SyncEngine.requestSync(this, (snapshot, error) -> {
            if (isFinishing() || isDestroyed()) return;
            refreshing = false;
            render(snapshot); // on error, snapshot is the kept cache
            if (error != null) {
                tvError.setVisibility(View.VISIBLE);
                tvError.setText(getString(R.string.refresh_failed_fmt, error));
            } else {
                tvError.setVisibility(View.GONE);
            }
        });
    }

    private void render(@Nullable Model.Snapshot s) {
        tvError.setVisibility(View.GONE);
        boolean empty = s == null || s.cards.isEmpty();
        scrollContent.setVisibility(empty ? View.GONE : View.VISIBLE);
        emptyState.setVisibility(empty ? View.VISIBLE : View.GONE);
        if (empty) {
            boolean configured = !SettingsPrefs.topic(this).trim().isEmpty();
            tvEmptyTitle.setText(configured
                    ? R.string.empty_no_data_title : R.string.empty_not_configured_title);
            tvEmptyMsg.setText(configured
                    ? R.string.empty_no_data_msg : R.string.empty_not_configured_msg);
            btnEmptyAction.setVisibility(configured ? View.GONE : View.VISIBLE);
            tvLastUpdated.setText(R.string.last_updated_never);
            cardContainer.removeAllViews();
            return;
        }
        cardContainer.removeAllViews();
        long now = System.currentTimeMillis();
        long dataTime = s.updatedAt > 0 ? s.updatedAt : SnapshotCache.fetchedAt(this);
        tvLastUpdated.setText(getString(R.string.last_updated_fmt, Fmt.relative(dataTime, now)));
        for (Model.Card card : s.cards) {
            addCard(card, now);
        }
    }

    private void addCard(Model.Card card, long now) {
        View cardView = getLayoutInflater().inflate(R.layout.item_card, cardContainer, false);
        TextView title = cardView.findViewById(R.id.tvCardTitle);
        TextView subtitle = cardView.findViewById(R.id.tvCardSubtitle);
        LinearLayout body = cardView.findViewById(R.id.cardBody);

        title.setText(TextUtils.isEmpty(card.title) ? card.id : card.title);
        String sub = TextUtils.isEmpty(card.plan) ? "" : card.plan;
        if (!TextUtils.isEmpty(card.email)) {
            sub = sub.isEmpty() ? card.email : sub + " \u00b7 " + card.email;
        }
        subtitle.setText(sub);
        subtitle.setVisibility(sub.isEmpty() ? View.GONE : View.VISIBLE);

        if (!Double.isNaN(card.leftUsd) || !Double.isNaN(card.allowanceUsd)) {
            addWindowLine(body, openRouterLine(card), card.leftPct);
            if (!Double.isNaN(card.byokMonthUsd)) {
                addInfoLine(body, getString(R.string.byok_month_fmt, Fmt.usd(card.byokMonthUsd)));
            }
        }
        for (Model.UsageWindow w : card.windows) {
            addWindowLine(body, windowLine(w, now), w.leftPct);
        }
        if (!Double.isNaN(card.creditsAvailable) || !Double.isNaN(card.creditsEarned)) {
            addInfoLine(body, getString(R.string.credits_fmt,
                    Fmt.num(card.creditsAvailable), Fmt.num(card.creditsEarned)));
        }
        for (Model.Group group : card.groups) {
            addGroupHeader(body, group.name);
            for (Model.UsageWindow w : group.windows) {
                addWindowLine(body, windowLine(w, now), w.leftPct);
            }
        }
        cardContainer.addView(cardView);
    }

    /** "Weekly: 93% left \u00b7 resets in 6d 8h" (or "resetting\u2026"). */
    private String windowLine(Model.UsageWindow w, long now) {
        String label = TextUtils.isEmpty(w.label) ? w.id : w.label;
        StringBuilder sb = new StringBuilder(label)
                .append(": ")
                .append(Fmt.pct(w.leftPct))
                .append(" left");
        String reset = Fmt.resetsIn(w.resetAtMs, now);
        if (reset != null) sb.append(" \u00b7 ").append(reset);
        return sb.toString();
    }

    /** "$226.90 left of $300.00 \u00b7 75% left \u00b7 today $21.15". */
    private String openRouterLine(Model.Card card) {
        StringBuilder sb = new StringBuilder();
        if (!Double.isNaN(card.leftUsd)) sb.append(Fmt.usd(card.leftUsd)).append(" left");
        if (!Double.isNaN(card.allowanceUsd)) {
            if (sb.length() > 0) sb.append(" ");
            sb.append("of ").append(Fmt.usd(card.allowanceUsd));
        }
        if (!Double.isNaN(card.leftPct)) {
            if (sb.length() > 0) sb.append(" \u00b7 ");
            sb.append(Fmt.pct(card.leftPct)).append(" left");
        }
        if (!Double.isNaN(card.byokTodayUsd)) {
            if (sb.length() > 0) sb.append(" \u00b7 ");
            sb.append("today ").append(Fmt.usd(card.byokTodayUsd));
        }
        return sb.toString();
    }

    private void addWindowLine(LinearLayout container, String text, double pct) {
        View line = getLayoutInflater().inflate(R.layout.item_window_line, container, false);
        ((TextView) line.findViewById(R.id.tvLine)).setText(text);
        ProgressBar pb = line.findViewById(R.id.pbLine);
        if (Double.isNaN(pct)) {
            pb.setVisibility(View.GONE);
        } else {
            int p = (int) Math.round(Math.max(0, Math.min(100, pct)));
            pb.setProgress(p);
            pb.setProgressTintList(ColorStateList.valueOf(ContextCompat.getColor(this,
                    p >= 40 ? R.color.green : (p >= 15 ? R.color.amber : R.color.red))));
        }
        container.addView(line);
    }

    private void addInfoLine(LinearLayout container, String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(13f);
        tv.setTextColor(ContextCompat.getColor(this, R.color.textSecondary));
        container.addView(tv);
    }

    private void addGroupHeader(LinearLayout container, String name) {
        View header = getLayoutInflater().inflate(R.layout.item_group_header, container, false);
        ((TextView) header.findViewById(R.id.tvGroupHeader))
                .setText(TextUtils.isEmpty(name) ? getString(R.string.default_group_name) : name);
        container.addView(header);
    }
}
