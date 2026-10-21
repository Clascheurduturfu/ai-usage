package io.github.clascheurduturfu.aiusage.companion;

import java.util.Locale;

/**
 * The fixed list of widget metrics (config dropdown) and the logic that
 * resolves a metric key against a snapshot into displayable strings.
 */
public final class Metrics {

    public static final String CHATGPT_WEEKLY = "chatgpt.weekly";
    public static final String CHATGPT_5H = "chatgpt.5h";
    public static final String AG_GEMINI_WEEKLY = "antigravity.gemini.weekly";
    public static final String AG_GEMINI_5H = "antigravity.gemini.5h";
    public static final String AG_CLAUDE_WEEKLY = "antigravity.claude.weekly";
    public static final String AG_CLAUDE_5H = "antigravity.claude.5h";
    public static final String OPENROUTER = "openrouter.allowance";

    public static final String DEFAULT_KEY = CHATGPT_WEEKLY;

    public static final String[] KEYS = {
            CHATGPT_WEEKLY, CHATGPT_5H,
            AG_GEMINI_WEEKLY, AG_GEMINI_5H,
            AG_CLAUDE_WEEKLY, AG_CLAUDE_5H,
            OPENROUTER
    };

    public static final String[] LABELS = {
            "ChatGPT Weekly", "ChatGPT 5-hour",
            "Antigravity Gemini Weekly", "Antigravity Gemini 5-hour",
            "Antigravity Claude+GPT Weekly", "Antigravity Claude+GPT 5-hour",
            "OpenRouter Allowance"
    };

    private Metrics() {
    }

    public static int indexOfKey(String key) {
        if (key == null) return -1;
        for (int i = 0; i < KEYS.length; i++) {
            if (KEYS[i].equals(key)) return i;
        }
        return -1;
    }

    public static String labelOf(String key) {
        int i = indexOfKey(key);
        return i >= 0 ? LABELS[i] : key;
    }

    /** Resolved content for one widget metric. */
    public static final class MetricValue {
        public final String title;
        public String big;
        public String sub;
        public String updated;
        /** Percentage remaining 0-100, or -1 when unknown. */
        public double pct = -1;

        public MetricValue(String title) {
            this.title = title;
        }
    }

    public static MetricValue resolve(String key, Model.Snapshot snapshot, long fetchedAtMs, String lastError) {
        MetricValue mv = new MetricValue(labelOf(key));
        long now = System.currentTimeMillis();
        long dataTime = snapshot != null && snapshot.updatedAt > 0 ? snapshot.updatedAt : fetchedAtMs;
        boolean failed = lastError != null && !lastError.isEmpty();
        mv.updated = failed
                ? "refresh failed"
                : (dataTime > 0 ? "updated " + Fmt.relative(dataTime, now) : "never updated");

        if (snapshot == null || snapshot.cards.isEmpty()) {
            mv.big = "\u2014";
            mv.sub = failed ? lastError : "no data yet";
            return mv;
        }

        if (OPENROUTER.equals(key)) {
            resolveOpenRouter(mv, snapshot);
        } else if (key.startsWith("chatgpt.")) {
            Model.Card card = snapshot.findCard("chatgpt");
            resolveWindow(mv, card != null ? card.findWindow(windowIdOf(key)) : null, now);
        } else if (key.startsWith("antigravity.")) {
            Model.Card card = snapshot.findCard("antigravity");
            Model.Group group = findGroup(card, key.contains("gemini"));
            resolveWindow(mv, group != null ? group.findWindow(windowIdOf(key)) : null, now);
        } else {
            mv.big = "\u2014";
            mv.sub = "unknown metric";
        }
        return mv;
    }

    private static String windowIdOf(String key) {
        return key.endsWith("weekly") ? "weekly" : "5h";
    }

    private static void resolveWindow(MetricValue mv, Model.UsageWindow w, long now) {
        if (w == null) {
            mv.big = "\u2014";
            mv.sub = "waiting for data";
            return;
        }
        mv.big = Fmt.pct(w.leftPct) + " left";
        String reset = Fmt.resetsIn(w.resetAtMs, now);
        mv.sub = reset != null ? reset : "";
        mv.pct = clampPct(w.leftPct);
    }

    private static void resolveOpenRouter(MetricValue mv, Model.Snapshot s) {
        Model.Card c = s.findCard("openrouter");
        if (c == null || Double.isNaN(c.leftUsd)) {
            mv.big = "\u2014";
            mv.sub = "waiting for data";
            return;
        }
        mv.big = Fmt.usd(c.leftUsd) + " left";
        StringBuilder sub = new StringBuilder();
        if (!Double.isNaN(c.allowanceUsd)) sub.append("of ").append(Fmt.usd(c.allowanceUsd));
        if (!Double.isNaN(c.byokTodayUsd)) {
            if (sub.length() > 0) sub.append(" \u00b7 ");
            sub.append("today ").append(Fmt.usd(c.byokTodayUsd));
        }
        mv.sub = sub.length() > 0 ? sub.toString() : Fmt.pct(c.leftPct) + " left";
        mv.pct = clampPct(c.leftPct);
    }

    /**
     * Gemini metrics match the group whose name contains "gemini",
     * Claude+GPT metrics match "claude" (or "gpt"), falling back to position 0 / 1.
     */
    private static Model.Group findGroup(Model.Card card, boolean gemini) {
        if (card == null || card.groups.isEmpty()) return null;
        String want = gemini ? "gemini" : "claude";
        for (Model.Group g : card.groups) {
            if (g.name != null && g.name.toLowerCase(Locale.ROOT).contains(want)) return g;
        }
        if (!gemini) {
            for (Model.Group g : card.groups) {
                if (g.name != null && g.name.toLowerCase(Locale.ROOT).contains("gpt")) return g;
            }
        }
        int idx = gemini || card.groups.size() == 1 ? 0 : 1;
        return card.groups.get(idx);
    }

    private static double clampPct(double v) {
        if (Double.isNaN(v)) return -1;
        return Math.max(0, Math.min(100, v));
    }
}
