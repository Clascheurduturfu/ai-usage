package io.github.clascheurduturfu.aiusage.companion;

import java.util.ArrayList;

/**
 * Parsed snapshot model (ntfy contract v1).
 * Numeric fields default to NaN / 0 when absent from the JSON.
 */
public final class Model {

    private Model() {
    }

    public static final class Snapshot {
        public long updatedAt;
        public String appVersion;
        /** Raw JSON string this snapshot was parsed from (used for the cache). */
        public String raw;
        public final ArrayList<Card> cards = new ArrayList<>();

        public Card findCard(String id) {
            for (Card c : cards) {
                if (id.equalsIgnoreCase(c.id)) return c;
            }
            return null;
        }
    }

    public static final class Card {
        public String id = "";
        public String title = "";
        public String plan;
        public String email;
        public double creditsAvailable = Double.NaN;
        public double creditsEarned = Double.NaN;
        public double allowanceUsd = Double.NaN;
        public double leftUsd = Double.NaN;
        public double leftPct = Double.NaN;
        public double byokMonthUsd = Double.NaN;
        public double byokTodayUsd = Double.NaN;
        public final ArrayList<UsageWindow> windows = new ArrayList<>();
        public final ArrayList<Group> groups = new ArrayList<>();

        public UsageWindow findWindow(String windowId) {
            for (UsageWindow w : windows) {
                if (windowId.equalsIgnoreCase(w.id)) return w;
            }
            return null;
        }
    }

    public static final class Group {
        public String name = "";
        public final ArrayList<UsageWindow> windows = new ArrayList<>();

        public UsageWindow findWindow(String windowId) {
            for (UsageWindow w : windows) {
                if (windowId.equalsIgnoreCase(w.id)) return w;
            }
            return null;
        }
    }

    public static final class UsageWindow {
        public String id = "";
        public String label = "";
        /** Percentage REMAINING (0-100). */
        public double leftPct = Double.NaN;
        /** Epoch ms of the window reset; 0 = unknown. */
        public long resetAtMs;
    }
}
