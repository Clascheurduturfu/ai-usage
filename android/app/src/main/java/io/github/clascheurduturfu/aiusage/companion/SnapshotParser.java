package io.github.clascheurduturfu.aiusage.companion;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Parses the AI Usage snapshot JSON contract (v1) published to the ntfy topic.
 * Tolerant of missing fields: absent numbers stay NaN, absent strings stay null.
 */
public final class SnapshotParser {

    private SnapshotParser() {
    }

    /** @throws JSONException if the payload is not a valid v1 snapshot. */
    public static Model.Snapshot parse(String raw) throws JSONException {
        if (raw == null) throw new JSONException("null snapshot payload");
        JSONObject o = new JSONObject(raw);
        int version = o.optInt("v", -1);
        if (version != 1) {
            throw new JSONException("Unsupported snapshot version: " + version);
        }
        Model.Snapshot s = new Model.Snapshot();
        s.raw = raw;
        s.updatedAt = o.optLong("updatedAt", 0L);
        s.appVersion = o.optString("appVersion", null);

        JSONArray cards = o.optJSONArray("cards");
        if (cards != null) {
            for (int i = 0; i < cards.length(); i++) {
                JSONObject c = cards.optJSONObject(i);
                if (c == null) continue;
                s.cards.add(parseCard(c));
            }
        }
        return s;
    }

    private static Model.Card parseCard(JSONObject c) {
        Model.Card card = new Model.Card();
        card.id = c.optString("id", "");
        card.title = c.optString("title", card.id);
        String plan = c.optString("plan", null);
        card.plan = plan == null || plan.isEmpty() ? null : plan;
        String email = c.optString("email", null);
        card.email = email == null || email.isEmpty() ? null : email;

        JSONObject credits = c.optJSONObject("credits");
        if (credits != null) {
            card.creditsAvailable = credits.optDouble("available", Double.NaN);
            card.creditsEarned = credits.optDouble("earned", Double.NaN);
        }

        card.allowanceUsd = c.optDouble("allowanceUsd", Double.NaN);
        card.leftUsd = c.optDouble("leftUsd", Double.NaN);
        card.leftPct = c.optDouble("leftPct", Double.NaN);
        card.byokMonthUsd = c.optDouble("byokMonthUsd", Double.NaN);
        card.byokTodayUsd = c.optDouble("byokTodayUsd", Double.NaN);

        JSONArray windows = c.optJSONArray("windows");
        if (windows != null) {
            for (int i = 0; i < windows.length(); i++) {
                JSONObject w = windows.optJSONObject(i);
                if (w == null) continue;
                card.windows.add(parseWindow(w));
            }
        }

        JSONArray groups = c.optJSONArray("groups");
        if (groups != null) {
            for (int i = 0; i < groups.length(); i++) {
                JSONObject g = groups.optJSONObject(i);
                if (g == null) continue;
                Model.Group group = new Model.Group();
                group.name = g.optString("name", "");
                JSONArray gw = g.optJSONArray("windows");
                if (gw != null) {
                    for (int j = 0; j < gw.length(); j++) {
                        JSONObject w = gw.optJSONObject(j);
                        if (w == null) continue;
                        group.windows.add(parseWindow(w));
                    }
                }
                card.groups.add(group);
            }
        }
        return card;
    }

    private static Model.UsageWindow parseWindow(JSONObject w) {
        Model.UsageWindow win = new Model.UsageWindow();
        win.id = w.optString("id", "");
        win.label = w.optString("label", win.id);
        win.leftPct = w.optDouble("leftPct", Double.NaN);
        win.resetAtMs = w.optLong("resetAtMs", 0L);
        return win;
    }
}
